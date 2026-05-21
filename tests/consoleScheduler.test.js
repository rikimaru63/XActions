import { describe, expect, it } from 'vitest';
import { getFeatureById, getPublicFeatureCatalog } from '../api/config/features.js';
import { shouldSerializeAccountJob } from '../api/services/accountExecutionLock.js';
import {
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
  MAX_ACCOUNT_SELECTION,
} from '../api/services/accountSelection.js';
import { isSessionExpiredError } from '../api/services/accountStore.js';
import { createActionPayload, sanitizeConfig } from '../api/services/consoleActions.js';
import {
  buildEncryptedRetryConfig,
  decryptRetryConfig,
  recoverRetryConfig,
} from '../api/services/consoleRetryConfig.js';
import { summarizeChildStatuses } from '../api/services/operationBatches.js';
import {
  getJobRetryState,
  normalizeScheduleMaxRetries,
  queueAttemptsForSchedule,
} from '../api/services/retryPolicy.js';
import { calculateNextRunAt } from '../api/services/scheduleUtils.js';

describe('console scheduler helpers', () => {
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
    const payload = createActionPayload(
      getFeatureById('sendDM'),
      { username: '@target_user', message: 'hello' },
      'dryRun'
    );

    expect(payload.operationType).toBe('targetEngage');
    expect(payload.operationConfig).toMatchObject({
      sourceFeatureId: 'sendDM',
      targetUsername: 'target_user',
      hasDmMessage: true,
    });
    expect(payload.operationConfig.dmMessage).toBeUndefined();
    expect(payload.jobConfig.dmMessage).toBe('hello');
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

    expect(unavailable).toEqual([]);
    expect(missingAction).toEqual([]);
    expect(catalog.categories.every((category) => category.available === category.total)).toBe(true);
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

  it('detects X session expiration errors', () => {
    expect(isSessionExpiredError(new Error('Session expired - please reconnect your X account'))).toBe(true);
    expect(isSessionExpiredError('X連携情報でログイン状態を確認できませんでした。')).toBe(true);
    expect(isSessionExpiredError(new Error('Like button not found'))).toBe(false);
  });

  it('requires explicit account selection for account actions', () => {
    expect(explicitAccountIdsFromBody({ accountId: 'acc_1' })).toEqual(['acc_1']);
    expect(explicitAccountIdsFromBody({ accountIds: ['acc_1', 'acc_1', ' acc_2 '] })).toEqual(['acc_1', 'acc_2']);
    expect(explicitAccountIdsFromBody({})).toEqual([]);
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2'])).not.toThrow();
    expect(() => assertAccountSelectionLimit(['acc_1', 'acc_2', 'acc_3'])).toThrow(
      `一度に選べるXアカウントは${MAX_ACCOUNT_SELECTION}件までです。`
    );
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
    for (const id of ['getProfile', 'searchTweets', 'getTrends', 'getBookmarks', 'getConversations']) {
      const featureId = {
        getProfile: 'profile',
        searchTweets: 'searchTweets',
        getTrends: 'trends',
        getBookmarks: 'bookmarks',
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
      supportsSchedule: false,
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
    expect(tweet.operationConfig.textPreview).toBeTruthy();
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
    expect(thread.operationConfig.tweets).toBeUndefined();
    expect(thread.jobConfig.tweets).toEqual(['1つ目', '2つ目']);

    const poll = createActionPayload(
      getFeatureById('createPoll'),
      { question: 'どちらですか？', options: 'A\nB', durationMinutes: 60 },
      'dryRun'
    );
    expect(poll.operationConfig).toMatchObject({
      questionPreview: 'どちらですか？',
      optionCount: 2,
      durationMinutes: 60,
      dryRun: true,
    });
    expect(poll.operationConfig.options).toBeUndefined();
    expect(poll.jobConfig.options).toEqual(['A', 'B']);
  });

  it('connects utility collection actions without requiring an X account', () => {
    expect(getFeatureById('video')).toMatchObject({
      status: 'available',
      consoleAction: 'extractVideo',
      accountRequired: false,
      supportsSchedule: false,
    });
    expect(getFeatureById('thread')).toMatchObject({
      status: 'available',
      consoleAction: 'unrollThread',
      accountRequired: false,
      supportsSchedule: false,
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
