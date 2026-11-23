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
apiKey: 'AIzaSyDe4aCzV_cJAeO61AEYEcKRvqUiYVijRy0',
authDomain: 'shibata-lab-portal.firebaseapp.com',
projectId: 'shibata-lab-portal',
storageBucket: 'shibata-lab-portal.firebasestorage.app',
messagingSenderId: '739004491737',
appId: '1:739004491737:web:f729051e538b3140d29bc8',
};