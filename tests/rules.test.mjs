// Firestore セキュリティルール v0.2 の受け入れテスト（統一規格 第13章のルール関連項目）
// 実行: npm run test:rules （Emulator を自動起動して実行する）

import { test, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '..', 'firestore.rules'), 'utf8');

const CODE_A = 'p_aaaaaaaaaaaaaaaaaaaa';
const CODE_B = 'p_bbbbbbbbbbbbbbbbbbbb';
const CONSENT_VERSION = 'exp-game01-consent-v1';

let testEnv;

function sessionData(overrides = {}) {
  return {
    schemaVersion: 1,
    experimentId: 'game01',
    participantCode: CODE_A,
    consentRecordId: 'consentA1',
    startedAt: '2026-12-01T10:16:00+09:00',
    endedAt: '2026-12-01T10:31:12+09:00',
    complete: true,
    client: { userAgent: 'test', language: 'ja', platform: 'web' },
    meta: { experimentVersion: '1.0.0', clientVersion: 'lab-client 0.1.0' },
    questionnaire: { q1: 4 },
    events: [{ t: 0.5, type: 'start', data: {} }],
    chunked: false,
    chunkCount: 0,
    payloadChecksum: 'abc123',
    extensions: {},
    receivedAt: serverTimestamp(),
    ...overrides,
  };
}

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'admins', 'admin1'), {});
    await setDoc(doc(db, 'experiments', 'game01'), {
      title: 'テスト実験',
      status: 'open',
      consentVersion: CONSENT_VERSION,
      owner: '柴田',
      ethicsNote: 'テスト用',
      createdAt: '2026-12-01T00:00:00+09:00',
    });
    await setDoc(doc(db, 'experiments', 'closed01'), {
      title: '終了した実験',
      status: 'closed',
      consentVersion: CONSENT_VERSION,
      owner: '柴田',
      ethicsNote: 'テスト用',
      createdAt: '2026-12-01T00:00:00+09:00',
    });
    await setDoc(doc(db, 'participantCodes', CODE_A), { uid: 'userA', createdAt: serverTimestamp() });
    await setDoc(doc(db, 'participantCodes', CODE_B), { uid: 'userB', createdAt: serverTimestamp() });
    await setDoc(doc(db, 'identityLinks', 'userA'), { participantCode: CODE_A, createdAt: serverTimestamp() });
    await setDoc(doc(db, 'identityLinks', 'userB'), { participantCode: CODE_B, createdAt: serverTimestamp() });
    await setDoc(doc(db, 'consentRecords', 'consentA1'), {
      participantCode: CODE_A,
      experimentId: 'game01',
      consentVersion: CONSENT_VERSION,
      consentHash: 'hash-a',
      status: 'agreed',
      agreedAt: serverTimestamp(),
    });
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-shibata-lab',
    firestore: {
      rules,
      host: process.env.FIRESTORE_EMULATOR_HOST?.split(':')[0] ?? '127.0.0.1',
      port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1] ?? 8080),
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed();
});

after(async () => {
  await testEnv.cleanup();
});

const asUserA = () => testEnv.authenticatedContext('userA').firestore();
const asUserB = () => testEnv.authenticatedContext('userB').firestore();
const asAdmin = () => testEnv.authenticatedContext('admin1').firestore();
const asAnon = () => testEnv.unauthenticatedContext().firestore();

// --- experiments -----------------------------------------------------------

test('experiments は未ログインでも読める', async () => {
  await assertSucceeds(getDoc(doc(asAnon(), 'experiments', 'game01')));
});

test('experiments への書き込みは参加者にはできない', async () => {
  await assertFails(setDoc(doc(asUserA(), 'experiments', 'game02'), { title: 'x' }));
});

test('experiments への書き込みは管理者にはできる', async () => {
  await assertSucceeds(setDoc(doc(asAdmin(), 'experiments', 'game02'), { title: 'x', status: 'draft' }));
});

// --- participantCodes / identityLinks --------------------------------------

test('他人の uid でのコード登録は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserB(), 'participantCodes', 'p_cccccccccccccccccccc'), { uid: 'userA', createdAt: serverTimestamp() }),
  );
});

test('自分の uid でのコード登録はできる', async () => {
  await assertSucceeds(
    setDoc(doc(asUserB(), 'participantCodes', 'p_cccccccccccccccccccc'), { uid: 'userB', createdAt: serverTimestamp() }),
  );
});

