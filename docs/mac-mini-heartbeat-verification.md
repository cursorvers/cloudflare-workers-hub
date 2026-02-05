# Mac Mini Heartbeat 監視システム - 確認手順書

## 概要

AI Assistant Daemon（Mac Mini）の SPOF 対策として、Cloudflare Workers の Durable Objects Alarm で heartbeat 監視を実装しました。

**実装日**: 2026-02-04
**バージョン**: 9b76fbb4-436b-4c3f-9178-05e5eb1dae6f

---

## アーキテクチャ

```
Mac Mini Daemon (5分ごと)
    ↓ POST /api/queue/heartbeat
Cloudflare Workers (Queue Handler)
    ↓ coordinatorFetch('/heartbeat')
TaskCoordinator DO
    ↓ handleHeartbeat() → daemon:heartbeat 記録
alarm() (60秒ごと)
    ├─ 期限切れリースのクリーンアップ
    └─ heartbeat チェック
        ├─ 正常（< 3分） → ログなし
        ├─ Warning（3-5分） → 警告ログ
        └─ CRITICAL（> 5分） → 重大ログ
```

---

## Mac Mini での確認手順

### 1. daemon の動作確認

```bash
# Mac Mini にログイン
ssh mm

# daemon のステータス確認
launchctl list | grep assistant.daemon

# 最新ログを確認（heartbeat 送信を確認）
tail -30 ~/Dev/assistant-daemon/daemon.log | grep Heartbeat
```

**期待される出力**:
```
[2026-02-04T14:13:26.487Z] [INFO] [Heartbeat] 待機中
[2026-02-04T14:13:28.213Z] [INFO] [Heartbeat] Sent successfully
[2026-02-04T14:18:28.210Z] [INFO] [Heartbeat] 待機中
[2026-02-04T14:18:29.158Z] [INFO] [Heartbeat] Sent successfully
```

**正常動作の条件**:
- 5分（300秒）ごとに "Sent successfully" が記録される
- エラーがない

---

### 2. daemon の再起動

```bash
# daemon を停止
launchctl unload ~/Library/LaunchAgents/com.assistant.daemon.plist

# 2秒待機
sleep 2

# daemon を起動
launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist

# 起動確認
tail -10 ~/Dev/assistant-daemon/daemon.log
```

**期待される出力**:
```
========================================
  AI Assistant Daemon v2.2
  ClaimTask API + Lease Management
========================================
[2026-02-04T14:08:26.463Z] [INFO] [Startup] Locks cleared
[2026-02-04T14:08:26.464Z] [INFO] [Config] Using Slack Bot Token
[2026-02-04T14:08:26.464Z] [INFO] [Daemon] Poll loop started
```

---

### 3. heartbeat 送信の確認

**リアルタイム監視**:
```bash
# ログをリアルタイムで表示（Ctrl+C で終了）
tail -f ~/Dev/assistant-daemon/daemon.log
```

**5分待機して heartbeat を確認**:
```bash
# 現在時刻を確認
date

# 5分後の時刻を計算して待機
# 例: 現在 14:10 → 次回 heartbeat は 14:15

# 5分後にログを確認
sleep 300 && tail -10 ~/Dev/assistant-daemon/daemon.log | grep Heartbeat
```

---

### 4. 異常検出テスト（オプション）

**daemon を停止して5分後に CRITICAL 警告が出ることを確認**:

```bash
# daemon を停止
launchctl unload ~/Library/LaunchAgents/com.assistant.daemon.plist

# 停止確認
launchctl list | grep assistant.daemon
# 出力がないことを確認

# 現在時刻をメモ
date
```

**開発マシン（masayuki）で Cloudflare Workers のログを確認**:
```bash
# 6分後に確認
wrangler tail --format pretty --search "CRITICAL"
```

**期待される出力**（5分後）:
```
[TaskCoordinator] CRITICAL: Mac Mini daemon unresponsive
  lastHeartbeat: 2026-02-04T14:XX:XX.XXXZ
  elapsedSec: 300+
```

**daemon を再起動**:
```bash
launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist
tail -10 ~/Dev/assistant-daemon/daemon.log
```

---

## Cloudflare Workers での確認手順

### 1. デプロイ確認

```bash
wrangler deployments list
```

**期待される出力**:
```
Version ID: 9b76fbb4-436b-4c3f-9178-05e5eb1dae6f
Created:    2026-02-04
```

---

### 2. リアルタイムログ監視

```bash
# heartbeat を含むログを監視
wrangler tail --format pretty --search "heartbeat"
```

