# XActions Console / Schedule / Multi Account Specification

作成日: 2026-05-21
更新日: 2026-05-22

## 目的

XActionsを「機能はあるが探しにくいツール群」から、「Xに近い操作感の日本語管理コンソール」に作り替える。

目標は次の3つ。

1. すべての機能へ簡単にアクセスできること
2. 各機能で「何ができるか」「必要な設定」「実行履歴」が同じ導線で分かること
3. 複数Xアカウントとスケジュール実行に対応すること

## 非目的

- XのCAPTCHA、2FA、アカウントロックを回避する実装はしない
- Xの利用規約に反する大量実行を助長するUIにはしない
- 既存ページを一気に削除しない
- 初期実装でReact / Next.jsなどへの大規模移行はしない

## 現状の課題

### UI

- `/dashboard` は英語中心で、OSS宣伝、説明文、開発者向け表現が多い
- `/actions` にLike / Follow / DMがあるが、ダッシュボードから見つけにくい
- 機能ごとに設定と履歴を見る導線が統一されていない
- ページが複数あり、全体像が分かりづらい

### API / worker

- `Operation` は実行履歴として使える
- Bull / Redisの `queueJob` がある
- `targetEngage`, `likeTweet`, `unlikeTweet`, `sendDM` はworker処理に接続済み
- `posting`, `discovery`, `settings`, `bookmarks`, `creator`, `spaces` などはAPIルートがあるが、すべてのjob typeがworkerで実処理できるとは限らない
- 既存の `schedule.js` はCLI schedulerベースで、ユーザー別、DB永続、UI操作向けではない
- `UnfollowerSchedule` はunfollower scan専用

### アカウント

- 従来は `User.sessionCookie` 1件が中心
- 複数Xアカウント、アカウント別履歴、アカウント別セッション状態は未対応だった

## 基本方針

新しい中心画面として `/console` を作る。既存ページは残し、段階的に `/console` へ統合する。

UIはX風の黒基調、細い境界線、タイムラインに近い密度を維持する。ただしコピーは日本語で短くし、AIっぽい説明文や開発者向けの言葉を削る。

技術面では、まず既存の静的HTML / Vanilla JS / Express / Prisma / Bullを活かす。フロントエンドフレームワーク導入は後回しにする。

## 情報設計

### グローバルナビ

- ホーム
- アクション
- 投稿
- DM
- フォロワー
- 収集
- 分析
- 監視
- 自動化
- データ
- 設定

### 画面レイアウト

3カラム構成を基本にする。

- 左: カテゴリナビ、Xアカウント切替
- 中央: 機能一覧、履歴タイムライン
- 右: 選択中機能の設定、予約、直近履歴

モバイルでは、左ナビを下部タブ、右パネルを下部シートにする。

## 機能カタログ

すべての機能を `Feature Catalog` として定義する。UIはこのカタログを読み、機能一覧、設定フォーム、予約フォーム、履歴フィルタを生成する。

例:

```js
{
  id: 'sendDM',
  category: 'dm',
  title: 'DM送信',
  summary: '指定したユーザーに1通のDMを送ります。',
  operationType: 'sendDM',
  queueType: 'sendDM',
  endpoint: '/api/messages/send',
  method: 'POST',
  authRequired: true,
  accountRequired: true,
  supportsDryRun: false,
  supportsSchedule: true,
  riskLevel: 'high',
  fields: [
    { key: 'username', label: '送信先', type: 'username', required: true },
    { key: 'message', label: '本文', type: 'textarea', required: true, max: 1000 }
  ]
}
```

### カテゴリ別機能

#### アクション

- 指定ユーザーにLike / Follow / DM
- 投稿にLike
- Like解除
- 返信
- ブックマーク
- 自動Like
- エンゲージャーフォロー
- キーワードフォロー
- 自動コメント

#### 投稿

- ポスト投稿
- スレッド投稿
- 投票作成
- 予約投稿
- 投稿削除
- スレッド作成補助

#### DM

- DM送信
- 会話一覧
- DMエクスポート

#### フォロワー

- フォロワーでない人を解除
- 全解除
- アンフォロー検出
- フォロワースキャン
- 増減履歴
- 自動スキャン

#### 収集

- プロフィール取得
- フォロワー取得
- フォロー中取得
- ツイート取得
- 検索
- ハッシュタグ検索
- メディア取得
- ブックマーク取得
- トレンド
- Explore
- Spaces
- 動画抽出
- スレッド展開

#### 分析

- エンゲージメント分析
- 感情分析
- 価格相関
- 成長履歴
- オーディエンス重複
- 最適投稿時間
- レポート

#### 監視

- アカウント監視
- フォロワー監視
- フォロー中監視
- キーワードストリーム
- 通知

#### 自動化

