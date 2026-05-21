import { readFileSync } from 'fs';
import { features, featureCategories, getPublicFeatureCatalog } from '../api/config/features.js';
import { createActionPayload } from '../api/services/consoleActions.js';
import { calculateNextRunAt } from '../api/services/scheduleUtils.js';

const verbose = process.env.XACTIONS_AUDIT_VERBOSE === 'true';

const sampleConfigByFeature = {
  targetEngage: {
    targetUsername: 'target_user',
    likeCount: 1,
    follow: false,
    dmMessage: 'secret-dm-body',
  },
  sendDM: {
    username: 'target_user',
    message: 'secret-dm-body',
  },
  likeTweet: {
    tweetUrl: 'https://x.com/source/status/1234567890',
  },
  unlikeTweet: {
    tweetUrl: 'https://x.com/source/status/1234567890',
  },
  replyToTweet: {
    tweetUrl: 'https://x.com/source/status/1234567890',
    text: 'secret-reply-body',
  },
  bookmarkTweet: {
    tweetUrl: 'https://x.com/source/status/1234567890',
  },
  autoLike: {
    query: 'xactions',
    maxLikes: 1,
  },
  followEngagers: {
    tweetUrl: 'https://x.com/source/status/1234567890',
    engagementType: 'likes',
    maxFollows: 1,
  },
  keywordFollow: {
    query: 'xactions',
    maxFollows: 1,
  },
  autoComment: {
    query: 'xactions',
    comment: 'secret-comment-body',
    maxComments: 1,
  },
  detectUnfollowers: {
    username: 'source_account',
    maxUsers: 50,
  },
  unfollowNonFollowers: {
    username: 'source_account',
    maxUsers: 50,
    limit: 1,
  },
  unfollowEveryone: {
    username: 'source_account',
    maxUsers: 50,
    limit: 1,
  },
  postTweet: {
    text: 'secret-post-body',
  },
  postThread: {
    tweets: 'secret-thread-post-one\n---\nsecret-thread-post-two',
  },
  createPoll: {
    question: 'poll question',
    options: 'Option A\nOption B',
    durationMinutes: 60,
  },
  schedulePost: {
    text: 'secret-scheduled-post-body',
  },
  deleteTweet: {
    tweetUrl: 'https://x.com/source/status/1234567890',
  },
  conversations: {
    limit: 1,
  },
  exportDMs: {
    limit: 1,
    format: 'json',
  },
  followerScan: {
    username: 'source_account',
    limit: 50,
  },
  profile: {
    username: 'target_user',
  },
  searchTweets: {
    query: 'xactions',
    limit: 1,
  },
  trends: {
    category: 'global',
  },
  bookmarks: {
    limit: 1,
    format: 'json',
  },
  spaces: {
    mode: 'live',
    topic: 'xactions',
    limit: 1,
  },
  video: {
    tweetUrl: 'https://x.com/source/status/1234567890',
  },
  thread: {
    tweetUrl: 'https://x.com/source/status/1234567890',
    format: 'text',
    maxTweets: 1,
  },
  analytics: {
    text: 'secret-analysis-text',
    mode: 'rules',
  },
  priceCorrelation: {
    tweets: JSON.stringify([{ timestamp: 1710000000000, text: 'secret-market-tweet' }]),
    tokenId: 'bitcoin',
  },
  monitor: {
    target: '@target_user',
    monitorType: 'mentions',
    limit: 1,
  },
  workflows: {
    action: 'list',
    limit: 1,
  },
  agent: {
    action: 'status',
    limit: 1,
  },
  datasets: {
    action: 'list',
    limit: 1,
  },
  portability: {
    action: 'exports',
    limit: 1,
  },
};

