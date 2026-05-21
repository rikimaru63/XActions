import { describe, expect, it } from 'vitest';
import { getFeatureById, getPublicFeatureCatalog } from '../api/config/features.js';
import { shouldSerializeAccountJob } from '../api/services/accountExecutionLock.js';
import { explicitAccountIdsFromBody } from '../api/services/accountSelection.js';
import { isSessionExpiredError } from '../api/services/accountStore.js';
import { createActionPayload } from '../api/services/consoleActions.js';
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

  it('connects posting actions without storing full post text in operation config', () => {
    for (const id of ['postTweet', 'postThread', 'createPoll']) {
      expect(getFeatureById(id)).toMatchObject({
        status: 'available',
        consoleAction: id,
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