- ワークフロー
- スケジュール実行
- Webhook実行
- AIエージェント
- 自動化プリセット

#### データ

- データセット
- エクスポート
- 移行
- 差分比較

#### 設定

- Xアカウント連携
- 複数アカウント管理
- セッション更新
- プロフィール更新
- 保護アカウント切替
- ブロック / ミュート
- チーム
- 管理者機能

## 日本語コピー方針

開発者用語を避ける。

| 従来表現 | 新しい表現 |
| --- | --- |
| Dashboard | ホーム |
| Operations | 実行 |
| Queue Action | 実行予約 |
| Dry run | 確認のみ |
| Live | 実行 |
| Target username | 対象ユーザー |
| Delay ms | 実行間隔 |
| Session Cookie | X連携情報 |
| Status | 状態 |
| History | 履歴 |
| Failed | 失敗 |
| Completed | 完了 |
| Processing | 実行中 |

説明文は短くする。例:

- 避ける: `AI-powered X/Twitter automation toolkit for growth and engagement.`
- 使う: `指定したユーザーにDMを送ります。`

## 複数アカウント仕様

### 要件

- 1つのXActionsユーザーが複数のXアカウントを登録できる
- 各Xアカウントのsession cookieは暗号化して保存する
- 実行時は必ず `accountId` を指定する
- デフォルトアカウントを設定できる
- アカウントごとに履歴、予約、セッション状態を見られる
- セッション切れのアカウントは実行前に止める

### Prisma

```prisma
model XAccount {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  username        String
  displayName     String?
  avatarUrl       String?
  encryptedCookie String   @db.Text
  authMethod      String   @default("session")
  status          String   @default("active") // active, expired, error, disabled
  isDefault       Boolean  @default(false)
  lastVerifiedAt  DateTime?
  lastUsedAt      DateTime?
  error           String?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  operations      Operation[]
  schedules       ScheduledAction[]

  @@unique([userId, username])
  @@index([userId, status])
}
```

`User.sessionCookie` は互換用として残す。新UIは `XAccount` を使う。移行時に既存cookieがあればdefault accountを作る。

### API

- `GET /api/accounts`
- `POST /api/accounts`
- `POST /api/accounts/:id/verify`
- `PATCH /api/accounts/:id`
- `DELETE /api/accounts/:id`
- `POST /api/accounts/:id/default`

### 実行時ルール

- job dataに暗号化cookieや復号済みcookieを入れない
- workerは `accountId` からDBを引き、実行直前に復号する
- `Operation` に `accountId` を記録する
- 同一 `accountId` のlive操作は同時実行1本までにする

## スケジュール実行仕様

### 要件

- 対応機能では「今すぐ実行」と「予約」を選べる
- 予約はDBに保存され、worker再起動後も残る
- 予約実行は `Operation` として履歴に残る
- 予約ごとに有効 / 停止を切り替えられる
- 失敗時は再試行し、最終失敗理由を残す
- タイムゾーン初期値は `Asia/Tokyo`

### 予約タイプ

- 1回だけ
- 毎日
- 毎週
- 指定間隔
- cron上級設定

### Prisma

```prisma
model ScheduledAction {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  accountId       String?
  account         XAccount? @relation(fields: [accountId], references: [id], onDelete: SetNull)

  name            String
  featureId       String
  operationType   String
  config          String   @db.Text
  mode            String   @default("dryRun") // dryRun, live

  scheduleType    String   // once, daily, weekly, interval, cron
  cron            String?
  intervalMinutes Int?
  runAt           DateTime?
  daysOfWeek      String?
  timezone        String   @default("Asia/Tokyo")

  status          String   @default("active") // active, paused, completed, failed
  nextRunAt       DateTime?
  lastRunAt       DateTime?
  lockedAt        DateTime?
  lockedBy        String?
  maxRetries      Int      @default(2)
  failureCount    Int      @default(0)
  lastError       String?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  runs            ScheduledActionRun[]

  @@index([userId, status])
  @@index([status, nextRunAt])
  @@index([accountId])
}

model ScheduledActionRun {
  id                String   @id @default(cuid())
  scheduledActionId String
  scheduledAction   ScheduledAction @relation(fields: [scheduledActionId], references: [id], onDelete: Cascade)
  operationId        String?
  operation          Operation? @relation(fields: [operationId], references: [id], onDelete: SetNull)

  status             String   @default("queued") // queued, running, completed, failed, skipped
  scheduledFor       DateTime
  startedAt          DateTime?
  finishedAt         DateTime?
  error              String?

  createdAt          DateTime @default(now())

  @@index([scheduledActionId, createdAt])
  @@index([status, scheduledFor])
}
```

`Operation` には次を追加する。

```prisma
accountId         String?
scheduledActionId String?
parentOperationId String?
batchId           String?
```

