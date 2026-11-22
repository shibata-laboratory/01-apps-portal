// Firebase Web アプリ「apps-portal」の SDK 設定。
//
// Firebase コンソールで控えた実値をここへ入れる。
// これらは秘密情報ではなく公開してよい識別子である（アクセス制御は
// Firestore のセキュリティルールと Authentication が担う）。
// ただしサービスアカウント鍵は全くの別物であり、ここへは絶対に入れない。
//
// authDomain はカスタム認証ドメイン auth.shibata-lab.jp を使う
// （規格 v0.1 の決定。デフォルトの firebaseapp.com には戻さない）。

export const firebaseConfig = {
apiKey: 'YOUR_API_KEY',
authDomain: 'auth.shibata-lab.jp',
projectId: 'shibata-lab-portal',
storageBucket: 'YOUR_STORAGE_BUCKET',
messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
appId: 'YOUR_APP_ID',
};

export const isConfigured = firebaseConfig.apiKey!== 'YOUR_API_KEY';