test('他人のコードを使った対応表の作成（なりすまし）は拒否される', async () => {
  const db = testEnv.authenticatedContext('userC').firestore();
  await assertFails(
    setDoc(doc(db, 'identityLinks', 'userC'), { participantCode: CODE_A, createdAt: serverTimestamp() }),
  );
});

test('自分の対応表は get できるが、他人の対応表は get できない', async () => {
  await assertSucceeds(getDoc(doc(asUserA(), 'identityLinks', 'userA')));
  await assertFails(getDoc(doc(asUserA(), 'identityLinks', 'userB')));
});

test('対応表の list は参加者にはできない', async () => {
  await assertFails(getDocs(collection(asUserA(), 'identityLinks')));
});

// --- consentRecords ----------------------------------------------------------

test('自分のコードでの同意記録の作成はできる', async () => {
  await assertSucceeds(
    setDoc(doc(asUserA(), 'consentRecords', 'consentA2'), {
      participantCode: CODE_A,
      experimentId: 'game01',
      consentVersion: CONSENT_VERSION,
      consentHash: 'hash-a2',
      status: 'agreed',
      agreedAt: serverTimestamp(),
    }),
  );
});

test('他人のコードでの同意記録の作成は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserB(), 'consentRecords', 'consentFake'), {
      participantCode: CODE_A,
      experimentId: 'game01',
      consentVersion: CONSENT_VERSION,
      consentHash: 'hash-x',
      status: 'agreed',
      agreedAt: serverTimestamp(),
    }),
  );
});

test('存在しない実験への同意記録は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserA(), 'consentRecords', 'consentFake2'), {
      participantCode: CODE_A,
      experimentId: 'no-such-exp',
      consentVersion: CONSENT_VERSION,
      consentHash: 'hash-x',
      status: 'agreed',
      agreedAt: serverTimestamp(),
    }),
  );
});

test('自分の同意記録は読めるが、他人の同意記録は読めない', async () => {
  await assertSucceeds(getDoc(doc(asUserA(), 'consentRecords', 'consentA1')));
  await assertFails(getDoc(doc(asUserB(), 'consentRecords', 'consentA1')));
});

test('同意の撤回（status の withdrawal_requested への変更）は本人にできる', async () => {
  await assertSucceeds(
    updateDoc(doc(asUserA(), 'consentRecords', 'consentA1'), {
      status: 'withdrawal_requested',
      withdrawnAt: serverTimestamp(),
    }),
  );
});

test('撤回以外のフィールド変更は本人にもできない', async () => {
  await assertFails(
    updateDoc(doc(asUserA(), 'consentRecords', 'consentA1'), { consentHash: 'tampered' }),
  );
});

// --- sessions ----------------------------------------------------------------

test('正規のセッション作成はできる', async () => {
  await assertSucceeds(setDoc(doc(asUserA(), 'sessions', 'sess-ok'), sessionData()));
});

test('同意なし（存在しない同意記録）でのセッション作成は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserA(), 'sessions', 'sess-ng1'), sessionData({ consentRecordId: 'no-such-consent' })),
  );
});

test('他人の同意記録を使ったセッション作成は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserB(), 'sessions', 'sess-ng2'), sessionData({ participantCode: CODE_B })),
  );
});

test('終了した実験へのセッション作成は拒否される', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'consentRecords', 'consentClosed'), {
      participantCode: CODE_A,
      experimentId: 'closed01',
      consentVersion: CONSENT_VERSION,
      consentHash: 'hash-c',
      status: 'agreed',
      agreedAt: serverTimestamp(),
    });
  });
  await assertFails(
    setDoc(doc(asUserA(), 'sessions', 'sess-ng3'),
      sessionData({ experimentId: 'closed01', consentRecordId: 'consentClosed' })),
  );
});

test('同意版が現行版と異なるセッション作成は拒否される（再同意の強制）', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await updateDoc(doc(db, 'experiments', 'game01'), { consentVersion: 'exp-game01-consent-v2' });
  });
  await assertFails(setDoc(doc(asUserA(), 'sessions', 'sess-ng4'), sessionData()));
});

test('撤回済みの同意ではセッション作成は拒否される', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await updateDoc(doc(db, 'consentRecords', 'consentA1'), { status: 'withdrawal_requested' });
  });
  await assertFails(setDoc(doc(asUserA(), 'sessions', 'sess-ng5'), sessionData()));
});