### Scheduler Worker

workerに30秒または60秒間隔のscheduler loopを追加する。

流れ:

1. `ScheduledAction` から `status=active` かつ `nextRunAt <= now` を取得
2. transactionで `lockedAt`, `lockedBy` を設定してclaim
3. `ScheduledActionRun` を作成
4. `Operation` を作成
5. `queueJob` に投入
6. 次回 `nextRunAt` を計算
7. 完了 / 失敗を `Operation` と `ScheduledActionRun` に反映

同時実行対策:

- `lockedAt` が新しい予約は他workerが触らない
- 古いlockは10分でstaleとみなす
- 同一accountのlive actionは直列化する

### API

- `GET /api/scheduled-actions`
- `POST /api/scheduled-actions`
- `GET /api/scheduled-actions/:id`
- `PATCH /api/scheduled-actions/:id`
- `DELETE /api/scheduled-actions/:id`
- `POST /api/scheduled-actions/:id/pause`
- `POST /api/scheduled-actions/:id/resume`
- `POST /api/scheduled-actions/:id/run-now`
- `GET /api/scheduled-actions/:id/runs`

### UI

各機能の右パネルに `実行方法` を置く。

- 今すぐ
- 予約

予約を選ぶと次を表示する。

- 実行アカウント
- 予約タイプ
- 日時または間隔
- 確認のみ / 実行
- 失敗時の再試行回数
- 保存ボタン

## 統一実行API

個別APIを残しつつ、新UIからは統一APIを使う。

`POST /api/console/actions/execute`

```json
{
  "featureId": "targetEngage",
  "accountId": "xacc_...",
  "mode": "dryRun",
  "config": {
    "targetUsername": "example",
    "likeCount": 1,
    "follow": false,
    "dmMessage": ""
  }
}
```

`POST /api/console/actions/schedule`

```json
{
  "featureId": "sendDM",
  "accountId": "xacc_...",
  "mode": "live",
  "config": {
    "username": "example",
    "message": "..."
  },
  "schedule": {
    "type": "once",
    "runAt": "2026-05-21T18:00:00+09:00",
    "timezone": "Asia/Tokyo"
  }
}
```

## バッチ / 複数アカウント実行

### 要件

- 1つの機能を複数アカウントで実行できる
- アカウントごとに子operationを作る
- 親operationで全体進捗を見る
- 失敗したアカウントだけ再実行できる

### 仕様

`accountIds` が複数の場合、親jobを作る。

```json
{
  "featureId": "targetEngage",
  "accountIds": ["acc1", "acc2"],
  "mode": "dryRun",
  "config": {}
}
```

制限:

- 初期値は同時1アカウント
- 設定で最大2件まで
- DMやfollowのlive実行は連続実行間隔を強制する

## 実装フェーズ

### Phase 0: 棚卸し

- 既存API / job type / worker processorを一覧化
- 機能ごとに `利用可能`, `APIあり`, `worker未実装`, `UI未接続` を分類
- Feature Catalogの初期版を作る

成果物:

- `api/config/features.js`
- `dashboard/console.html`

### Phase 1: DB基盤

- `XAccount`
- `ScheduledAction`
- `ScheduledActionRun`
- `Operation` 拡張
- 既存 `User.sessionCookie` からdefault `XAccount` を作る移行処理

注意:

現在 `prisma/migrations` が実質的でないため、本番DBのbaselineが必要。

推奨手順:

1. 現在の本番DBと `schema.prisma` を比較
2. baseline migrationを作成
3. 本番で `prisma migrate resolve --applied` を実行
4. 以後の通常migrationをcommitする
5. `.gitignore` の `prisma/migrations/*/migration.sql` を見直す

### Phase 2: 複数アカウント

- account API実装
- session cookie暗号化を `XAccount` に移動
- `getDecryptedSessionCookie(userId)` を `getDecryptedAccountCookie(accountId, userId)` に拡張
- UIにアカウント切替を追加
- 既存 `/api/session/*` は互換用として残す

### Phase 3: 統一実行

- Feature Catalogをもとに入力検証
- `featureId` からoperation type / worker typeを解決
- `accountId` 必須化
- `Operation.accountId` に保存
- 既存 `/api/actions/target` は内部で統一実行へ寄せる

### Phase 4: スケジューラ

- `scheduledActionScheduler.js` をworkerに追加
- due schedule claim処理
- nextRunAt計算
- run-now / pause / resume API
- 実行結果反映

### Phase 5: Console UI

- `/console` 追加
- 日本語ナビ
- 機能一覧
- 詳細パネル
- 設定フォーム
- 予約フォーム
- 機能別履歴
- アカウント管理

### Phase 6: 機能接続

優先順:

1. DM送信
2. targetEngage
3. like / unlike
4. unfollow系
5. follower scan
6. posting系
7. scrape / analytics系
8. workflow / agent系

worker未実装のjob typeはUIで `準備中` にせず、実装してから `利用可能` にする。

### Phase 7: 本番移行

- 本番DBバックアップ
- migration実行
- Coolify deploy
- health check
- API smoke test
- scheduler loop起動確認
- 予約dry-run test
- 複数アカウント追加test

## テスト計画

### Unit

- cron / interval / daily / weeklyのnextRunAt
- timezone変換
- Feature Catalog validation
- account cookie parse
- schedule claim lock

### Integration

- account CRUD
- execute action
- schedule create / pause / resume / run-now
- operation history filter
- schedule due enqueue

### E2E

- ログイン
- Xアカウント追加
- 機能選択
- 確認のみ実行
- 予約作成
- 履歴確認

### Production Smoke

- `/api/health`
- `/console`
- `/api/accounts`
- `/api/console/features`
- `/api/scheduled-actions`
- worker container up
- scheduler log
- worker restart recovery
- live readonly smoke

## セキュリティ

- cookieは必ず暗号化保存する
- job payloadにcookieを入れない
- logsにcookie / token / DM本文を出さない
- DM本文はoperation configに保存しない。保存する場合はpreviewのみ
- account delete時は関連scheduleをpauseまたは削除する
- live actionは確認モーダルを出す
- 大量実行の上限を設定する

## UI品質基準

- すべて日本語
- 1画面に説明文を詰め込みすぎない
- 機能説明は1行から2行
- ボタン文言は短くする
- 状態表示は `未連携`, `確認のみ`, `予約済み`, `実行中`, `完了`, `失敗`
- 失敗時は原因と次の操作を出す
- クリックできるものは見た目で分かる
- 履歴は機能別、アカウント別に絞れる

## 受け入れ条件

- ユーザーが `/console` から全カテゴリを見られる
- 各機能をクリックすると概要、設定、予約、履歴が見える
- Xアカウントを2つ以上登録できる
- 実行時にアカウントを選べる
- 予約がDBに残り、再起動後も実行される
- 予約実行がOperation履歴に残る
- 失敗した実行の理由が見える
- workerが停止しても、再起動後に未実行予約を拾う
- session expiredのアカウントがUIで分かる
- 本番CoolifyでAPI / worker / schedulerが起動する
- 実Xアカウント2件でlive readonly smokeが通る

## 現在の実装状況

2026-05-22時点で、次は実装済み。

- `/console` の日本語コンソール
- `/dashboard` から `/console` への導線
- `/classic-dashboard` に旧ダッシュボードを退避
- Feature Catalog 47機能
- 各機能の設定、予約、履歴タブ
- select / multiSelectによる日本語選択肢
- DM送信を専用 `sendDM` workerへ接続
- 全カタログ機能のworker到達性監査
- `XAccount` による複数アカウント管理
- account CRUD / verify / default
- 最大2アカウントの明示選択
- アカウント別履歴、アカウント別予約フィルタ
- session expired表示と関連schedule pause
- `ScheduledAction` / `ScheduledActionRun`
- once / daily / weekly / interval / cron
- pause / resume / run-now
- scheduler loop
- stale lock recovery
- worker restart recovery smoke
- live action確認モーダル
- queue payloadからcookie / token / DM本文を除外
- legacy DM履歴の本文redaction
- legacy operation responseのredaction
- headless Chromium smoke
- Coolify本番デプロイ

2026-05-22時点で残っている完了ゲート。

- 本番の `test_account_20260521092255` に実Xアカウントが0件のため、実Xアカウント2件を使う `live readonly smoke` は未実行

実Xアカウント2件を登録したら、次で最終確認する。

```bash
api="$(docker ps --format '{{.Names}}' | grep '^api-sg008w80csw08skkwcwswwgw' | head -n 1)"
docker cp "$api":/app/scripts/run-console-live-readonly-host.sh /tmp/xactions-live-readonly.sh
XACTIONS_LIVE_READONLY_SOURCE='existing' bash /tmp/xactions-live-readonly.sh
```

Cookieから登録する場合は、次の手順書を使う。

- `docs/console-live-smoke.md`

## 最短MVP

まず次だけ実装すれば、体験は大きく改善する。

1. `/console` 新設
2. Feature Catalog初期版
3. `XAccount` 追加
4. `targetEngage` と `sendDM` のaccountId対応
5. `ScheduledAction` 追加
6. 1回だけ予約と毎日予約
7. 機能別履歴

現在はMVPを超えて、全カテゴリ接続、複数アカウント、永続スケジュール、本番スモークまで進んでいる。最終完了には実Xアカウント2件でのlive readonly確認が必要。
