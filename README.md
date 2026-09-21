# wake-velyx

GitHub Actions による Lightning Studio (velyx-hermes) の定期 wake + オンデマンド wake。

## 仕組み

- `scripts/wake_studio.py` — 冪等な wake スクリプト。Studio が Stopped のときだけ start() を発行し、Running なら no-op、過渡状態 (Pending/Stopping) なら次サイクルに任せて exit 0。
- `.github/workflows/wake-studio.yml` — 2 つのトリガーで同じスクリプトを実行:
  - **schedule** (`23 * * * *`): 毎時23分に定期 wake
  - **workflow_dispatch**: GitHub UI の「Run workflow」ボタンまたは `gh workflow run` でオンデマンド wake
- `concurrency: group=wake-studio` で両トリガーを直列化し干渉防止。

Studio が wake されると、Studio 内部の on_start.sh → systemd unit 復元 → Hermes gateway 起動のチェーンが自動で走る（Studio 側は無変更）。

## セットアップ手順

1. このリポジトリを GitHub に push（public 推奨: 無料枠無制限＆ scheduled workflow が 60 日ルールの影響を受けにくい運用）
2. lightning.ai の Global Settings → Keys → 「Login via CLI」から `LIGHTNING_USER_ID` と `LIGHTNING_API_KEY` を取得
3. repo の Settings → Secrets and variables → Actions → New repository secret で以下を登録:
   - `LIGHTNING_USER_ID`
   - `LIGHTNING_API_KEY`
4. Actions タブで "wake-velyx-studio" workflow の有効化を確認（初回 push 後に自動有効）

## 使い方

- 定期: 毎時23分に自動実行（何もしなくてよい）
- オンデマンド: Actions → wake-velyx-studio → Run workflow ボタン、または:
  ```bash
  gh workflow run wake-studio.yml
  ```

## 注意

- 60 日間 repo にコミットがないと GitHub が schedule を自動無効化する（メール通知あり）。disable されたら「Enable workflow」で戻す。
- Studio の auto-sleep は Free プランで 10 分固定。定期 wake の間隔を縮めると Telegram 応答の最大遅延が縮む（public repo なら無料で頻度アップ可）。
- このリポジトリには秘密情報は含まれない（API キーは GitHub Secrets のみ）。