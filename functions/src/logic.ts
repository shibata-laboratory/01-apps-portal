/**
 * アカウント削除・同意撤回の処理ロジック（統一規格 v0.1 第14章）。
 *
 * 管理用 Python スクリプト（admin/admin.py の process-deletions /
 * process-withdrawals）と同一の判定を行う。Firestore へのアクセスは
 * Store インターフェース越しに分離し、このモジュール自体は
 * firebase-admin に依存しない（単体テストで fake Store を差し込める）。
 *
 * 判定の要点（規格 14.2 / 14.3）:
 * - 撤回申請済み（withdrawal_requested）の同意は、対象実験のデータを削除する
 * - 同意中（agreed）でも撤回可能期間内なら、削除に伴う撤回としてデータを削除する
 * - 撤回可能期間を過ぎた同意のデータは、匿名化済みとして保持する
 * - 期間を判定できない同意がある場合は保守的に扱い、データも対応表も残す
 *   （blocking）。この場合の申請は linkRetained: true で処理済みにし、
 *   最終判断は管理用スクリプト／管理者に委ねる
 * - 対応表（identityLinks）・設定・コード登録の破棄は blocking でない場合のみ
 *
 * すべての操作は冪等であること。トリガーは at-least-once 配送のため、
 * 同じ申請・同意に対して再実行されても結果が変わらないようにする。
 */

export interface ConsentRecord {
  id: string;
  participantCode: string;
  experimentId: string;
  status: string;
  /** 同意日時。取得できない場合は null（期間判定は unknown になる） */
  agreedAt: Date | null;
}

export interface DeletionRequestData {
  uid: string;
  participantCode: string;
  status: string;
}

export interface ConsentDoc {
  withdrawalWindowDays?: unknown;
}

export type FetchConsentDoc = (experimentId: string) => Promise<ConsentDoc | null>;

export interface DeletionRequestPatch {
  status: 'processed';
  linkRetained?: boolean;
  note?: string;
}

export interface Store {
  getDeletionRequest(requestId: string): Promise<DeletionRequestData | null>;
  listConsentsByParticipant(participantCode: string): Promise<ConsentRecord[]>;
  /** 対象参加者・実験のセッション（配下の chunks を含む）を削除し、削除したセッション数を返す */
  deleteSessionsFor(participantCode: string, experimentId: string): Promise<number>;
  /** 同意を withdrawal_processed に更新する（processedAt は実装側でサーバー時刻を付ける） */
  markConsentProcessed(consentId: string): Promise<void>;
  /** identityLinks / userPreferences / participantCodes を破棄する */
  deleteIdentity(uid: string, participantCode: string): Promise<void>;
  /** Auth アカウントが残っていれば削除する。結果は 'deleted' | 'not-found' | 'error' */
  deleteAuthUser(uid: string): Promise<'deleted' | 'not-found' | 'error'>;
  updateDeletionRequest(requestId: string, patch: DeletionRequestPatch): Promise<void>;
}

export type WindowState = 'in' | 'past' | 'unknown';

/** 撤回可能期間の状態を判定する（admin.py の withdrawal_state と同一） */
export function withdrawalState(
  consent: Pick<ConsentRecord, 'agreedAt'>,
  consentDoc: ConsentDoc | null,
  now: Date,
): WindowState {
  const days = consentDoc?.withdrawalWindowDays;
  if (typeof days !== 'number' || !Number.isFinite(days)) return 'unknown';
  if (!(consent.agreedAt instanceof Date) || Number.isNaN(consent.agreedAt.getTime())) {
    return 'unknown';
  }
  const deadline = consent.agreedAt.getTime() + days * 24 * 60 * 60 * 1000;
  return deadline > now.getTime() ? 'in' : 'past';
}

export interface DeletionSummary {
  skipped: boolean;
  deletedSessions: number;
  processedConsents: number;
  retainedPastWindow: number;
  blocking: boolean;
  identityDeleted: boolean;
  authResult: 'deleted' | 'not-found' | 'error' | null;
}

/** 削除申請1件を処理する（admin.py の process-deletions の1件分と同一判定） */
export async function processDeletion(
  store: Store,
  fetchConsentDoc: FetchConsentDoc,
  requestId: string,
  now: Date = new Date(),
): Promise<DeletionSummary> {
  const summary: DeletionSummary = {
    skipped: false,
    deletedSessions: 0,
    processedConsents: 0,
    retainedPastWindow: 0,
    blocking: false,
    identityDeleted: false,
    authResult: null,
  };

  const req = await store.getDeletionRequest(requestId);
  if (!req || req.status !== 'requested') {
    // 既に処理済みの申請に対する再配送、または申請が消えている場合は何もしない
    summary.skipped = true;
    return summary;
  }
  const { uid, participantCode } = req;

  const consents = await store.listConsentsByParticipant(participantCode);
  for (const consent of consents) {
    if (consent.status === 'withdrawal_processed') continue;
    const doc = await fetchConsentDoc(consent.experimentId);
    const state = withdrawalState(consent, doc, now);
    if (
      consent.status === 'withdrawal_requested' ||
      (consent.status === 'agreed' && state === 'in')
    ) {
      summary.deletedSessions += await store.deleteSessionsFor(
        participantCode,
        consent.experimentId,
      );
      await store.markConsentProcessed(consent.id);
      summary.processedConsents += 1;
    } else if (consent.status === 'agreed' && state === 'past') {
      summary.retainedPastWindow += 1;
    } else {
      // agreed かつ期間を判定できない等: 保守的にデータも対応表も残す
      summary.blocking = true;
    }
  }

  if (summary.blocking) {
    await store.updateDeletionRequest(requestId, {
      status: 'processed',
      linkRetained: true,
      note: 'identity link retained: consent with unknown withdrawal window',
    });
    return summary;
  }

  await store.deleteIdentity(uid, participantCode);
  summary.identityDeleted = true;
  summary.authResult = await store.deleteAuthUser(uid);
  await store.updateDeletionRequest(requestId, { status: 'processed' });
  return summary;
}

export interface WithdrawalSummary {
  skipped: boolean;
  deletedSessions: number;
}

/** 同意撤回1件を処理する（admin.py の process-withdrawals の1件分と同一） */
export async function processWithdrawal(
  store: Store,
  consent: ConsentRecord,
): Promise<WithdrawalSummary> {
  if (consent.status !== 'withdrawal_requested') {
    return { skipped: true, deletedSessions: 0 };
  }
  const deletedSessions = await store.deleteSessionsFor(
    consent.participantCode,
    consent.experimentId,
  );
  await store.markConsentProcessed(consent.id);
  return { skipped: false, deletedSessions };
}
