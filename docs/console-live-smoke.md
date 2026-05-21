# Console Live Readonly Smoke

作成日: 2026-05-21
更新日: 2026-05-22

この手順は、本番環境で `/console` の実Xアカウント連携、複数アカウント実行、スケジュール実行、履歴導線が実際に動くことを確認するための最終スモークです。

`profile` 取得だけを使う読み取り専用の確認です。投稿、DM、フォロー、Like などの副作用がある操作は実行しません。

## 確認すること

- 2つの実Xアカウントを `/api/accounts` から登録できる
- 登録時にヘッドレスブラウザでXセッション検証が通る
- 2アカウントを選択して `profile` 機能を `live` モードで即時実行できる
- 2アカウント分の `once` スケジュールを作成できる
- 作成したスケジュールを `run-now` で実行できる
- 実行履歴に親操作、子操作、スケジュール操作が表示される
- テストで作成したアカウント、スケジュール、履歴が最後に削除される

## 前提

- 本番URL: `https://xactions.logence.co.jp`
- VPS: `root@100.114.184.59`
- テストアプリユーザー: `test_account_20260521092255`
- APIコンテナ内に `DATABASE_URL` と `JWT_SECRET` が設定されている
- Xにログイン済みの別々の実アカウント2件の有効なCookieがある

Cookieは画面共有、ログ、履歴、リポジトリに残さないでください。

## 実アカウントを先に登録する

毎回Cookieを入力せずに確認したい場合は、2つの実Xアカウントをテストユーザーへ登録します。Cookieは標準入力でAPIコンテナへ渡され、ログには出ません。登録時にヘッドレスブラウザでログイン状態を確認し、通った場合だけ `active` な `XAccount` として保存します。

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/register-console-live-accounts-host.sh /tmp/xactions-register-live-accounts.sh
bash /tmp/xactions-register-live-accounts.sh
```

登録後、既存アカウントを使ってlive readonly smokeを実行します。

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/run-console-live-readonly-host.sh /tmp/xactions-live-readonly.sh
XACTIONS_LIVE_READONLY_SOURCE='existing' bash /tmp/xactions-live-readonly.sh
```

## 一時Cookieで直接実行する

登録を残さず、その場のCookieだけで実行する場合はrunnerを使います。Cookieは標準入力でAPIコンテナへ渡され、Coolifyの永続環境変数には保存されません。

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/run-console-live-readonly-host.sh /tmp/xactions-live-readonly.sh
bash /tmp/xactions-live-readonly.sh
```

`XACTIONS_LIVE_READONLY_SOURCE=auto` は、次の順で安全に実行方法を選びます。

1. ホスト環境変数に2件のlive cookieがあれば使う
2. 既存アカウントのIDまたはユーザー名が指定されていれば使う
3. smokeユーザーに `active` な `XAccount` が2件以上あれば先頭2件を使う
4. APIコンテナ環境変数に2件のlive cookieがあれば使う
5. 準備不足ならTTY環境ではCookie入力を促し、非TTY環境では終了する

非TTYのヘッドレス確認ではCookie入力プロンプトを開きません。準備状態だけを確認する場合は次を使います。

```bash
XACTIONS_LIVE_READONLY_SOURCE='diagnose' bash /tmp/xactions-live-readonly.sh
```

## 既存XAccountを明示する

`/console` から実Xアカウントを2つ登録済みなら、Cookieを渡さずにアカウントIDだけで同じsmokeを実行できます。この場合、既存アカウント自体は削除されず、テスト中に作成した予約、実行履歴、Operationだけを削除します。

```bash
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

登録済みの `active` アカウントからデフォルト優先で2件を使う場合は、次を使います。

```bash
docker exec \
  -e XACTIONS_BASE_URL='https://xactions.logence.co.jp' \
  -e XACTIONS_SMOKE_USERNAME='test_account_20260521092255' \
  -e XACTIONS_LIVE_USE_EXISTING_ACCOUNTS='true' \
  -e XACTIONS_LIVE_PROFILE_TARGET='x' \
  "$api" npm run smoke:console-live-readonly
```

## 成功条件

成功時はJSONに `ok: true` が出ます。主要な確認点は次の通りです。

- `accounts` が2件あり、両方 `status: "active"`
- `immediate.operations` が2件あり、両方 `status: "completed"`
- `schedules` が2件あり、両方 `mode: "live"`
- `scheduledRuns` が2件あり、`status` と `operationStatus` が両方 `completed`
- `historyCount` が1以上
- Cookieで作成した一時アカウントを使った場合、`accountDeletes` が2件あり、両方 `deleted: true`

## 失敗時

`/api/accounts` の登録で失敗する場合は、Cookie期限切れ、ログイン追加確認、2FA、X側の一時制限、ヘッドレス環境でのブロックが主な原因です。別ブラウザでXにログインし直し、新しいCookieで再実行してください。

即時実行またはスケジュール実行で失敗する場合は、API/workerログを確認します。

```bash
docker logs --tail 200 "$api"
worker="$(docker ps --format '{{.Names}}' | grep '^worker-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker logs --tail 200 "$worker"
```

スクリプトは `finally` でテストデータを削除します。中断などで残った場合も、次回実行時に24時間超過の `smoke_live_readonly_` データを掃除します。

## ローカルで構文だけ確認する

Cookieなしで安全に確認できるのは構文チェックまでです。

```powershell
node --check scripts\smoke-console-live-readonly.js
```