**期待される出力**（5分ごと）:
```
POST /api/queue/heartbeat - Ok
  (info) [Queue API] Heartbeat recorded

POST http://do/heartbeat - Ok
  (info) [TaskCoordinator] Heartbeat recorded
```

---

### 3. alarm ログの確認

```bash
# alarm を含むログを監視
wrangler tail --format pretty --search "alarm"
```

**期待される出力**（60秒ごと）:
```
Alarm @ 2/4/2026, 11:XX:XX PM - Ok
  (info) [TaskCoordinator] Alarm triggered
```

**正常時**:
- heartbeat に関する警告なし
- 期限切れリースのクリーンアップのみ

**異常時（3-5分無応答）**:
```
Alarm @ 2/4/2026, 11:XX:XX PM - Ok
  (info) [TaskCoordinator] Alarm triggered
  (info) [TaskCoordinator] Warning: Daemon heartbeat delayed
    elapsedSec: 240
    lastHeartbeat: 2026-02-04T14:XX:XX.XXXZ
```

**異常時（5分以上無応答）**:
```
Alarm @ 2/4/2026, 11:XX:XX PM - Ok
  (warn) [TaskCoordinator] CRITICAL: Mac Mini daemon unresponsive
    lastHeartbeat: 2026-02-04T14:XX:XX.XXXZ
    elapsedSec: 300+
```

---

## トラブルシューティング

### heartbeat が送信されない

**原因1**: daemon が起動していない
```bash
# 確認
ssh mm "launchctl list | grep assistant.daemon"

# 起動
ssh mm "launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist"
```

**原因2**: スクリプトが古いバージョン
```bash
# 開発マシンから最新版を転送
scp ~/Dev/cloudflare-workers-hub/scripts/assistant-daemon.js mm:~/Dev/assistant-daemon/

# daemon を再起動
ssh mm "launchctl unload ~/Library/LaunchAgents/com.assistant.daemon.plist && sleep 2 && launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist"
```

**原因3**: API Key が設定されていない
```bash
# .env ファイルを確認
ssh mm "cat ~/Dev/assistant-daemon/.env | grep ASSISTANT_API_KEY"

# 出力がない場合は設定
ssh mm "echo 'ASSISTANT_API_KEY=YOUR_KEY_HERE' >> ~/Dev/assistant-daemon/.env"
```

---

### heartbeat が受信されない

**原因1**: Cloudflare Workers がデプロイされていない
```bash
# デプロイ
wrangler deploy
```

**原因2**: Durable Objects が無効
```bash
# wrangler.toml を確認
grep -A 5 "durable_objects" wrangler.toml
```

**期待される出力**:
```toml
[[durable_objects.bindings]]
name = "TASK_COORDINATOR"
class_name = "TaskCoordinator"
script_name = "orchestrator-hub"
```

---

### Warning ログが頻発する

**原因**: heartbeat 送信間隔（5分）> alarm チェック間隔（60秒）のため、一時的に Warning が出るのは正常動作。

**対策不要**: 次の heartbeat 受信後に解消される。

**恒常的に Warning が出る場合**:
- Mac Mini のネットワーク接続を確認
- daemon のログでエラーがないか確認

---

## 監視・アラート設定（将来実装）

### Phase 2: Discord/Slack 通知

CRITICAL 検出時に Discord/Slack に通知を送信する機能を追加予定。

**実装例**:
```typescript
// TaskCoordinator DO の alarm()
if (elapsedSec > HEARTBEAT_TIMEOUT_SEC) {
  console.warn('[TaskCoordinator] CRITICAL: Mac Mini daemon unresponsive');

  // Discord 通知（Phase 2）
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '🚨 **CRITICAL**: Mac Mini daemon が5分間無応答です',
    }),
  });
}
```

---

## Phase 2 実装計画

### 自動タスク処理

5分間無応答検出時、DO 自身がタスクをクレーム・処理する機能。

**実装ステップ**:
1. Claude API Key を DO の環境変数に追加
2. `claimAndProcessTasks()` メソッド実装
3. セキュリティレビュー（Codex）
4. テスト（Mac Mini停止 → DO がタスク処理）
5. 本番デプロイ

---

## 関連ドキュメント

- **実装記録**: `/Users/masayuki/.claude/skills/agent-memory/memories/in-progress/mac-mini-spof-heartbeat.md`
- **TaskCoordinator DO**: `src/durable-objects/task-coordinator.ts`
- **Queue Handler**: `src/handlers/queue.ts`
- **Daemon スクリプト**: `scripts/assistant-daemon.js`

---

**作成日**: 2026-02-04
**最終更新**: 2026-02-04
**バージョン**: 1.0
