// logic.ts の単体テスト（fake Store による判定ロジックの検証）。
// admin.py の fake DB ハーネスと同じシナリオで、処理規則の一致を確認する。
// 実行: npm run test:logic（tsc ビルド後に lib/logic.js を読み込む）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processDeletion, processWithdrawal, withdrawalState } from '../lib/logic.js';

const NOW = new Date('2026-11-26T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// 同意文書: expA は撤回可能期間 30 日、expPast も 30 日、expUnknown は取得不可（null）
const fetchDoc = async (exp) => {
  if (exp === 'expA') return { withdrawalWindowDays: 30 };
  if (exp === 'expPast') return { withdrawalWindowDays: 30 };
  return null;
};

function makeStore(seed) {
  const state = {
    requests: new Map(Object.entries(seed.requests ?? {})),
    consents: new Map((seed.consents ?? []).map((c) => [c.id, { ...c }])),
    sessions: new Map(Object.entries(seed.sessions ?? {})), // key: `${code}/${exp}` -> count
    identity: new Set(seed.identity ?? []), // uid の集合
    auth: new Set(seed.auth ?? []),
    calls: [],
  };
  const store = {
    async getDeletionRequest(id) {
      const r = state.requests.get(id);
      return r ? { ...r } : null;
    },
    async listConsentsByParticipant(code) {
      return [...state.consents.values()].filter((c) => c.participantCode === code).map((c) => ({ ...c }));
    },
    async deleteSessionsFor(code, exp) {
      const key = `${code}/${exp}`;
      const n = state.sessions.get(key) ?? 0;
      state.sessions.delete(key);
      state.calls.push(`deleteSessions:${key}:${n}`);
      return n;
    },
    async markConsentProcessed(id) {
      state.consents.get(id).status = 'withdrawal_processed';
    },
    async deleteIdentity(uid, code) {
      state.identity.delete(uid);
      state.calls.push(`deleteIdentity:${uid}:${code}`);
    },
    async deleteAuthUser(uid) {
      if (!state.auth.has(uid)) return 'not-found';
      state.auth.delete(uid);
      return 'deleted';
    },
    async updateDeletionRequest(id, patch) {
      Object.assign(state.requests.get(id), patch);
    },
  };
  return { store, state };
}

test('withdrawalState: 期間内 / 期間終了 / 判定不能', () => {
  assert.equal(withdrawalState({ agreedAt: daysAgo(10) }, { withdrawalWindowDays: 30 }, NOW), 'in');
  assert.equal(withdrawalState({ agreedAt: daysAgo(31) }, { withdrawalWindowDays: 30 }, NOW), 'past');
  assert.equal(withdrawalState({ agreedAt: daysAgo(10) }, null, NOW), 'unknown');
  assert.equal(withdrawalState({ agreedAt: daysAgo(10) }, {}, NOW), 'unknown');
  assert.equal(withdrawalState({ agreedAt: null }, { withdrawalWindowDays: 30 }, NOW), 'unknown');
});

test('削除申請: 期間内はデータ削除、期間終了は保持、対応表は破棄する', async () => {
  const { store, state } = makeStore({
    requests: { r1: { uid: 'u1', participantCode: 'p_1', status: 'requested' } },
    consents: [
      { id: 'c1', participantCode: 'p_1', experimentId: 'expA', status: 'agreed', agreedAt: daysAgo(10) },
      { id: 'c2', participantCode: 'p_1', experimentId: 'expPast', status: 'agreed', agreedAt: daysAgo(40) },
      { id: 'c3', participantCode: 'p_2', experimentId: 'expA', status: 'agreed', agreedAt: daysAgo(5) },
    ],
    sessions: { 'p_1/expA': 3, 'p_1/expPast': 2, 'p_2/expA': 7 },
    identity: ['u1'],
    auth: ['u1'],
  });
  const s = await processDeletion(store, fetchDoc, 'r1', NOW);
  assert.equal(s.skipped, false);
  assert.equal(s.deletedSessions, 3);
  assert.equal(s.processedConsents, 1);
  assert.equal(s.retainedPastWindow, 1);
  assert.equal(s.blocking, false);
  assert.equal(s.identityDeleted, true);
  assert.equal(s.authResult, 'deleted');
  assert.equal(state.consents.get('c1').status, 'withdrawal_processed');
  assert.equal(state.consents.get('c2').status, 'agreed'); // 期間終了分は保持
  assert.equal(state.sessions.get('p_1/expPast'), 2); // 期間終了分のデータは残る
  assert.equal(state.sessions.has('p_1/expA'), false);
  assert.equal(state.sessions.get('p_2/expA'), 7); // 他人のデータには触れない
  assert.equal(state.identity.has('u1'), false);
  assert.equal(state.requests.get('r1').status, 'processed');
});

test('削除申請: 撤回申請済みの同意は期間判定によらずデータを削除する', async () => {
  const { store, state } = makeStore({
    requests: { r1: { uid: 'u1', participantCode: 'p_1', status: 'requested' } },
    consents: [
      { id: 'c1', participantCode: 'p_1', experimentId: 'expPast', status: 'withdrawal_requested', agreedAt: daysAgo(40) },
    ],
    sessions: { 'p_1/expPast': 4 },
    identity: ['u1'],
    auth: [],
  });
  const s = await processDeletion(store, fetchDoc, 'r1', NOW);
  assert.equal(s.deletedSessions, 4);
  assert.equal(s.authResult, 'not-found'); // Auth は本人フローで削除済みの想定
  assert.equal(state.consents.get('c1').status, 'withdrawal_processed');
  assert.equal(s.identityDeleted, true);
});

test('削除申請: 期間を判定できない同意があると対応表を保持する（blocking）', async () => {
  const { store, state } = makeStore({
    requests: { r1: { uid: 'u1', participantCode: 'p_1', status: 'requested' } },
    consents: [
      { id: 'c1', participantCode: 'p_1', experimentId: 'expUnknown', status: 'agreed', agreedAt: daysAgo(3) },
    ],
    sessions: { 'p_1/expUnknown': 5 },
    identity: ['u1'],
    auth: ['u1'],
  });
  const s = await processDeletion(store, fetchDoc, 'r1', NOW);
  assert.equal(s.blocking, true);
  assert.equal(s.identityDeleted, false);
  assert.equal(s.deletedSessions, 0);
  assert.equal(state.sessions.get('p_1/expUnknown'), 5);
  assert.equal(state.identity.has('u1'), true);
  assert.equal(state.requests.get('r1').status, 'processed');
  assert.equal(state.requests.get('r1').linkRetained, true);
});

test('削除申請: 処理済みの申請は再配送されても何もしない（冪等性）', async () => {
  const { store, state } = makeStore({
    requests: { r1: { uid: 'u1', participantCode: 'p_1', status: 'processed' } },
    consents: [
      { id: 'c1', participantCode: 'p_1', experimentId: 'expA', status: 'agreed', agreedAt: daysAgo(1) },
    ],
    sessions: { 'p_1/expA': 2 },
    identity: ['u1'],
    auth: ['u1'],
  });
  const s = await processDeletion(store, fetchDoc, 'r1', NOW);
  assert.equal(s.skipped, true);
  assert.equal(state.sessions.get('p_1/expA'), 2);
  assert.equal(state.identity.has('u1'), true);
});

test('削除申請: 同意が1件もない場合は個人情報だけを破棄する', async () => {
  const { store, state } = makeStore({
    requests: { r1: { uid: 'u1', participantCode: 'p_1', status: 'requested' } },
    consents: [],
    sessions: {},
    identity: ['u1'],
    auth: ['u1'],
  });
  const s = await processDeletion(store, fetchDoc, 'r1', NOW);
  assert.equal(s.identityDeleted, true);
  assert.equal(s.deletedSessions, 0);
  assert.equal(state.requests.get('r1').status, 'processed');
});

test('撤回処理: withdrawal_requested の同意のデータを削除して処理済みにする', async () => {
  const { store, state } = makeStore({
    consents: [
      { id: 'c1', participantCode: 'p_1', experimentId: 'expA', status: 'withdrawal_requested', agreedAt: daysAgo(2) },
    ],
    sessions: { 'p_1/expA': 6 },
  });
  const consent = { id: 'c1', participantCode: 'p_1', experimentId: 'expA', status: 'withdrawal_requested', agreedAt: daysAgo(2) };
  const s = await processWithdrawal(store, consent);
  assert.equal(s.skipped, false);
  assert.equal(s.deletedSessions, 6);
  assert.equal(state.consents.get('c1').status, 'withdrawal_processed');
  // 再実行しても安全（既に処理済みの同意はスキップされる想定の入力では何も起きない）
  const s2 = await processWithdrawal(store, { ...consent, status: 'withdrawal_processed' });
  assert.equal(s2.skipped, true);
});
