import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { features, getFeatureById, getPublicFeatureCatalog } from '../api/config/features.js';
import { shouldSerializeAccountJob } from '../api/services/accountExecutionLock.js';
import {
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
  explicitAccountIdsFromQuery,
  MAX_ACCOUNT_SELECTION,
  operationAccountHistoryWhere,
} from '../api/services/accountSelection.js';
import {
  accountPauseMessage,
  isSessionExpiredError,
  shouldPauseSchedulesForAccountStatus,
} from '../api/services/accountStore.js';
import {
  createActionPayload,
  operationMatchesFeatureHistory,
  sanitizeConfig,
} from '../api/services/consoleActions.js';
import {
  buildEncryptedRetryConfig,
  decryptRetryConfig,
  recoverRetryConfig,
} from '../api/services/consoleRetryConfig.js';
import { summarizeChildStatuses } from '../api/services/operationBatches.js';
import { restoreQueueJobConfig, sanitizeQueueJobData } from '../api/services/queuePayload.js';
import {
  getJobRetryState,
  normalizeScheduleMaxRetries,
  queueAttemptsForSchedule,
} from '../api/services/retryPolicy.js';
import {
  assertScheduleAccountRunnable,
  publicScheduledActionRun,
} from '../api/services/scheduledActions.js';
import { calculateNextRunAt } from '../api/services/scheduleUtils.js';
import {
  evaluateLiveReadiness,
  parseLiveReadinessEnv,
  shouldUseExistingAccounts as shouldUseLiveExistingAccounts,
} from '../scripts/lib/consoleLiveReadiness.js';

