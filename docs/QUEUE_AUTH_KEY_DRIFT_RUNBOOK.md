# Runbook: Queue API Key Drift (401) - Prevention and Recovery

## Rule (Must)

- Cloudflare Worker `orchestrator-hub` の Queue API 認証は、以下 2 つの secret を **同一値** に揃える。
  - `ASSISTANT_API_KEY`
  - `QUEUE_API_KEY`
- **canonical (正)** のキーは、このリポジトリの `scripts/.env.assistant` に置く。
- Daemon / 監視 / 手動 curl など、Queue API を叩く側は **canonical のキーを参照**する。
- キーを変更したら、必ず `npm run sync:queue-keys` を実行して Workers 側へ同期する。

理由:
- `/api/queue` は `X-API-Key` が不一致だと **HTTP 401** を返す。
- 片方だけ更新すると “キーがズレた状態” になり、監視が 401 を踏み続けて通知スパムになる。

## Rotation Procedure (Key Update)

1. 新しいキー生成（64 hex）
   - `openssl rand -hex 32`
2. canonical 更新
   - `Dev/cloudflare-workers-hub/scripts/.env.assistant` の `ASSISTANT_API_KEY` を差し替え
3. Workers へ同期（default + production）
   - `cd ~/Dev/cloudflare-workers-hub`
   - `npm run sync:queue-keys`
4. 疎通確認（キーなしは 401、キーありは 200）
   - `curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://orchestrator-hub.masa-stage1.workers.dev/api/queue`
   - `source scripts/.env.assistant && curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 -H "X-API-Key: $ASSISTANT_API_KEY" https://orchestrator-hub.masa-stage1.workers.dev/api/queue`
5. Mac Mini 側の Daemon も同じ値に更新
   - Daemon の `.env` に同じ `ASSISTANT_API_KEY` を反映
   - Daemon 再起動（環境に応じて tmux / launchd）

## Recovery Procedure (When Slack Spams 401)

症状:
- Slack に `Workers Hub 異常 / HTTP 401 / .../api/queue` が頻発

対応:
1. MBP で同期を実行
   - `cd ~/Dev/cloudflare-workers-hub && npm run sync:queue-keys`
2. まだ 401 の場合
   - URL が正しいか（別 Worker / 別環境に向いてないか）
   - `wrangler whoami` が正しいアカウントか
   - Secrets が存在するか（値は出ないが、存在は確認できる）
     - `wrangler secret list --name orchestrator-hub`
     - `wrangler secret list --name orchestrator-hub --env canary`

## Guardrails (Already In Place)

- 自動同期 LaunchAgent（MBP）
  - `~/Library/LaunchAgents/com.cloudflare-workers-hub.queue-key-sync.plist`
  - 30 分ごとに `scripts/sync-queue-api-keys.sh` を実行（ログ: `Dev/cloudflare-workers-hub/logs/queue-key-sync.log`）
- 監視スパム抑制（MBP）
  - `Dev/assistant-daemon/health-check.sh` に最低通知間隔 `MIN_NOTIFY_INTERVAL_SEC`（デフォルト 1 時間）を設定
