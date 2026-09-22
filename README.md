# wake-velyx

Lightning Studio (velyx-hermes) の完全な wake チェーン — Telegram からでも、時間ででも、手動でも。

## 3つのトリガー（すべて同じ冪等 wake に接続）

| トリガー | 経路 | 用途 |
|---|---|---|
| 定期 wake | `schedule: 23 * * * *` | 毎時23分。バックストップ（Webhook受信側が落ちても復帰保証） |
| オンデマンド | `workflow_dispatch` | GitHub UI ボタン / `gh workflow run` |
| Telegram | Worker → `repository_dispatch` | sleep中のTelegramメッセージから即時wake |

すべて `concurrency: wake-studio` で直列化 → 干渉なし。

## Telegram wake の仕組み（ネイティブ再生方式）

```
Studio sleep時:
  on_stop.sh → Telegram setWebhook(Worker URL, secret_token)   ← "arm"
  Telegram → Worker (受信):
    1. secret_token 検証 (403 otherwise)
    2. repository_dispatch → wake workflow 起動
    3. ack返信: 「起こしてる、2〜5分」
    4. HTTP 503 を返す → Telegram がリトライ継続 → update は pending のまま
Studio 復帰時:
  on_start.sh → systemd → Hermes gateway 起動
  gateway → deleteWebhook(drop_pending_updates=False)   ← Telegram adapter 組込済み
  → pending update が getUpdates に解放 → Velyx が元メッセージをネイティブ処理
```

メッセージ本文はGitHubにもWorkerログにも一切保存されない（privacy）。
Workerは update_id ベースの Cache API でリトライ配信を重複排除。

## Cloudflare Worker セットアップ（一度だけ）

1. https://dash.cloudflare.com → Workers & Pages → Create Worker
2. `worker/wake-worker.js` のコードを貼り付け → Deploy
3. Worker の URL (`https://wake-velyx.<account>.workers.dev`) をメモ
4. Settings → Variables and Secrets → 3つの Secret を登録:
   - `TELEGRAM_BOT_TOKEN` — Hermes が使っている bot token と同一
   - `TELEGRAM_WEBHOOK_SECRET` — Studio の `~/.hermes/.env` の `TELEGRAM_WEBHOOK_SECRET` と同じ値
   - `WAKE_DISPATCH_TOKEN` — GitHub fine-grained PAT (rodorin-lab/wake-velyx, Actions: Read and write)
5. オプション `ALLOWED_USER_IDS` (var) — 未設定ならWorker内のデフォルト（kenyuu の user ID）

## Studio 側 (.env)

```
TELEGRAM_BOT_TOKEN=...          # 既存
TELEGRAM_WEBHOOK_SECRET=...     # on_stop.sh が setWebhook の secret_token に使う
TELEGRAM_WAKE_WORKER_URL=...    # Worker の URL
```

`on_stop.sh` (sleepのたび) と `on_start.sh` (startのたび) は Lightning 標準フックで自動実行。

## 手動テスト

```bash
# Worker が生きているか
curl https://wake-velyx.<account>.workers.dev

# wake workflow を手動発火
gh workflow run wake-studio.yml --repo rodorin-lab/wake-velyx

# webhook の状態確認 (Studio 内から)
source ~/.hermes/.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | python3 -m json.tool
```

## 注意

- 60日間コミットなしで scheduled workflow が disable される（メール通知 → Enable workflow で戻す）
- Free プランの auto-sleep (10分) は継続。定期 wake を上げれば最大応答遅延が縮む
- この repo には秘密情報ゼロ（secrets は GitHub Actions secrets と CF Worker secrets のみ）