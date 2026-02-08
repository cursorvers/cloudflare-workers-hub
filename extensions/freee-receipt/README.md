# SaaS領収書アップローダー（Chrome拡張）

Cloudflare / Vercel / Heroku の管理画面などから請求書PDFを検出して、Workers側のAPIにアップロードする拡張です。

## 使い方（ローカルで読み込み）

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」から `extensions/freee-receipt` を選ぶ
4. 拡張の「オプション」を開き、以下を設定
   - `API URL`
   - `API Token`（Workers側で発行したトークン）

## hub / canary について

- **canary は Chrome Canary のことではなく、Workersの“デプロイ環境名”**です。
- URLにアクセスできれば、どのChrome（通常版/別プロファイル/別PC）でも同じように使えます。
- `manifest.json` の `host_permissions` に hub / canary 両方のドメインを含めています。

## canary はデフォルト read-only（安全策）

canary（`orchestrator-hub-canary`）は安全のため **デフォルトread-only** です。

- そのためアップロードなどの `POST/PUT/DELETE` は **403** になります（意図した挙動）。
- どうしても canary に書き込みしたい場合は、Workersの canary 環境の Variables で
  `CANARY_WRITE_ENABLED=true` を有効化してください。

## 次のステップ: canary を本当に隔離（D1/KV/R2分離）

現状は hub と canary が同じ D1/KV/R2 を共有し得ます（`wrangler.toml` の説明どおり）。
隔離する場合の手順は `docs/DEPLOYMENT_TARGETS.md` の「Split Resources」を参照してください。

