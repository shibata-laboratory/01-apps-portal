/**
 * Cloud Functions エントリポイント（統一規格 第14章の即時処理）。
 *
 * トリガー:
 * - onDeletionRequestCreated: deletionRequests の新規作成で起動し、
 *   アカウント削除に伴う Firestore 側のデータ削除を即時に実行する
 * - onConsentWithdrawalRequested: consentRecords の status が
 *   withdrawal_requested に変わったときに起動し、撤回に伴うデータ削除を実行する
 *
 * いずれも判定ロジックは logic.ts に分離し、管理用 Python スクリプト
 * （admin/admin.py）と同一の規則で処理する。処理に失敗した申請は
 * status が 'requested' / 'withdrawal_requested' のまま残るため、
 * 管理用スクリプトの status / process-* で後から拾って再処理できる。
 *
 * 参加者クライアントには削除権限を与えない原則（規格 第8章・14.6）は
 * 変えない。削除はこの Function が Admin SDK の権限で実行する。
 */

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import {
  onDocumentCreated,
  onDocumentUpdated,
} from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import {
  processDeletion,
  processWithdrawal,
  type ConsentDoc,
  type ConsentRecord,
  type Store,
} from './logic';

initializeApp();
setGlobalOptions({ region: 'asia-northeast1', maxInstances: 10 });

const CONSENT_BASE =
  process.env.CONSENT_BASE ?? 'https://apps.shibata-lab.jp/consent';

async function fetchConsentDoc(experimentId: string): Promise<ConsentDoc | null> {
  try {
    const res = await fetch(`${CONSENT_BASE}/${experimentId}.json`);
    if (!res.ok) return null;
    return (await res.json()) as ConsentDoc;
  } catch (e) {
    logger.warn(`同意文書 ${experimentId} を取得できませんでした`, e);
    return null;
  }
}

function toConsentRecord(id: string, data: FirebaseFirestore.DocumentData): ConsentRecord {
  const agreedAtRaw = data.agreedAt;
  return {
    id,
    participantCode: data.participantCode,
    experimentId: data.experimentId,
    status: data.status,
    agreedAt:
      agreedAtRaw && typeof agreedAtRaw.toDate === 'function'
        ? agreedAtRaw.toDate()
        : null,
  };
}

function createStore(): Store {
  const db = getFirestore();
  return {
    async getDeletionRequest(requestId) {
      const snap = await db.collection('deletionRequests').doc(requestId).get();
      if (!snap.exists) return null;
      const d = snap.data()!;
      return { uid: d.uid, participantCode: d.participantCode, status: d.status };
    },

    async listConsentsByParticipant(participantCode) {
      const snap = await db
        .collection('consentRecords')
        .where('participantCode', '==', participantCode)
        .get();
      return snap.docs.map((doc) => toConsentRecord(doc.id, doc.data()));
    },

    async deleteSessionsFor(participantCode, experimentId) {
      const snap = await db
        .collection('sessions')
        .where('participantCode', '==', participantCode)
        .get();
      const targets = snap.docs.filter(
        (doc) => doc.data().experimentId === experimentId,
      );
      for (const doc of targets) {
        // recursiveDelete は配下の chunks サブコレクションも含めて削除する
        await db.recursiveDelete(doc.ref);
      }
      return targets.length;
    },

    async markConsentProcessed(consentId) {
      await db.collection('consentRecords').doc(consentId).update({
        status: 'withdrawal_processed',
        processedAt: FieldValue.serverTimestamp(),
      });
    },

    async deleteIdentity(uid, participantCode) {
      await db.collection('identityLinks').doc(uid).delete();
      await db.collection('userPreferences').doc(uid).delete();
      if (participantCode) {
        await db.collection('participantCodes').doc(participantCode).delete();
      }
    },

    async deleteAuthUser(uid) {
      try {
        await getAuth().deleteUser(uid);
        return 'deleted';
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code;
        if (code === 'auth/user-not-found') return 'not-found';
        // Auth の残存は管理用スクリプトでも削除できるため、ここでは致命扱いにしない
        logger.warn(`Auth アカウント ${uid} の削除に失敗しました`, e);
        return 'error';
      }
    },

    async updateDeletionRequest(requestId, patch) {
      await db
        .collection('deletionRequests')
        .doc(requestId)
        .update({ ...patch, processedAt: FieldValue.serverTimestamp() });
    },
  };
}

export const onDeletionRequestCreated = onDocumentCreated(
  'deletionRequests/{requestId}',
  async (event) => {
    const requestId = event.params.requestId;
    const summary = await processDeletion(createStore(), fetchConsentDoc, requestId);
    logger.info(`削除申請 ${requestId} の処理結果`, summary);
  },
);

export const onConsentWithdrawalRequested = onDocumentUpdated(
  'consentRecords/{recordId}',
  async (event) => {
    const before = event.data?.before.data();
    const afterSnap = event.data?.after;
    if (!before || !afterSnap?.exists) return;
    const after = afterSnap.data();
    if (before.status === 'withdrawal_requested' || after.status !== 'withdrawal_requested') {
      return;
    }
    const summary = await processWithdrawal(
      createStore(),
      toConsentRecord(afterSnap.id, after),
    );
    logger.info(`同意 ${afterSnap.id} の撤回処理結果`, summary);
  },
);
