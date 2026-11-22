// lab-client: 柴田研究室の実験ページ・ツール共通ライブラリ（統一規格 v0.1 第7章）
// 実験ページは Firebase を直接叩かず、本ライブラリを経由する。
// Unity WebGL からは、実験ページ側の JS 関数を通じて本ライブラリを呼ぶ。

import { initializeApp, getApps, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';

export const LAB_CLIENT_VERSION = 'lab-client 0.1.0';
const CONSENT_BASE_DEFAULT = 'https://apps.shibata-lab.jp/consent';
const CHUNK_THRESHOLD_BYTES = 700_000; // 規格 6.1: 約700KB を超えたら分割
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 規格 7章: 再送は24時間以内

export interface LabClient {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

let client: LabClient | null = null;
let consentBase = CONSENT_BASE_DEFAULT;

export interface InitOptions {
  /** 同意文書 JSON の配信元。実験サブドメインからはポータルの正本を指す。 */
  consentBase?: string;
}

export function initLabClient(config: FirebaseOptions, options: InitOptions = {}): LabClient {
  if (options.consentBase) consentBase = options.consentBase.replace(/\/$/, '');
  if (client) return client;
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  client = { app, auth: getAuth(app), db: getFirestore(app) };
  return client;
}

function requireClient(): LabClient {
  if (!client) throw new Error('lab-client: initLabClient() を先に呼ぶこと');
  return client;
}

function currentUser(auth: Auth): Promise<User | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });
}

// ---------------------------------------------------------------------------
// 参加者コード（規格 第3章）
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateParticipantCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let code = 'p_';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export interface SessionState {
  user: User | null;
  participantCode: string | null;
}

/**
 * ログイン状態と参加者コードを返す。未発行なら発行する。
 * 発行は participantCodes（所有者登録）→ identityLinks（対応表）の順に行い、
 * コードの一意性と対応表の整合をルール側の照合で担保する（規格 3.1 / 8章）。
 */
export async function getSessionState(): Promise<SessionState> {
  const { auth, db } = requireClient();
  const user = await currentUser(auth);
  if (!user) return { user: null, participantCode: null };

  const linkRef = doc(db, 'identityLinks', user.uid);
  const link = await getDoc(linkRef);
  if (link.exists()) {
    return { user, participantCode: link.data().participantCode as string };
  }

  const code = generateParticipantCode();
  await setDoc(doc(db, 'participantCodes', code), {
    uid: user.uid,
    createdAt: serverTimestamp(),
  });
  await setDoc(linkRef, {
    participantCode: code,
    createdAt: serverTimestamp(),
  });
  return { user, participantCode: code };
}

// ---------------------------------------------------------------------------
// 同意（規格 第4章）
// ---------------------------------------------------------------------------

export interface ConsentDoc {
  experimentId: string;
  version: string;
  title: string;
  body: string;
}