const hiddenStringsByFeature = {
  targetEngage: ['secret-dm-body'],
  sendDM: ['secret-dm-body'],
  replyToTweet: ['secret-reply-body'],
  autoComment: ['secret-comment-body'],
  postTweet: ['secret-post-body'],
  postThread: ['secret-thread-post-one', 'secret-thread-post-two'],
  schedulePost: ['secret-scheduled-post-body'],
  analytics: ['secret-analysis-text'],
  priceCorrelation: ['secret-market-tweet'],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function workerProcessors() {
  const source = readFileSync(new URL('../api/services/jobQueue.js', import.meta.url), 'utf8');
  return new Set(
    [...source.matchAll(/operationsQueue\.process\(['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
  );
}

function auditCatalog() {
  const publicCatalog = getPublicFeatureCatalog();
  const consoleFeatures = features.filter((feature) => feature.id !== 'accounts');
  const processors = workerProcessors();
  const categoryIds = new Set(featureCategories.map((category) => category.id));
  const featureIds = new Set();

  assert(featureCategories.length >= 10, 'Expected at least 10 console categories.');
  assert(features.length >= 33, 'Expected at least 33 console features.');

  const missing = [];
  const payloads = [];

  for (const feature of features) {
    if (featureIds.has(feature.id)) missing.push(`${feature.id}: duplicate feature id`);
    featureIds.add(feature.id);
    if (!categoryIds.has(feature.category)) missing.push(`${feature.id}: unknown category ${feature.category}`);
    if (feature.status !== 'available') missing.push(`${feature.id}: status is ${feature.status}`);
  }

  for (const feature of consoleFeatures) {
    if (!feature.consoleAction) missing.push(`${feature.id}: missing consoleAction`);
    if (!feature.supportsSchedule) missing.push(`${feature.id}: missing supportsSchedule`);
    if (!sampleConfigByFeature[feature.id]) missing.push(`${feature.id}: missing audit sample config`);

    const queueType = feature.queueType || feature.operationType;
    if (!processors.has(queueType)) missing.push(`${feature.id}: missing worker processor for ${queueType}`);

    for (const mode of ['dryRun', 'live']) {
      const shouldSucceed = mode === 'live' || feature.supportsDryRun;
      try {
        const payload = createActionPayload(
          feature,
          sampleConfigByFeature[feature.id],
          mode,
          { twitterUsername: 'source_account' }
        );

        if (!shouldSucceed) {
          missing.push(`${feature.id}: ${mode} unexpectedly succeeded`);
          continue;
        }

        if (payload.operationConfig?.sourceFeatureId !== feature.id) {
          missing.push(`${feature.id}: ${mode} sourceFeatureId mismatch`);
        }
        if (!processors.has(payload.operationType)) {
          missing.push(`${feature.id}: ${mode} payload operationType ${payload.operationType} has no worker`);
        }

        const serializedOperationConfig = JSON.stringify(payload.operationConfig || {});
        for (const secret of hiddenStringsByFeature[feature.id] || []) {
          if (serializedOperationConfig.includes(secret)) {
            missing.push(`${feature.id}: ${mode} operationConfig leaks ${secret}`);
          }
        }

        payloads.push({
          id: feature.id,
          mode,
          operationType: payload.operationType,
          sourceFeatureId: payload.operationConfig?.sourceFeatureId || null,
          dryRun: payload.operationConfig?.dryRun,
          accountRequired: !!feature.accountRequired,
        });
      } catch (error) {
        if (shouldSucceed) {
          missing.push(`${feature.id}: ${mode} payload failed: ${error.message}`);
        }
      }
    }
  }

  for (const category of publicCatalog.categories) {
    if (category.available !== category.total) {
      missing.push(`${category.id}: available ${category.available} does not match total ${category.total}`);
    }
  }

  if (missing.length) {
    return {
      ok: false,
      missing,
      payloadCount: payloads.length,
      ...(verbose ? { payloads } : {}),
    };
  }

  return {
    ok: true,
    categoryCount: featureCategories.length,
    featureCount: features.length,
    executableFeatureCount: consoleFeatures.length,
    categories: publicCatalog.categories.map((category) => ({
      id: category.id,
      total: category.total,
      available: category.available,
    })),
    queueTypes: [...new Set(consoleFeatures.map((feature) => feature.queueType || feature.operationType))].sort(),
    payloadCount: payloads.length,
    ...(verbose ? { payloads } : {}),
  };
}

function auditSchedules() {
  return {
    once: calculateNextRunAt(
      { type: 'once', runAt: '2026-05-21T18:00', timezone: 'Asia/Tokyo' },
      new Date('2026-05-21T00:00:00.000Z')
    ).toISOString(),
    daily: calculateNextRunAt(
      { type: 'daily', runAt: '2026-05-21T18:00:00+09:00' },
      new Date('2026-05-21T10:00:00.000Z')
    ).toISOString(),
    weekly: calculateNextRunAt(
      { type: 'weekly', runAt: '2026-05-21T18:00:00+09:00', daysOfWeek: '4' },
      new Date('2026-05-21T10:00:00.000Z')
    ).toISOString(),
    interval: calculateNextRunAt(
      { type: 'interval', intervalMinutes: 15 },
      new Date('2026-05-21T00:00:00.000Z')
    ).toISOString(),
    cron: calculateNextRunAt(
      { type: 'cron', cron: '*/30 * * * *' },
      new Date('2026-05-21T00:01:00.000Z')
    ).toISOString(),
  };
}

function auditUi() {
  const html = readFileSync(new URL('../dashboard/console.html', import.meta.url), 'utf8');
  const requiredSnippets = [
    'id="category-nav"',
    'id="feature-list"',
    'id="settings-panel"',
    'id="schedule-panel"',
    'id="history-panel"',
    'data-tab="settings"',
    'data-tab="schedule"',
    'data-tab="history"',
    'data-schedule-mode="dryRun"',
    'data-schedule-mode="live"',
    '<html lang="ja">',
  ];
  const missing = requiredSnippets.filter((snippet) => !html.includes(snippet));
  return {
    ok: missing.length === 0,
    missing,
  };
}

const catalog = auditCatalog();
const schedules = auditSchedules();
const ui = auditUi();
const result = {
  ok: catalog.ok && ui.ok,
  catalog,
  schedules,
  ui,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
