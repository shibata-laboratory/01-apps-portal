# apps ポータル雛形（柴田向け手順書）

`apps.shibata-lab.jp` 用ポータルの初版。Astro + TypeScript、共通ライブラリ lab-client 同梱。
ローカルビルド成功を確認済み（トップ／ログイン／マイページの3ページと同意 JSON サンプルを生成）。

## 構成

- `src/pages/` — トップ（カタログ）、`login`（Google／メールリンク）、`mypage`（同意履歴と撤回）
- `src/data/catalog.ts` — ツール・ゲームの静的カタログ（規格 4.5）
- `src/firebase-config.ts` — Firebase SDK 設定（**実値の投入が必要**。authDomain は auth.shibata-lab.jp で固定済み）
- `packages/lab-client/` — 共通ライブラリ（規格 第7章の API を実装）
- `public/consent/` — 同意文書の正本 JSON 置き場（サンプル入り）
- `firestore.rules` — 規格 第8章の実装版ルール（**まだ本番に適用しないこと**。下記参照）
- `firebase.json` — Emulator 設定（ルールの自動テスト用）

## 柴田の作業

### 1. リポジトリ作成と push

- Organization `shibata-laboratory` に Public リポジトリ **`01-apps-portal`** を空で作成する
- zip は Finder ではなくターミナルで展開する（隠しファイル漏れの再発防止）

```
cd ~/lab
unzip -o ~/Downloads/01-apps-portal.zip
cd apps
git init
git add .
git commit -m "Apps portal scaffold (Astro + lab-client)"
git branch -M main
git remote add origin https://github.com/shibata-laboratory/01-apps-portal.git
git push -u origin main
```

### 2. Firebase 設定の投入

`src/firebase-config.ts` の `YOUR_...` を、Firebase コンソールで控えた Web アプリ「apps-portal」の実値に置き換えて commit・push する（これらは公開可能な識別子。サービスアカウント鍵とは別物）。

### 3. Pages の設定

- Settings → Pages → Source を **GitHub Actions** にする
- Custom domain に `apps.shibata-lab.jp` を入力して Save する（www のときと同手順。DNS は設定済み）
- 証明書の発行後に Enforce HTTPS を有効化する

### 4. 管理者登録（初回のみ）

1. デプロイされたポータルで一度 Google ログインする（Firebase Authentication に自分のユーザーが作られる）
2. Firebase コンソール → Authentication → Users で自分の UID を確認する
3. Firestore → データ でコレクション `admins` を作り、文書 ID にその UID を指定して空の文書を作成する
   （ルールはこの文書の存在で管理者を判定する）

## まだ行わないこと

- `firestore.rules` の本番適用：現行の全拒否ルールを維持し、Emulator の自動テスト（規格 第13章）を通してから差し替える。テスト整備は次回以降の作業
- 実験の公開：`experiments` への登録と同意文書の設置は、最初の実験の準備時に行う

## ローカル開発

```
npm install
npm run dev        # http://localhost:4321
```