/** 同意文書の正本 JSON をポータルから取得する。失敗時は例外（実験を開始させない）。 */
export async function fetchConsentDoc(experimentId: string): Promise<ConsentDoc> {
  const res = await fetch(`${consentBase}/${experimentId}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`同意文書の取得に失敗しました (HTTP ${res.status})`);
  const docJson = (await res.json()) as ConsentDoc;
  if (docJson.experimentId !== experimentId) {
    throw new Error('同意文書の experimentId が一致しません');
  }
  return docJson;
}

/** 同意文書の正規化テキスト（版・題・本文）に対する SHA-256。同意記録に保存する。 */
export async function hashConsent(docJson: ConsentDoc): Promise<string> {
  const normalized = `${docJson.version}\n${docJson.title}\n${docJson.body}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RenderedConsent {
  doc: ConsentDoc;
  consentHash: string;
  agreeButton: HTMLButtonElement;
}

/**
 * 同意文書を描画し、「同意する」ボタンを生成する。
 * 取得に失敗した場合はエラー表示のみを行い null を返す（実験を開始させないこと）。
 * ボタンのクリック処理（recordConsent の呼び出し）は呼び出し側が結線する。
 */
export async function renderConsent(
  container: HTMLElement,
  experimentId: string,
): Promise<RenderedConsent | null> {
  container.textContent = '';
  let docJson: ConsentDoc;
  try {
    docJson = await fetchConsentDoc(experimentId);
  } catch (e) {
    const p = document.createElement('p');
    p.textContent = '同意文書を読み込めなかったため、実験を開始できません。通信環境を確認して再読み込みしてください。';
    container.appendChild(p);
    console.error(e);
    return null;
  }
  const consentHash = await hashConsent(docJson);

  const title = document.createElement('h2');
  title.textContent = docJson.title;
  const body = document.createElement('div');
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = docJson.body;
  const version = document.createElement('p');
  version.textContent = `同意文書の版: ${docJson.version}`;
  const button = document.createElement('button');
  button.textContent = '同意して参加する';
  container.append(title, body, version, button);
  return { doc: docJson, consentHash, agreeButton: button };
}

/** 現在の同意版で同意記録を書き込み、記録 ID を返す。 */
export async function recordConsent(
  experimentId: string,
  consentVersion: string,
  consentHash: string,
): Promise<string> {
  const { db } = requireClient();
  const state = await getSessionState();
  if (!state.user || !state.participantCode) {
    throw new Error('同意の記録にはログインが必要です');
  }
  const ref = await addDoc(collection(db, 'consentRecords'), {
    participantCode: state.participantCode,
    experimentId,
    consentVersion,
    consentHash,
    status: 'agreed',
    agreedAt: serverTimestamp(),
  });
  return ref.id;
}

// ---------------------------------------------------------------------------
// セッション（規格 第6章・第7章）
// ---------------------------------------------------------------------------

export interface SessionMeta {
  experimentVersion: string;
  conditionId?: string;
  randomSeed?: number;
  trialSetVersion?: string;
  [key: string]: unknown;
}

export interface LabSession {
  id: string;
  log: (type: string, data?: Record<string, unknown>) => void;
  complete: (questionnaire?: Record<string, unknown>) => Promise<void>;
}

interface SessionPayload {
  schemaVersion: 1;
  experimentId: string;
  participantCode: string;
  consentRecordId: string;
  startedAt: string;
  endedAt: string;
  complete: boolean;
  client: { userAgent: string; language: string; platform: string };
  meta: Record<string, unknown>;
  questionnaire: Record<string, unknown>;
  events: Array<{ t: number; type: string; data: Record<string, unknown> }>;
  chunked: boolean;
  chunkCount: number;
  payloadChecksum: string;
  extensions: Record<string, unknown>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// IndexedDB への控え（送信失敗時の pending、実験途中の inprogress）
function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lab-client', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pending');
      req.result.createObjectStore('inprogress');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbAll(store: string): Promise<Array<{ key: string; value: any }>> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const out: Array<{ key: string; value: any }> = [];
    const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ key: String(cursor.key), value: cursor.value });
        cursor.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

async function writePayload(payload: SessionPayload): Promise<void> {
  const { db } = requireClient();
  const sessionRef = doc(db, 'sessions', payloadSessionId(payload));
  const events = payload.events;

  // チェックサムは events と questionnaire の正規 JSON に対して取る（書き出し側と検証側で同一の定義）
  payload.payloadChecksum = await sha256Hex(JSON.stringify({ events, questionnaire: payload.questionnaire }));

  if (jsonBytes({ ...payload, events }) <= CHUNK_THRESHOLD_BYTES) {
    await setDoc(sessionRef, { ...payload, receivedAt: serverTimestamp() });
    return;
  }

  // 分割: events を 700KB 以内ごとに chunks へ先に書き、本体を最後に書く（本体＝確定の印）
  const chunks: Array<typeof events> = [];
  let current: typeof events = [];
  for (const ev of events) {
    if (current.length && jsonBytes(current) + jsonBytes([ev]) > CHUNK_THRESHOLD_BYTES) {
      chunks.push(current);
      current = [];
    }
    current.push(ev);
  }
  if (current.length) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    await setDoc(doc(db, 'sessions', payloadSessionId(payload), 'chunks', String(i)), {
      index: i,
      experimentId: payload.experimentId,
      participantCode: payload.participantCode,
      consentRecordId: payload.consentRecordId,
      events: chunks[i],
    });
  }
  await setDoc(sessionRef, {
    ...payload,
    events: [],
    chunked: true,
    chunkCount: chunks.length,
    receivedAt: serverTimestamp(),
  });
}