test('セッションの読み取りは参加者本人にもできず、管理者にはできる', async () => {
  await assertSucceeds(setDoc(doc(asUserA(), 'sessions', 'sess-ro'), sessionData()));
  await assertFails(getDoc(doc(asUserA(), 'sessions', 'sess-ro')));
  await assertSucceeds(getDoc(doc(asAdmin(), 'sessions', 'sess-ro')));
});

// --- chunks --------------------------------------------------------------------

test('正規の分割片の作成はできる', async () => {
  await assertSucceeds(
    setDoc(doc(asUserA(), 'sessions', 'sess-chunk', 'chunks', '0'), {
      index: 0,
      experimentId: 'game01',
      participantCode: CODE_A,
      consentRecordId: 'consentA1',
      events: [{ t: 0.1, type: 'start', data: {} }],
    }),
  );
});

test('撤回済みの同意では分割片の作成も拒否される', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await updateDoc(doc(db, 'consentRecords', 'consentA1'), { status: 'withdrawal_requested' });
  });
  await assertFails(
    setDoc(doc(asUserA(), 'sessions', 'sess-chunk2', 'chunks', '0'), {
      index: 0,
      experimentId: 'game01',
      participantCode: CODE_A,
      consentRecordId: 'consentA1',
      events: [{ t: 0.1, type: 'start', data: {} }],
    }),
  );
});

// --- userPreferences -----------------------------------------------------------

test('自分の設定は読み書きでき、他人の設定は読めない', async () => {
  await assertSucceeds(
    setDoc(doc(asUserA(), 'userPreferences', 'userA'), {
      email: 'a@example.jp',
      recruitOptIn: true,
      updatedAt: serverTimestamp(),
    }),
  );
  await assertFails(getDoc(doc(asUserB(), 'userPreferences', 'userA')));
});

// --- deletionRequests（規格 14.6） ------------------------------------------------

function deletionRequest(overrides = {}) {
  return {
    uid: 'userA',
    participantCode: CODE_A,
    status: 'requested',
    requestedAt: serverTimestamp(),
    ...overrides,
  };
}

test('自分の削除申請の作成はできる', async () => {
  await assertSucceeds(setDoc(doc(asUserA(), 'deletionRequests', 'reqA1'), deletionRequest()));
});

test('他人の uid・コードでの削除申請は拒否される', async () => {
  await assertFails(setDoc(doc(asUserB(), 'deletionRequests', 'reqFake'), deletionRequest()));
});

test('status が requested 以外での削除申請は拒否される', async () => {
  await assertFails(
    setDoc(doc(asUserA(), 'deletionRequests', 'reqNg'), deletionRequest({ status: 'processed' })),
  );
});

test('削除申請の読み取りは本人にもできず、管理者にはできる', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'deletionRequests', 'reqSeed'), {
      uid: 'userA',
      participantCode: CODE_A,
      status: 'requested',
      requestedAt: serverTimestamp(),
    });
  });
  await assertFails(getDoc(doc(asUserA(), 'deletionRequests', 'reqSeed')));
  await assertSucceeds(getDoc(doc(asAdmin(), 'deletionRequests', 'reqSeed')));
});

test('削除申請の更新は本人にはできず、管理者にはできる', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'deletionRequests', 'reqSeed2'), {
      uid: 'userA',
      participantCode: CODE_A,
      status: 'requested',
      requestedAt: serverTimestamp(),
    });
  });
  await assertFails(
    updateDoc(doc(asUserA(), 'deletionRequests', 'reqSeed2'), { status: 'processed' }),
  );
  await assertSucceeds(
    updateDoc(doc(asAdmin(), 'deletionRequests', 'reqSeed2'), { status: 'processed' }),
  );
});

test('参加者によるセッションの削除は拒否される（削除は管理用スクリプトのみ）', async () => {
  await assertSucceeds(setDoc(doc(asUserA(), 'sessions', 'sess-del'), sessionData()));
  await assertFails(deleteDoc(doc(asUserA(), 'sessions', 'sess-del')));
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'sessions', 'sess-del')));
});

// --- 未ログイン ------------------------------------------------------------------

test('未ログインでは experiments 以外にアクセスできない', async () => {
  const db = asAnon();
  await assertFails(getDoc(doc(db, 'identityLinks', 'userA')));
  await assertFails(getDoc(doc(db, 'consentRecords', 'consentA1')));
  await assertFails(setDoc(doc(db, 'sessions', 'sess-anon'), sessionData()));
  await assertFails(setDoc(doc(db, 'deletionRequests', 'req-anon'), deletionRequest()));
});
