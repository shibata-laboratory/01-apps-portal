# Cloud Functions（削除・撤回の即時処理）

統一規格 第14章に基づき、アカウント削除と同意撤回に伴う Firestore 側の
データ削除をサーバー側で即時に実行する Functions です。

## トリガー

- `onDeletionRequestCreated`: `deletionRequests` の新規作成で起動。
  撤回可能期間内の実験データ（sessions / chunks）を削除し、期間を過ぎた
  データは匿名化済みとして保持し、条件が満たされれば対応表・設定・
  コード登録を破棄して申請を `processed` に更新する
- `onConsentWithdrawalRequested`: `consentRecords` の status が
  `withdrawal_requested` に変わったときに起動。対象実験のデータを削除し、
  同意を `withdrawal_processed` に更新する

判定ロジックは `src/logic.ts` に分離されており、管理用 Python スクリプト
（`admin/admin.py`）と同一の規則です。Firestore への接続は
`src/index.ts` の Store 実装が行います。

## 開発・検証

```sh
npm install
npm run test:logic   # tsc ビルド + fake Store によるロジック検証
```

## デプロイ

リポジトリ直下（`firebase.json` のある場所）から実行します。

```sh
firebase deploy --only functions
```

初回デプロイ時は、必要な Google Cloud API（Cloud Build、Artifact Registry、
Eventarc 等）の有効化を CLI が求める場合があります。その場合は許可して
進めてください。

## 失敗時のフォールバック

処理に失敗した申請・撤回は `requested` / `withdrawal_requested` のまま
残ります。`~/lab/admin` の管理用スクリプトで確認・再処理できます。

```sh
python3 admin.py status
python3 admin.py process-deletions --yes
python3 admin.py process-withdrawals --yes
```

## 設定

- リージョン: asia-northeast1（Firestore と同じ）
- 同意文書の取得元: 環境変数 `CONSENT_BASE`（既定は
  `https://apps.shibata-lab.jp/consent`）
- 秘密鍵ファイルは不要です（Google 管理の実行 identity で動作します）
