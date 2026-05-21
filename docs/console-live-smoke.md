# Console Live Readonly Smoke

作成日: 2026-05-21

この手順は、本番環境で `/console` の実Xアカウント連携、複数アカウント、スケジュール実行、履歴導線が実際に動くことを確認するための最終スモークです。

## 確認すること

- 2つの実X Cookieを `/api/accounts` から登録できる
- 登録時にヘッドレスブラウザでXセッション検証が通る
- 2アカウントを選択して `profile` 機能を `live` モードで即時実行できる
- 2アカウント分の `once` スケジュールを作成できる
- 作成したスケジュールを `run-now` で実行できる
- 実行履歴に親操作、子操作、スケジュール操作が表示される
- テストで作成したアカウント、スケジュール、履歴が最後に削除される

`profile` は読み取り専用です。投稿、DM、フォロー、いいねなどの副作用は発生しません。

## 前提

- 本番URL: `https://xactions.logence.co.jp`
- VPS: `root@100.114.184.59`
- アプリ内テストユーザー: `test_account_20260521092255`
- APIコンテナ内に `DATABASE_URL` と `JWT_SECRET` が設定されていること
- Xにログイン済みの、別々の2アカウント分の有効なCookieがあること

Cookieは画面共有、ログ、履歴、リポジトリに残さないでください。

## VPS runner

本番イメージには、Cookieを非表示入力して live smoke だけを実行する
runner も入っています。Cookie は標準入力で API コンテナへ渡し、Coolify の
永続環境変数には保存しません。

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/run-console-live-readonly-host.sh /tmp/xactions-live-readonly.sh
bash /tmp/xactions-live-readonly.sh
```

登録済み active XAccount 2件を使う場合:

```bash
XACTIONS_LIVE_READONLY_SOURCE='existing' \
bash /tmp/xactions-live-readonly.sh
```

Cookieを入力せずに実行条件だけ確認する場合:

```bash
XACTIONS_LIVE_READONLY_SOURCE='diagnose' \
bash /tmp/xactions-live-readonly.sh
```

## VPSで実行する

PowerShellからVPSへ入ります。

```powershell
ssh root@100.114.184.59
```

VPS上でCookieを非表示入力し、APIコンテナ内でスモークを実行します。

```bash
set -euo pipefail

api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
test -n "$api"

read -rsp 'X Cookie A: ' COOKIE_A
echo
read -rsp 'X Cookie B: ' COOKIE_B
echo

docker exec \
  -e XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
  -e XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
  -e XACTIONS_LIVE_ACCOUNT_A_COOKIE="$COOKIE_A" \
  -e XACTIONS_LIVE_ACCOUNT_B_COOKIE="$COOKIE_B" \
  -e XACTIONS_LIVE_PROFILE_TARGET='x' \
  "$api" npm run smoke:console-live-readonly

unset COOKIE_A COOKIE_B
```

### 既存 XAccount ID を使う場合

`/console` から実 X アカウントを2つ登録済みなら、Cookieを渡さずに
アカウントIDだけで同じ smoke を実行できます。この場合、既存アカウントは削除せず、
テスト中に作成した予約、実行履歴、Operation だけを削除します。

```bash
set -euo pipefail

api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
test -n "$api"

docker exec \
  -e XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
  -e XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
  -e XACTIONS_LIVE_ACCOUNT_IDS='xaccount_id_1,xaccount_id_2' \
  -e XACTIONS_LIVE_PROFILE_TARGET='x' \
  "$api" npm run smoke:console-live-readonly
```

ユーザー名でも指定できます。

```bash
docker exec \
  -e XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
  -e XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
  -e XACTIONS_LIVE_ACCOUNT_USERNAMES='account_a,account_b' \
  -e XACTIONS_LIVE_PROFILE_TARGET='x' \
  "$api" npm run smoke:console-live-readonly
```

登録済みの active アカウントからデフォルト優先で2件を使う場合は、明示フラグを付けます。

```bash
docker exec \
  -e XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
  -e XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
  -e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS='true' \
  -e XACTIONS_LIVE_PROFILE_TARGET='x' \
  "$api" npm run smoke:console-live-readonly
```

成功時はJSONで `ok: true` が出ます。重要な確認点は次の通りです。

- `accounts` が2件あり、両方 `status: "active"`
- `immediate.operations` が2件あり、両方 `status: "completed"`
- `schedules` が2件あり、両方 `mode: "live"`
- `scheduledRuns` が2件あり、`status` と `operationStatus` が両方 `completed`
- `historyCount` が1以上
- `accountDeletes` が2件あり、両方 `deleted: true`

## 失敗したとき

`/api/accounts` の登録で失敗する場合は、Cookie期限切れ、ログイン追加確認、2FA、X側の一時制限、ヘッドレス環境でのブロックが主な原因です。別ブラウザでXにログインし直し、新しいCookieで再実行してください。

即時実行またはスケジュール実行で失敗する場合は、API/workerログを確認します。

```bash
docker logs --tail 200 "$api"
worker="$(docker ps --format '{{.Names}}' | grep '^worker-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker logs --tail 200 "$worker"
```

スクリプトは `finally` でテストデータを削除します。中断などで残った場合も、次回実行時に24時間超の `smoke_live_readonly_` データを掃除します。

## ローカルで構文だけ確認する

Cookieなしで安全に確認できるのは構文チェックまでです。

```powershell
node --check scripts\smoke-console-live-readonly.js
```
