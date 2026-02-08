# AI Assistant Daemon セットアップ指示書

## 前提

- MBP: Claude Code セッション実行中
- Mac Mini: tmux 環境構築済み、外部接続可能

---

## Step 1: API Key 生成

```bash
# MBP で実行（ランダムな API Key 生成）
openssl rand -hex 32
# 出力例: a1b2c3d4e5f6...（64文字）
# → この値をメモ
```

---

## Step 2: Workers に API Key 設定

```bash
# MBP で実行
cd ~/Dev/cloudflare-workers-hub
# 推奨: QUEUE_API_KEY と ASSISTANT_API_KEY を同一値に揃える（401再発防止）
#
# プロンプトが出たら Step 1 で生成した値を入力
wrangler secret put ASSISTANT_API_KEY
wrangler secret put QUEUE_API_KEY

# すでにローカルに canonical な ASSISTANT_API_KEY がある場合は同期スクリプトで一括反映可:
# ./scripts/sync-queue-api-keys.sh
```

---

## Step 3: ファイルを Mac Mini に転送

```bash
# MBP で実行
scp ~/Dev/cloudflare-workers-hub/scripts/assistant-daemon.js macmini:~/ai-assistant/
scp ~/Dev/cloudflare-workers-hub/scripts/.env.assistant macmini:~/ai-assistant/.env
```

---

## Step 4: Mac Mini で設定

```bash
# Mac Mini に SSH
ssh macmini

# 作業ディレクトリ移動
cd ~/ai-assistant

# .env を編集
nano .env
```

### .env 編集内容

```bash
# Workers Hub URL（そのまま）
WORKERS_URL=https://orchestrator-hub.masa-stage1.workers.dev

# Step 1 で生成した API Key
ASSISTANT_API_KEY=a1b2c3d4e5f6...

# Telegram Bot Token（@BotFather で取得）
TELEGRAM_BOT_TOKEN=123456789:ABCdef...

# あなたの Telegram User ID（@userinfobot で確認）
TELEGRAM_CHAT_ID=123456789

# ポーリング間隔（15秒推奨）
POLL_INTERVAL=15000

# 作業ディレクトリ（Claude Code が実行される場所）
WORK_DIR=/Users/your-username/Dev/your-project
```

---

## Step 5: 依存関係インストール

```bash
# Mac Mini で実行
cd ~/ai-assistant
npm init -y
npm install dotenv
```

---

## Step 6: デーモン起動

```bash
# Mac Mini で実行
tmux new-session -s assistant
node assistant-daemon.js
```

### 起動確認

Telegram に以下のメッセージが届く:
```
🤖 AI Assistant 起動

タスクを待機中...
```

---

## Step 7: tmux からデタッチ

```
Ctrl+B → D
```

これで SSH を切断してもデーモンは継続動作

---

## 使い方

### スマホから Telegram で指示

```
あなた: このリポジトリの TODO を全部片付けて

🤖: 🔄 タスク開始
    `このリポジトリの TODO を全部片付けて...`

🤖: ✅ 完了 (45.2秒)
    ```
    3件の TODO を修正しました
    - src/utils.ts:45
    - src/handler.ts:120
    - src/index.ts:88
    ```
```

---

## 管理コマンド

### デーモン状態確認

```bash
ssh macmini
tmux attach -t assistant
```

### デーモン停止

```bash
# tmux 内で
Ctrl+C
```

### デーモン再起動

```bash
tmux attach -t assistant
node assistant-daemon.js
```

---

## トラブルシューティング

### Telegram に通知が来ない

1. Bot Token 確認: `@BotFather` で Token を再発行
2. Chat ID 確認: `@userinfobot` で User ID を確認
3. Bot にメッセージを送信済みか確認（初回は必要）

### タスクが実行されない

1. API Key 確認: Workers と .env の値が一致しているか
2. ポーリング確認: デーモンログに `Found X pending task(s)` が出ているか
3. Claude CLI 確認: `claude --version` が動作するか

### デーモンがクラッシュする

1. ログ確認: `~/ai-assistant/logs/daemon.log`
2. Node.js バージョン: `node --version` (18+ 推奨)
3. メモリ確認: `top` で Node プロセスを監視

---

## 自動起動設定（オプション）

Mac Mini 再起動後も自動で起動させる場合:

```bash
# plist ファイルをコピー
sudo cp com.assistant.daemon.plist /Library/LaunchDaemons/

# plist 内の YOUR_USERNAME を自分のユーザー名に置換
sudo nano /Library/LaunchDaemons/com.assistant.daemon.plist

# ログディレクトリ作成
mkdir -p ~/ai-assistant/logs

# 登録・起動
sudo launchctl load /Library/LaunchDaemons/com.assistant.daemon.plist
sudo launchctl start com.assistant.daemon
```

---

## API エンドポイント

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/api/queue` | GET | 保留タスク一覧 |
| `/api/queue/:id` | GET | タスク詳細 |
| `/api/queue/:id/status` | POST | ステータス更新 |
| `/api/result/:id` | GET/POST | 結果取得/保存 |

全て `X-API-Key` ヘッダー必須

---

作成日: 2026-01-25