// セッション ID はペイロードに含めず文書 ID として扱うため、内部マップで対応づける
const payloadIds = new WeakMap<SessionPayload, string>();
function payloadSessionId(payload: SessionPayload): string {
  const id = payloadIds.get(payload);
  if (!id) throw new Error('lab-client: セッション ID が未設定です');
  return id;
}

export async function startSession(
  experimentId: string,
  consentRecordId: string,
  meta: SessionMeta,
): Promise<LabSession> {
  const state = await getSessionState();
  if (!state.user || !state.participantCode) {
    throw new Error('セッションの開始にはログインが必要です');
  }
  const participantCode = state.participantCode;
  const sessionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const events: SessionPayload['events'] = [];

  // 実験途中の控え（ブラウザが閉じられた場合に備える。規格 7章）
  const persistProgress = () => {
    void idbPut('inprogress', sessionId, {
      sessionId, experimentId, consentRecordId, participantCode, startedAt, meta, events,
      savedAt: Date.now(),
    }).catch(() => undefined);
  };

  return {
    id: sessionId,
    log(type, data = {}) {
      events.push({ t: (performance.now() - t0) / 1000, type, data });
      if (events.length % 20 === 0) persistProgress();
    },
    async complete(questionnaire = {}) {
      const payload: SessionPayload = {
        schemaVersion: 1,
        experimentId,
        participantCode,
        consentRecordId,
        startedAt,
        endedAt: new Date().toISOString(),
        complete: true,
        client: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          platform: 'web',
        },
        meta: { ...meta, clientVersion: LAB_CLIENT_VERSION },
        questionnaire,
        events,
        chunked: false,
        chunkCount: 0,
        payloadChecksum: '',
        extensions: {},
      };
      payloadIds.set(payload, sessionId);
      try {
        await writePayload(payload);
      } catch (e) {
        // 送信失敗: 控えを残し、呼び出し側にエラーを返す（画面表示と手動再試行は呼び出し側の責務）
        await idbPut('pending', sessionId, { payload, savedAt: Date.now() }).catch(() => undefined);
        throw e;
      }
      await idbDelete('inprogress', sessionId).catch(() => undefined);
    },
  };
}

/**
 * 送信失敗した控えの再送（規格 7章の条件をすべて確認する）。
 * - 保存から24時間以内のみ。期限切れは破棄する
 * - 再送直前に同意状態を確認し、agreed でなければ送信せず破棄する
 * - 同じセッション ID で書くため冪等（既存なら送信済みとして扱う）
 */
export async function retryPendingSessions(): Promise<{ sent: number; discarded: number }> {
  const { db } = requireClient();
  const state = await getSessionState();
  let sent = 0;
  let discarded = 0;
  if (!state.participantCode) return { sent, discarded };

  for (const { key, value } of await idbAll('pending')) {
    const savedAt = value?.savedAt as number;
    const payload = value?.payload as SessionPayload;
    if (!payload || Date.now() - savedAt > PENDING_TTL_MS) {
      await idbDelete('pending', key);
      discarded++;
      continue;
    }
    payloadIds.set(payload, key);

    // 同意状態の再確認
    const q = query(
      collection(db, 'consentRecords'),
      where('participantCode', '==', state.participantCode),
      where('experimentId', '==', payload.experimentId),
    );
    const snap = await getDocs(q);
    const stillAgreed = snap.docs.some(
      (d) => d.id === payload.consentRecordId && d.data().status === 'agreed',
    );
    if (!stillAgreed) {
      await idbDelete('pending', key);
      discarded++;
      continue;
    }

    const existing = await getDoc(doc(db, 'sessions', key));
    if (existing.exists()) {
      await idbDelete('pending', key);
      sent++;
      continue;
    }
    await writePayload(payload);
    await idbDelete('pending', key);
    sent++;
  }
  return { sent, discarded };
}

/** 実験途中で閉じられた未送信セッションの一覧（次回その実験を開いたときに提示するため）。 */
export async function listIncompleteSessions(): Promise<Array<{ key: string; value: any }>> {
  return idbAll('inprogress');
}