describe('console scheduler helpers', () => {
  it('keeps console status labels aligned with the Japanese UI spec', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    for (const label of ['未連携', '確認のみ', '予約済み', '実行中', '完了', '失敗']) {
      expect(html).toContain(label);
    }
    expect(html).toContain("pending: '予約済み'");
    expect(html).toContain("active: '予約済み'");
  });

  it('lets scheduled actions choose dry-run or live mode from the schedule panel', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('data-schedule-mode="dryRun"');
    expect(html).toContain('data-schedule-mode="live"');
    expect(html).toContain('state.mode = button.dataset.scheduleMode');
  });

  it('keeps the mobile detail sheet controlled instead of always open', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('<aside class="detail" id="detail">');
    expect(html).toContain('id="detail-toggle"');
    expect(html).toContain('detailOpen: false');
    expect(html).toContain("els.detail.classList.toggle('open', state.detailOpen)");
    expect(html).toContain("els.detailToggle?.addEventListener('click'");
    expect(html).toContain('inset: auto 0 64px 0;');
    expect(html).toContain('state.detailOpen = true;');
  });

  it('uses an in-console confirmation modal for live and destructive actions', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('id="confirm-modal"');
    expect(html).toContain('function requestConfirmation');
    expect(html).toContain("title: '実行前の確認'");
    expect(html).toContain("title: '実行予約の確認'");
    expect(html).toContain("title: '再実行の確認'");
    expect(html).toContain("title: 'Xアカウントを削除'");
    expect(html).not.toContain('window.confirm');
  });

  it('parses live readonly account selectors consistently', () => {
    const env = {
      XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1, acc_2, acc_1',
      XACTIONS_LIVE_ACCOUNT_A_ID: 'acc_2',
      XACTIONS_LIVE_ACCOUNT_B_ID: 'acc_3',
      XACTIONS_LIVE_ACCOUNT_USERNAMES: '@Primary, SECONDARY',
      XACTIONS_LIVE_ACCOUNT_A_USERNAME: 'secondary',
      XACTIONS_LIVE_ACCOUNT_B_USERNAME: '@Third',
    };

    const parsed = parseLiveReadinessEnv(env);

    expect(parsed.requestedIds).toEqual(['acc_1', 'acc_2', 'acc_3']);
    expect(parsed.requestedUsernames).toEqual(['primary', 'secondary', 'third']);
    expect(parsed.selectorCount).toBe(2);
    expect(shouldUseLiveExistingAccounts(env)).toBe(true);
  });

  it('accepts live readonly only with distinct cookies or one valid existing-account selector', () => {
    const user = { id: 'user_1' };
    const activeAccounts = [
      { id: 'acc_1', username: 'primary', isDefault: true, lastVerifiedAt: new Date() },
      { id: 'acc_2', username: 'secondary', isDefault: false, lastVerifiedAt: new Date() },
    ];

    expect(evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_A_COOKIE: 'auth_token=a',
        XACTIONS_LIVE_ACCOUNT_B_COOKIE: 'auth_token=b',
      },
      user,
      activeAccounts: [],
      smokeUsername: 'smoke',
    }).ready).toBe(true);

    const duplicateCookies = evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_A_COOKIE: 'auth_token=a',
        XACTIONS_LIVE_ACCOUNT_B_COOKIE: 'auth_token=a',
      },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(duplicateCookies.ready).toBe(false);
    expect(duplicateCookies.reasons.join(' ')).toContain('must be different');

    const byIds = evaluateLiveReadiness({
      env: { XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1,acc_2' },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(byIds.ready).toBe(true);
    expect(byIds.readyWithExistingAccounts).toBe(true);

    const mixedSelectors = evaluateLiveReadiness({
      env: {
        XACTIONS_LIVE_ACCOUNT_IDS: 'acc_1,acc_2',
        XACTIONS_LIVE_USE_EXISTING_ACCOUNTS: 'true',
      },
      user,
      activeAccounts,
      smokeUsername: 'smoke',
    });
    expect(mixedSelectors.ready).toBe(false);
    expect(mixedSelectors.reasons.join(' ')).toContain('Use only one existing-account selector');
  });

  it('shows skipped run-now results and opens the run history', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('result.skipped ? (result.error ||');
    expect(html).toContain('await loadScheduleRuns(id);');
  });

  it('shows the next action for failed runs and unavailable accounts', () => {
    const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');

    expect(html).toContain('function accountGuidance');
    expect(html).toContain('function nextActionText');
    expect(html).toContain('function detailWithGuidance');
    expect(html).toContain('次の操作:');
    expect(html).toContain('連携情報を更新して確認してください。');
    expect(html).toContain('前の実行が終わってから再実行してください。');
    expect(html).toContain('設定を見直してから再実行してください。');
    expect(html).toContain('detailWithGuidance(schedule.lastError, schedule.account)');
    expect(html).toContain('detailWithGuidance(operation.error, operation.account)');
    expect(html).toContain('detailWithGuidance(child.error, child.account)');
  });

  it('parses one-time Asia/Tokyo datetime values', () => {
    const nextRunAt = calculateNextRunAt(
      { type: 'once', runAt: '2026-05-21T18:00', timezone: 'Asia/Tokyo' },
      new Date('2026-05-21T00:00:00.000Z')
    );

    expect(nextRunAt.toISOString()).toBe('2026-05-21T09:00:00.000Z');
  });

  it('finds the next simple cron run', () => {
    const nextRunAt = calculateNextRunAt(
      { type: 'cron', cron: '*/30 * * * *' },
      new Date('2026-05-21T00:01:00.000Z')
    );

    expect(nextRunAt.toISOString()).toBe('2026-05-21T00:30:00.000Z');
  });

  it('keeps DM body out of operation config', () => {
    expect(getFeatureById('sendDM')).toMatchObject({
      operationType: 'sendDM',
      queueType: 'sendDM',
      supportsDryRun: false,
    });
    expect(() => createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'dryRun'
    )).toThrow('DM送信は確認のみには対応していません。');

    const payload = createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'live'
    );

    expect(payload.operationType).toBe('sendDM');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'sendDM',
      username: 'target_user',
      hasMessage: true,
      messageLength: 5,
    });
    expect(payload.operationConfig.message).toBeUndefined();
    expect(payload.jobConfig.message).toBe('hello');
  });

  it('exposes X account management inside the console catalog', () => {
    const catalog = getPublicFeatureCatalog();
    const accounts = catalog.features.find((item) => item.id === 'accounts');

    expect(accounts).toMatchObject({
      category: 'settings',
      title: 'X連携',
      status: 'available',
      statusLabel: '利用可能',
    });
  });

  it('marks every catalog feature as available for the unified console', () => {
    const catalog = getPublicFeatureCatalog();
    const unavailable = catalog.features.filter((item) => item.status !== 'available');
    const missingAction = catalog.features.filter((item) => item.id !== 'accounts' && !item.consoleAction);
    const missingSchedule = catalog.features.filter((item) => item.id !== 'accounts' && item.consoleAction && !item.supportsSchedule);

    expect(unavailable).toEqual([]);
    expect(missingAction).toEqual([]);
    expect(missingSchedule).toEqual([]);
    expect(catalog.categories.every((category) => category.available === category.total)).toBe(true);
  });

  it('connects every console queue type to a worker processor', () => {
    const workerSource = readFileSync(new URL('../api/services/jobQueue.js', import.meta.url), 'utf8');
    const processors = new Set(
      [...workerSource.matchAll(/operationsQueue\.process\(['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
    );
    const requiredTypes = [...new Set(features
      .filter((feature) => feature.id !== 'accounts' && feature.consoleAction)
      .map((feature) => feature.queueType || feature.operationType))];

    expect(requiredTypes.filter((type) => !processors.has(type))).toEqual([]);
  });

  it('summarizes multi-account child operations for parent history', () => {
    const summary = summarizeChildStatuses([
      { status: 'completed' },
      { status: 'failed' },
    ]);

    expect(summary).toMatchObject({
      status: 'failed',
      terminal: true,
      error: '1件のアカウントで失敗しました。',
      counts: {
        total: 2,
        completed: 1,
        failed: 1,
      },
    });
  });

  it('serializes only live account jobs', () => {
    expect(shouldSerializeAccountJob({
      accountId: 'acc_1',
      config: { dryRun: false },
    })).toBe(true);

    expect(shouldSerializeAccountJob({
      accountId: 'acc_1',
      config: { dryRun: true },
    })).toBe(false);

    expect(shouldSerializeAccountJob({
      config: { dryRun: false },
    })).toBe(false);
  });

  it('removes session material from queued job payloads', () => {
    const jobData = sanitizeQueueJobData({
      type: 'getProfile',
      operationId: 'op_1',
      userId: 'user_1',
      authMethod: 'oauth',
      config: {
        username: 'source_user',
        sessionCookie: 'auth_token=secret',
        nested: {
          refreshToken: 'refresh-secret',
          keep: 'visible',
        },
      },
    });

    expect(jobData.authMethod).toBe('session');
    expect(jobData.config).toEqual({
      username: 'source_user',
      nested: {
        keep: 'visible',
      },
    });
    expect(JSON.stringify(jobData)).not.toContain('secret');
  });

  it('encrypts user-authored bodies before they reach Bull job data', () => {
    const expectEncryptedConfigField = (jobData, field, secret) => {
      expect(jobData.config[field]).toBeUndefined();
      expect(jobData.encryptedJobConfig).toBeTruthy();
      expect(JSON.stringify(jobData)).not.toContain(secret);
      expect(restoreQueueJobConfig(jobData)[field]).toEqual(secret);
    };

    const sendDmJobData = sanitizeQueueJobData({
      type: 'sendDM',
      operationId: 'op_dm',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        username: 'target_user',
        message: 'private dm body',
        dryRun: false,
      },
    });

    expect(sendDmJobData.config).toEqual({
      username: 'target_user',
      dryRun: false,
    });
    expect(sendDmJobData.encryptedJobConfig).toBeTruthy();
    expect(JSON.stringify(sendDmJobData)).not.toContain('private dm body');
    expect(restoreQueueJobConfig(sendDmJobData)).toMatchObject({
      username: 'target_user',
      message: 'private dm body',
      dryRun: false,
    });

    const targetEngageJobData = sanitizeQueueJobData({
      type: 'targetEngage',
      operationId: 'op_target',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        targetUsername: 'target_user',
        likeCount: 0,
        follow: false,
        dmMessage: 'private target dm',
        dryRun: false,
      },
    });

    expect(targetEngageJobData.config.dmMessage).toBeUndefined();
    expect(JSON.stringify(targetEngageJobData)).not.toContain('private target dm');
    expect(restoreQueueJobConfig(targetEngageJobData).dmMessage).toBe('private target dm');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'postTweet',
      operationId: 'op_post',
      userId: 'user_1',
      accountId: 'account_1',
      config: { text: 'private post body', dryRun: true },
    }), 'text', 'private post body');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'replyToTweet',
      operationId: 'op_reply',
      userId: 'user_1',
      accountId: 'account_1',
      config: { tweetId: '123', text: 'private reply body' },
    }), 'text', 'private reply body');

    expectEncryptedConfigField(sanitizeQueueJobData({
      type: 'autoComment',
      operationId: 'op_comment',
      userId: 'user_1',
      accountId: 'account_1',
      config: { query: 'xactions', comment: 'private comment body', dryRun: false },
    }), 'comment', 'private comment body');

    const pollJobData = sanitizeQueueJobData({
      type: 'createPoll',
      operationId: 'op_poll',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        question: 'private poll question',
        options: ['private poll option a', 'private poll option b'],
      },
    });

    expect(pollJobData.config.question).toBeUndefined();
    expect(pollJobData.config.options).toBeUndefined();
    expect(JSON.stringify(pollJobData)).not.toContain('private poll question');
    expect(JSON.stringify(pollJobData)).not.toContain('private poll option a');
    expect(restoreQueueJobConfig(pollJobData)).toMatchObject({
      question: 'private poll question',
      options: ['private poll option a', 'private poll option b'],
    });

    const workflowJobData = sanitizeQueueJobData({
      type: 'runWorkflow',
      operationId: 'op_workflow',
      userId: 'user_1',
      accountId: 'account_1',
      config: {
        action: 'run',
        workflowId: 'workflow_1',
        context: { prompt: 'private workflow context' },
      },
    });

    expect(workflowJobData.config.context).toBeUndefined();
    expect(JSON.stringify(workflowJobData)).not.toContain('private workflow context');
    expect(restoreQueueJobConfig(workflowJobData).context).toEqual({ prompt: 'private workflow context' });
  });

  it('keeps full DM text out of the legacy messages history config', () => {
    const route = readFileSync(new URL('../api/routes/messages.js', import.meta.url), 'utf8');

    expect(route).toContain('messageLength: String(message).length');
    expect(route).toContain('hasMessage: true');
    expect(route).not.toContain('config: JSON.stringify({ username, message })');
  });

  it('keeps legacy DM route responses user-facing in Japanese', () => {
    const route = readFileSync(new URL('../api/routes/messages.js', import.meta.url), 'utf8');

    for (const text of [
      'X連携が必要です。',
      '送信先と本文を入力してください。',
      'DM送信を予約しました。',
      '会話一覧の取得を予約しました。',
      'DMエクスポートを予約しました。',
    ]) {
      expect(route).toContain(text);
    }

    for (const text of [
      'Twitter account not connected',
      'Username and message are required',
      'DM queued',
      'Conversations fetch queued',
      'DM export queued',
      'Failed to send DM',
    ]) {
      expect(route).not.toContain(text);
    }
  });

  it('keeps legacy and console DM operations visible in the DM history filter', () => {
    expect(operationMatchesFeatureHistory({
      type: 'sendDM',
      config: { hasMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'sendDM',
      config: { sourceFeatureId: 'sendDM', hasMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'targetEngage',
      config: { sourceFeatureId: 'targetEngage', hasDmMessage: true },
    }, 'sendDM')).toBe(true);

    expect(operationMatchesFeatureHistory({
      type: 'targetEngage',
      config: { sourceFeatureId: 'targetEngage', hasDmMessage: false },
    }, 'sendDM')).toBe(false);
  });

  it('detects X session expiration errors', () => {
    expect(isSessionExpiredError(new Error('Session expired - please reconnect your X account'))).toBe(true);
    expect(isSessionExpiredError('X連携情報でログイン状態を確認できませんでした。')).toBe(true);
    expect(isSessionExpiredError(new Error('Like button not found'))).toBe(false);
  });

  it('pauses schedules when an account becomes unavailable', () => {
    expect(shouldPauseSchedulesForAccountStatus('active')).toBe(false);
    expect(shouldPauseSchedulesForAccountStatus('expired')).toBe(true);
    expect(shouldPauseSchedulesForAccountStatus('error')).toBe(true);
    expect(shouldPauseSchedulesForAccountStatus('disabled')).toBe(true);
    expect(accountPauseMessage('disabled')).toBe('Xアカウントを停止したため予約を停止しました。');
  });

  it('requires explicit account selection for account actions', () => {
    expect(explicitAccountIdsFromBody({ accountId: 'acc_1' })).toEqual(['acc_1']);
    expect(explicitAccountIdsFromBody({ accountIds: ['acc_1', 'acc_1', ' acc_2 '] })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromBody({})).toEqual([]);
    expect(explicitAccountIdsFromQuery({ accountId: 'acc_1' })).toEqual(['acc_1']);
    expect(explicitAccountIdsFromQuery({ accountIds: 'acc_1', accountId: 'acc_2' })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromQuery({ accountIds: 'acc_1, acc_2', accountId: 'acc_2' })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromQuery({})).toEqual([]);
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2'])).not.toThrow();
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2', 'acc_3'])).toThrow(
      `一度に選べるXアカウントは${MAX_ACCOUNT_SELECTION}件までです。`
    );
  });

  it('uses one account query parser for history and schedule filters', () => {
    const consoleRoute = readFileSync(new URL('../api/routes/console.js', import.meta.url), 'utf8');
    const scheduleRoute = readFileSync(new URL('../api/routes/scheduled-actions.js', import.meta.url), 'utf8');

    expect(consoleRoute).toContain('explicitAccountIdsFromQuery(req.query)');
    expect(scheduleRoute).toContain('explicitAccountIdsFromQuery(req.query)');
  });

  it('keeps batch parent operations visible when filtering history by account', () => {
    expect(operationAccountHistoryWhere(['acc_1'])).toEqual({
      OR: [
        { accountId: 'acc_1' },
        { childOperations: { some: { accountId: 'acc_1' } } },
      ],
    });

    expect(operationAccountHistoryWhere(['acc_1', 'acc_2'])).toEqual({
      OR: [
        { accountId: { in: ['acc_1', 'acc_2'] } },
        { childOperations: { some: { accountId: { in: ['acc_1', 'acc_2'] } } } },
      ],
    });
  });

  it('stores batch retry inputs encrypted and hides them from history output', () => {
    const retryConfig = {
      message: 'secret dm body',
      text: 'secret post body',
      tweets: 'first\n---\nsecond',
    };
    const stored = buildEncryptedRetryConfig(retryConfig);

    expect(stored.hasRetryConfig).toBe(true);
    expect(stored.encryptedRetryConfig).toBeTruthy();
    expect(stored.encryptedRetryConfig).not.toContain('secret');
    expect(decryptRetryConfig(stored)).toEqual(retryConfig);
    expect(recoverRetryConfig({ ...stored, textPreview: 'secret' }, { text: 'override text' })).toMatchObject({
      message: 'secret dm body',
      text: 'override text',
      tweets: 'first\n---\nsecond',
      textPreview: 'secret',
    });
    expect(sanitizeConfig(stored)).toMatchObject({
      encryptedRetryConfig: '[hidden]',
      hasRetryConfig: true,
    });
  });

  it('connects follower cleanup actions to the console catalog', () => {
    const nonFollowers = getFeatureById('unfollowNonFollowers');
    const everyone = getFeatureById('unfollowEveryone');

    expect(nonFollowers).toMatchObject({
      status: 'available',
      consoleAction: 'unfollowNonFollowers',
      supportsDryRun: true,
      supportsSchedule: true,
    });
    expect(everyone).toMatchObject({
      status: 'available',
      consoleAction: 'unfollowEveryone',
      supportsDryRun: true,
      supportsSchedule: true,
    });
  });

  it('builds safe dry-run payloads for follower cleanup actions', () => {
    const payload = createActionPayload(
      getFeatureById('unfollowNonFollowers'),
      { maxUsers: 200, limit: 10 },
      'dryRun'
    );

    expect(payload.operationType).toBe('unfollowNonFollowers');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'unfollowNonFollowers',
      maxUsers: 200,
      limit: 10,
      dryRun: true,
    });
    expect(payload.jobConfig).toMatchObject({
      maxUsers: 200,
      limit: 10,
      dryRun: true,
    });
  });

  it('connects growth actions with safe console payloads', () => {
    expect(getFeatureById('followEngagers')).toMatchObject({
      status: 'available',
      consoleAction: 'followEngagers',
      supportsDryRun: true,
    });
    expect(getFeatureById('keywordFollow')).toMatchObject({
      status: 'available',
      consoleAction: 'keywordFollow',
      supportsDryRun: true,
    });
    expect(getFeatureById('autoComment')).toMatchObject({
      status: 'available',
      consoleAction: 'autoComment',
      supportsDryRun: true,
    });

    const commentPayload = createActionPayload(
      getFeatureById('autoComment'),
      { query: 'xactions', comment: '確認用コメント', maxComments: 2 },
      'dryRun'
    );

    expect(commentPayload.operationType).toBe('autoComment');
    expect(commentPayload.operationConfig).toMatchObject({
      hasComment: true,
      maxComments: 2,
      dryRun: true,
    });
    expect(commentPayload.operationConfig.comment).toBeUndefined();
    expect(commentPayload.jobConfig.comment).toBe('確認用コメント');
  });

  it('connects read-only collection actions to the console catalog', () => {
    for (const id of [
      'getProfile',
      'getFollowers',
      'getFollowing',
      'getTweets',
      'searchTweets',
      'searchHashtag',
      'getTrends',
      'getExploreFeed',
      'getBookmarks',
      'getMedia',
      'getConversations',
    ]) {
      const featureId = {
        getProfile: 'profile',
        getFollowers: 'followers',
        getFollowing: 'following',
        getTweets: 'tweets',
        searchTweets: 'searchTweets',
        searchHashtag: 'hashtag',
        getTrends: 'trends',
        getExploreFeed: 'explore',
        getBookmarks: 'bookmarks',
        getMedia: 'media',
        getConversations: 'conversations',
      }[id];
      expect(getFeatureById(featureId)).toMatchObject({
        status: 'available',
        consoleAction: id,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for read-only collection actions', () => {
    const profile = createActionPayload(
      getFeatureById('profile'),
      { username: '@target_user' },
      'live'
    );
    expect(profile).toMatchObject({
      operationType: 'getProfile',
      jobConfig: {
        username: 'target_user',
        dryRun: true,
      },
    });

    const followers = createActionPayload(
      getFeatureById('followers'),
      { username: '@target_user', limit: 20 },
      'dryRun'
    );
    expect(followers).toMatchObject({
      operationType: 'getFollowers',
      jobConfig: {
        username: 'target_user',
        limit: 20,
        dryRun: true,
      },
    });

    const following = createActionPayload(
      getFeatureById('following'),
      { username: '@target_user', limit: 25 },
      'live'
    );
    expect(following).toMatchObject({
      operationType: 'getFollowing',
      operationConfig: {
        sourceFeatureId: 'following',
        username: 'target_user',
        limit: 25,
        dryRun: true,
      },
    });

    const tweets = createActionPayload(
      getFeatureById('tweets'),
      { username: '@target_user', limit: 15, includeReplies: 'true' },
      'dryRun'
    );
    expect(tweets).toMatchObject({
      operationType: 'getTweets',
      operationConfig: {
        sourceFeatureId: 'tweets',
        username: 'target_user',
        limit: 15,
        includeReplies: true,
        dryRun: true,
      },
    });

    const search = createActionPayload(
      getFeatureById('searchTweets'),
      { query: 'xactions', limit: 5, filter: 'top' },
      'dryRun'
    );
    expect(search).toMatchObject({
      operationType: 'searchTweets',
      jobConfig: {
        query: 'xactions',
        limit: 5,
        filter: 'top',
        dryRun: true,
      },
    });

    const hashtag = createActionPayload(
      getFeatureById('hashtag'),
      { hashtag: '#xactions', limit: 30, filter: 'top' },
      'dryRun'
    );
    expect(hashtag).toMatchObject({
      operationType: 'searchHashtag',
      operationConfig: {
        sourceFeatureId: 'hashtag',
        hashtag: 'xactions',
        limit: 30,
        filter: 'top',
        dryRun: true,
      },
    });

    const explore = createActionPayload(
      getFeatureById('explore'),
      { tab: 'news', limit: 10 },
      'dryRun'
    );
    expect(explore).toMatchObject({
      operationType: 'getExploreFeed',
      operationConfig: {
        sourceFeatureId: 'explore',
        tab: 'news',
        limit: 10,
        dryRun: true,
      },
    });

    const media = createActionPayload(
      getFeatureById('media'),
      { username: '@target_user', limit: 12, type: 'videos' },
      'dryRun'
    );
    expect(media).toMatchObject({
      operationType: 'getMedia',
      operationConfig: {
        sourceFeatureId: 'media',
        username: 'target_user',
        limit: 12,
        type: 'videos',
        dryRun: true,
      },
    });
  });

  it('connects legacy route-backed actions to the console catalog', () => {
    for (const [id, action] of [
      ['exportDMs', 'exportDMs'],
      ['followerScan', 'followerScan'],
      ['spaces', 'getSpaces'],
      ['analytics', 'analyzeSentiment'],
      ['priceCorrelation', 'priceCorrelation'],
      ['datasets', 'datasets'],
    ]) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: action,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for legacy route-backed actions', () => {
    const exportDms = createActionPayload(
      getFeatureById('exportDMs'),
      { conversationUrl: 'https://x.com/messages/1-2', limit: 50, format: 'csv' },
      'dryRun'
    );
    expect(exportDms).toMatchObject({
      operationType: 'exportDMs',
      operationConfig: {
        sourceFeatureId: 'exportDMs',
        hasConversationUrl: true,
        limit: 50,
        format: 'csv',
        dryRun: true,
      },
      jobConfig: {
        conversationUrl: 'https://x.com/messages/1-2',
        limit: 50,
        format: 'csv',
        dryRun: true,
      },
    });

    const scan = createActionPayload(
      getFeatureById('followerScan'),
      { username: '@source_user', limit: 250 },
      'live'
    );
    expect(scan).toMatchObject({
      operationType: 'followerScan',
      operationConfig: {
        username: 'source_user',
        limit: 250,
        dryRun: true,
      },
    });

    const spaces = createActionPayload(
      getFeatureById('spaces'),
      { mode: 'scheduled', username: '@host_user', limit: 10 },
      'dryRun'
    );
    expect(spaces).toMatchObject({
      operationType: 'getScheduledSpaces',
      jobConfig: {
        mode: 'scheduled',
        username: 'host_user',
        limit: 10,
        dryRun: true,
      },
    });

    const sentiment = createActionPayload(
      getFeatureById('analytics'),
      { text: 'This is useful', mode: 'rules' },
      'dryRun'
    );
    expect(sentiment.operationType).toBe('analyzeSentiment');
    expect(sentiment.operationConfig.text).toBeUndefined();
    expect(sentiment.operationConfig.textLength).toBe(14);
    expect(sentiment.jobConfig.text).toBe('This is useful');

    const price = createActionPayload(
      getFeatureById('priceCorrelation'),
      {
        tweets: JSON.stringify([{ timestamp: 1710000000000, text: 'hello' }]),
        tokenId: 'bitcoin',
        windows: '1,24',
      },
      'dryRun'
    );
    expect(price.operationConfig).toMatchObject({
      tweetCount: 1,
      tokenId: 'bitcoin',
      windows: [1, 24],
      dryRun: true,
    });
    expect(price.operationConfig.tweets).toBeUndefined();
    expect(price.jobConfig.tweets).toEqual([{ timestamp: 1710000000000, text: 'hello', url: undefined }]);

    const datasets = createActionPayload(
      getFeatureById('datasets'),
      { action: 'get', name: 'sample', offset: 5, limit: 10 },
      'dryRun'
    );
    expect(datasets).toMatchObject({
      operationType: 'datasets',
      jobConfig: {
        action: 'get',
        name: 'sample',
        offset: 5,
        limit: 10,
        dryRun: true,
      },
    });
  });

  it('connects analytics features to the unified console', () => {
    for (const [id, action] of [
      ['engagementAnalysis', 'analyzeEngagement'],
      ['growthHistory', 'growthHistory'],
      ['audienceOverlap', 'audienceOverlap'],
      ['bestPostTime', 'bestPostTime'],
      ['analyticsReport', 'analyticsReport'],
    ]) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: action,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }
  });

  it('builds payloads for analytics features', () => {
    const engagement = createActionPayload(
      getFeatureById('engagementAnalysis'),
      { username: '@target_user', tweetCount: 30, includeReplies: true },
      'dryRun'
    );
    expect(engagement).toMatchObject({
      operationType: 'analyzeEngagement',
      operationConfig: {
        sourceFeatureId: 'engagementAnalysis',
        username: 'target_user',
        tweetCount: 30,
        includeReplies: true,
        dryRun: true,
      },
      jobConfig: {
        username: 'target_user',
        tweetCount: 30,
        includeReplies: true,
        dryRun: true,
      },
    });

    const growth = createActionPayload(
      getFeatureById('growthHistory'),
      { username: '@target_user', days: 90, interval: 'week' },
      'dryRun'
    );
    expect(growth).toMatchObject({
      operationType: 'growthHistory',
      operationConfig: {
        sourceFeatureId: 'growthHistory',
        username: 'target_user',
        days: 90,
        interval: 'week',
        dryRun: true,
      },
    });

    const overlap = createActionPayload(
      getFeatureById('audienceOverlap'),
      { username1: '@target_user', username2: '@source_user', limit: 250 },
      'live'
    );
    expect(overlap).toMatchObject({
      operationType: 'audienceOverlap',
      operationConfig: {
        sourceFeatureId: 'audienceOverlap',
        username1: 'target_user',
        username2: 'source_user',
        limit: 250,
        dryRun: true,
      },
    });

    const bestTime = createActionPayload(
      getFeatureById('bestPostTime'),
      { username: '@target_user', tweetCount: 60 },
      'dryRun'
    );
    expect(bestTime).toMatchObject({
      operationType: 'bestPostTime',
      operationConfig: {
        sourceFeatureId: 'bestPostTime',
        username: 'target_user',
        tweetCount: 60,
        dryRun: true,
      },
    });

    const report = createActionPayload(
      getFeatureById('analyticsReport'),
      { username: '@target_user', tweetCount: 60, days: 14 },
      'dryRun'
    );
    expect(report).toMatchObject({
      operationType: 'analyticsReport',
      operationConfig: {
        sourceFeatureId: 'analyticsReport',
        username: 'target_user',
        tweetCount: 60,
        days: 14,
        dryRun: true,
      },
    });
  });

  it('connects monitor and workflow automation actions to the console catalog', () => {
    expect(getFeatureById('monitor')).toMatchObject({
      status: 'available',
      consoleAction: 'monitorSnapshot',
      operationType: 'monitorSnapshot',
      supportsDryRun: true,
      supportsSchedule: true,
    });
    expect(getFeatureById('workflows')).toMatchObject({
      status: 'available',
      consoleAction: 'runWorkflow',
      operationType: 'runWorkflow',
      supportsDryRun: true,
      supportsSchedule: true,
    });
  });

  it('builds payloads for monitor and workflow automation actions', () => {
    const monitor = createActionPayload(
      getFeatureById('monitor'),
      { target: '@source_user', monitorType: 'replies', limit: 12, sentimentMode: 'rules' },
      'dryRun'
    );
    expect(monitor).toMatchObject({
      operationType: 'monitorSnapshot',
      operationConfig: {
        sourceFeatureId: 'monitor',
        target: '@source_user',
        monitorType: 'replies',
        limit: 12,
        sentimentMode: 'rules',
        dryRun: true,
      },
      jobConfig: {
        target: '@source_user',
        monitorType: 'replies',
        limit: 12,
        sentimentMode: 'rules',
        dryRun: true,
      },
    });

    const workflowPreview = createActionPayload(
      getFeatureById('workflows'),
      { action: 'run', workflowId: 'wf_1', context: '{"keyword":"xactions"}' },
      'dryRun'
    );
    expect(workflowPreview).toMatchObject({
      operationType: 'runWorkflow',
      operationConfig: {
        sourceFeatureId: 'workflows',
        action: 'run',
        workflowId: 'wf_1',
        hasContext: true,
        dryRun: true,
      },
      jobConfig: {
        action: 'run',
        workflowId: 'wf_1',
        context: { keyword: 'xactions' },
        dryRun: true,
      },
    });

    const workflowRun = createActionPayload(
      getFeatureById('workflows'),
      { action: 'run', workflowId: 'wf_1' },
      'live'
    );
    expect(workflowRun.operationConfig.dryRun).toBe(false);
    expect(workflowRun.jobConfig.dryRun).toBe(false);
  });

  it('connects agent and portability actions to the console catalog', () => {
    expect(getFeatureById('agent')).toMatchObject({
      status: 'available',
      consoleAction: 'agentCommand',
      operationType: 'agentCommand',
      accountRequired: true,
      supportsSchedule: true,
    });
    expect(getFeatureById('portability')).toMatchObject({
      status: 'available',
      consoleAction: 'portability',
      operationType: 'portability',
      accountRequired: true,
      supportsSchedule: true,
    });
  });

  it('builds payloads for agent and portability actions', () => {
    const agent = createActionPayload(
      getFeatureById('agent'),
      { action: 'score', text: 'Relevant post text', days: 7, limit: 5 },
      'dryRun'
    );
    expect(agent).toMatchObject({
      operationType: 'agentCommand',
      operationConfig: {
        sourceFeatureId: 'agent',
        action: 'score',
        hasText: true,
        days: 7,
        limit: 5,
        dryRun: true,
      },
      jobConfig: {
        action: 'score',
        text: 'Relevant post text',
        days: 7,
        limit: 5,
        dryRun: true,
      },
    });
    expect(agent.operationConfig.text).toBeUndefined();

    const portability = createActionPayload(
      getFeatureById('portability'),
      { action: 'export', username: '@source_user', formats: 'json,md', only: 'profile,tweets', limit: 100 },
      'live'
    );
    expect(portability).toMatchObject({
      operationType: 'portability',
      operationConfig: {
        sourceFeatureId: 'portability',
        action: 'export',
        username: 'source_user',
        formats: ['json', 'md'],
        only: ['profile', 'tweets'],
        limit: 100,
        dryRun: false,
      },
      jobConfig: {
        action: 'export',
        username: 'source_user',
        formats: ['json', 'md'],
        only: ['profile', 'tweets'],
        limit: 100,
        dryRun: false,
      },
    });

    const diff = createActionPayload(
      getFeatureById('portability'),
      { action: 'diff', dirA: 'older', dirB: 'newer' },
      'dryRun'
    );
    expect(diff.operationConfig).toMatchObject({
      action: 'diff',
      hasDiffDirs: true,
      dryRun: true,
    });
  });

  it('connects posting actions without storing full post text in operation config', () => {
    for (const id of ['postTweet', 'postThread', 'createPoll', 'schedulePost']) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: id === 'schedulePost' ? 'postTweet' : id,
        supportsDryRun: true,
        supportsSchedule: true,
      });
    }

    const tweet = createActionPayload(
      getFeatureById('postTweet'),
      { text: '公開本文'.repeat(30), replyTo: 'https://x.com/a/status/1' },
      'dryRun'
    );
    expect(tweet.operationType).toBe('postTweet');
    expect(tweet.operationConfig.textLength).toBeGreaterThan(0);
    expect(tweet.operationConfig.textPreview).toBeUndefined();
    expect(tweet.operationConfig.text).toBeUndefined();
    expect(tweet.operationConfig.hasReplyTo).toBe(true);
    expect(tweet.jobConfig.text).toContain('公開本文');

    const scheduledTweet = createActionPayload(
      getFeatureById('schedulePost'),
      { text: '予約本文' },
      'dryRun'
    );
    expect(scheduledTweet.operationType).toBe('postTweet');
    expect(scheduledTweet.operationConfig.sourceFeatureId).toBe('schedulePost');
    expect(scheduledTweet.operationConfig.text).toBeUndefined();
    expect(scheduledTweet.jobConfig.text).toBe('予約本文');

    const thread = createActionPayload(
      getFeatureById('postThread'),
      { tweets: '1つ目\n---\n2つ目' },
      'dryRun'
    );
    expect(thread.operationConfig).toMatchObject({
      tweetCount: 2,
      dryRun: true,
    });
    expect(thread.operationConfig.previews).toBeUndefined();
    expect(thread.operationConfig.tweets).toBeUndefined();
    expect(thread.jobConfig.tweets).toEqual(['1つ目', '2つ目']);

    const poll = createActionPayload(
      getFeatureById('createPoll'),
      { question: 'どちらですか？', options: 'A\nB', durationMinutes: 60 },
      'dryRun'
    );
    expect(poll.operationConfig).toMatchObject({
      questionLength: 'どちらですか？'.length,
      optionCount: 2,
      durationMinutes: 60,
      dryRun: true,
    });
    expect(poll.operationConfig.questionPreview).toBeUndefined();
    expect(poll.operationConfig.options).toBeUndefined();
    expect(poll.jobConfig.options).toEqual(['A', 'B']);
  });

  it('connects reply, bookmark, and delete actions for live console execution', () => {
    for (const id of ['replyToTweet', 'bookmarkTweet', 'deleteTweet']) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: id,
        accountRequired: true,
        supportsDryRun: false,
        supportsSchedule: true,
      });
      expect(() => createActionPayload(
        getFeatureById(id),
        {
          tweetUrl: 'https://x.com/source/status/1234567890',
          text: '返信本文',
        },
        'dryRun'
      )).toThrow('確認のみ');
    }

    const reply = createActionPayload(
      getFeatureById('replyToTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890', text: '返信本文' },
      'live'
    );
    expect(reply).toMatchObject({
      operationType: 'replyToTweet',
      operationConfig: {
        sourceFeatureId: 'replyToTweet',
        tweetUrl: 'https://x.com/source/status/1234567890',
        tweetId: '1234567890',
        textLength: '返信本文'.length,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/source/status/1234567890',
        tweetId: '1234567890',
        text: '返信本文',
      },
    });
    expect(reply.operationConfig.text).toBeUndefined();

    const bookmark = createActionPayload(
      getFeatureById('bookmarkTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890' },
      'live'
    );
    expect(bookmark.operationType).toBe('bookmarkTweet');
    expect(bookmark.jobConfig.tweetId).toBe('1234567890');

    const deletion = createActionPayload(
      getFeatureById('deleteTweet'),
      { tweetUrl: 'https://x.com/source/status/1234567890' },
      'live'
    );
    expect(deletion.operationType).toBe('deleteTweet');
    expect(deletion.jobConfig.tweetId).toBe('1234567890');
  });

  it('connects utility collection actions without requiring an X account', () => {
    expect(getFeatureById('video')).toMatchObject({
      status: 'available',
      consoleAction: 'extractVideo',
      accountRequired: false,
      supportsSchedule: true,
    });
    expect(getFeatureById('thread')).toMatchObject({
      status: 'available',
      consoleAction: 'unrollThread',
      accountRequired: false,
      supportsSchedule: true,
    });
  });

  it('builds payloads for utility collection actions', () => {
    const video = createActionPayload(
      getFeatureById('video'),
      { tweetUrl: 'https://x.com/user/status/123' },
      'dryRun'
    );
    expect(video).toMatchObject({
      operationType: 'extractVideo',
      operationConfig: {
        sourceFeatureId: 'video',
        tweetUrl: 'https://x.com/user/status/123',
        dryRun: true,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/user/status/123',
        dryRun: true,
      },
    });

    const thread = createActionPayload(
      getFeatureById('thread'),
      { tweetUrl: 'https://x.com/user/status/456', format: 'markdown', maxTweets: 25 },
      'live'
    );
    expect(thread).toMatchObject({
      operationType: 'unrollThread',
      operationConfig: {
        sourceFeatureId: 'thread',
        tweetUrl: 'https://x.com/user/status/456',
        format: 'markdown',
        maxTweets: 25,
        dryRun: true,
      },
      jobConfig: {
        tweetUrl: 'https://x.com/user/status/456',
        format: 'markdown',
        maxTweets: 25,
        dryRun: true,
      },
    });
  });

  it('maps schedule retry settings to queue attempts', () => {
    expect(normalizeScheduleMaxRetries(undefined)).toBe(2);
    expect(normalizeScheduleMaxRetries(0)).toBe(0);
    expect(normalizeScheduleMaxRetries(99)).toBe(5);
    expect(queueAttemptsForSchedule(0)).toBe(1);
    expect(queueAttemptsForSchedule(2)).toBe(3);
  });

  it('exposes sanitized operation details in scheduled run history', () => {
    const run = publicScheduledActionRun({
      id: 'run_1',
      scheduledActionId: 'schedule_1',
      operationId: 'operation_1',
      status: 'completed',
      scheduledFor: new Date('2026-05-21T00:00:00.000Z'),
      startedAt: new Date('2026-05-21T00:00:01.000Z'),
      finishedAt: new Date('2026-05-21T00:00:02.000Z'),
      createdAt: new Date('2026-05-21T00:00:00.000Z'),
      operation: {
        id: 'operation_1',
        type: 'postTweet',
        status: 'completed',
        config: JSON.stringify({
          sourceFeatureId: 'postTweet',
          text: 'secret post body',
          textPreview: 'public preview',
          sessionCookie: 'auth_token=secret',
        }),
        result: JSON.stringify({ dryRun: true, preview: '投稿プレビュー' }),
        error: null,
        account: {
          id: 'acc_1',
          username: 'source_account',
          encryptedCookie: 'encrypted-secret',
          status: 'active',
          isDefault: true,
        },
      },
    });

    expect(run.operationStatus).toBe('completed');
    expect(run.operationType).toBe('postTweet');
    expect(run.account).toMatchObject({ id: 'acc_1', username: 'source_account' });
    expect(run.account.encryptedCookie).toBeUndefined();
    expect(run.result).toEqual({ dryRun: true, preview: '投稿プレビュー' });
    expect(run.operation.config).toMatchObject({
      sourceFeatureId: 'postTweet',
      text: '[hidden]',
      textPreview: '[hidden]',
      sessionCookie: '[hidden]',
    });
  });

  it('blocks reactivating schedules for unavailable accounts', () => {
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_1',
      account: { username: 'active_account', status: 'active' },
    })).not.toThrow();
    expect(() => assertScheduleAccountRunnable({ accountId: null })).not.toThrow();
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_2',
      account: { username: 'disabled_account', status: 'disabled' },
    })).toThrow('実行できる状態ではありません');
    expect(() => assertScheduleAccountRunnable({
      accountId: 'acc_3',
      account: null,
    })).toThrow('実行できる状態ではありません');
  });

  it('distinguishes retrying jobs from final failures', () => {
    expect(getJobRetryState({ attemptsMade: 1, opts: { attempts: 3 } })).toMatchObject({
      attemptsMade: 1,
      maxAttempts: 3,
      willRetry: true,
      remainingAttempts: 2,
    });

    expect(getJobRetryState({ attemptsMade: 3, opts: { attempts: 3 } })).toMatchObject({
      willRetry: false,
      remainingAttempts: 0,
    });
  });
});
