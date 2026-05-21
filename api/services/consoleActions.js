const hiddenConfigKeys = new Set(['message', 'dmMessage', 'comment', 'comments', 'sessionCookie', 'cookie', 'token']);

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

function asBool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function asNumber(value, fallback, min, max) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.min(Math.max(safe, min), max);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeConfig(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (hiddenConfigKeys.has(key)) return [key, item ? '[hidden]' : item];
    return [key, item];
  }));
}

function sanitizeOperation(operation) {
  const config = sanitizeConfig(parseJson(operation.config));
  const result = parseJson(operation.result);
  const childOperations = Array.isArray(operation.childOperations)
    ? operation.childOperations.map((child) => sanitizeOperation(child))
    : undefined;

  return {
    ...operation,
    config,
    result,
    ...(childOperations ? { childOperations } : {}),
  };
}

function createActionPayload(feature, inputConfig, mode = 'dryRun', user = {}) {
  const config = inputConfig || {};
  const dryRun = mode !== 'live';

  switch (feature.consoleAction) {
    case 'targetEngage': {
      const targetUsername = normalizeUsername(config.targetUsername);
      const likeCount = asNumber(config.likeCount, 0, 0, 10);
      const follow = asBool(config.follow);
      const dmMessage = String(config.dmMessage || '').trim();
      const delayMs = asNumber(config.delayMs, 3000, 2000, 60000);

      if (!targetUsername) throw new Error('対象ユーザーを入力してください。');
      if (likeCount === 0 && !follow && !dmMessage) {
        throw new Error('実行する内容を1つ以上選んでください。');
      }

      return {
        operationType: 'targetEngage',
        operationConfig: {
          sourceFeatureId: feature.id,
          targetUsername,
          likeCount,
          follow,
          hasDmMessage: !!dmMessage,
          dryRun,
          delayMs,
        },
        jobConfig: {
          targetUsername,
          likeCount,
          follow,
          dmMessage,
          dryRun,
          delayMs,
        },
      };
    }

    case 'sendDM': {
      const targetUsername = normalizeUsername(config.username);
      const dmMessage = String(config.message || '').trim();
      const delayMs = asNumber(config.delayMs, 3000, 2000, 60000);

      if (!targetUsername) throw new Error('送信先を入力してください。');
      if (!dmMessage) throw new Error('本文を入力してください。');

      return {
        operationType: 'targetEngage',
        operationConfig: {
          sourceFeatureId: feature.id,
          targetUsername,
          likeCount: 0,
          follow: false,
          hasDmMessage: true,
          dryRun,
          delayMs,
        },
        jobConfig: {
          targetUsername,
          likeCount: 0,
          follow: false,
          dmMessage,
          dryRun,
          delayMs,
        },
      };
    }

    case 'likeTweet':
    case 'unlikeTweet': {
      if (dryRun) {
        throw new Error('この機能は確認のみには対応していません。実行を選んでください。');
      }

      const tweetUrl = String(config.tweetUrl || '').trim();
      const tweetId = String(config.tweetId || '').trim() || tweetUrl.match(/status\/(\d+)/)?.[1];
      if (!tweetUrl && !tweetId) throw new Error('投稿URLを入力してください。');

      return {
        operationType: feature.operationType,
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetUrl,
          tweetId,
        },
        jobConfig: {
          tweetUrl,
          tweetId,
        },
      };
    }

    case 'autoLike': {
      const query = String(config.query || '').trim();
      const targetUsername = normalizeUsername(config.targetUsername);
      const maxLikes = asNumber(config.maxLikes, 10, 1, 50);
      if (!query && !targetUsername) {
        throw new Error('検索語句または対象ユーザーを入力してください。');
      }

      return {
        operationType: 'autoLike',
        operationConfig: {
          sourceFeatureId: feature.id,
          query,
          targetUsername,
          maxLikes,
          dryRun,
        },
        jobConfig: {
          query,
          targetUsername,
          maxLikes,
          dryRun,
        },
      };
    }

    case 'followEngagers': {
      const tweetUrl = String(config.tweetUrl || '').trim();
      const engagementType = String(config.engagementType || '').trim() === 'retweets' ? 'retweets' : 'likes';
      const maxFollows = asNumber(config.maxFollows, 10, 1, 50);
      if (!tweetUrl) throw new Error('ポストURLを入力してください。');

      return {
        operationType: 'followEngagers',
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetUrl,
          engagementType,
          maxFollows,
          dryRun,
        },
        jobConfig: {
          tweetUrl,
          engagementType,
          maxFollows,
          dryRun,
        },
      };
    }

    case 'keywordFollow': {
      const query = String(config.query || '').trim();
      const maxFollows = asNumber(config.maxFollows, 10, 1, 50);
      if (!query) throw new Error('検索語句を入力してください。');

      return {
        operationType: 'keywordFollow',
        operationConfig: {
          sourceFeatureId: feature.id,
          query,
          maxFollows,
          dryRun,
        },
        jobConfig: {
          query,
          maxFollows,
          dryRun,
        },
      };
    }

    case 'autoComment': {
      const query = String(config.query || '').trim();
      const targetUsername = normalizeUsername(config.targetUsername);
      const comment = String(config.comment || '').trim().slice(0, 280);
      const maxComments = asNumber(config.maxComments, 3, 1, 20);
      if (!query && !targetUsername) throw new Error('検索語句または対象ユーザーを入力してください。');
      if (!comment) throw new Error('コメントを入力してください。');

      return {
        operationType: 'autoComment',
        operationConfig: {
          sourceFeatureId: feature.id,
          query,
          targetUsername,
          hasComment: true,
          maxComments,
          dryRun,
        },
        jobConfig: {
          query,
          targetUsername,
          comment,
          maxComments,
          dryRun,
        },
      };
    }

    case 'getProfile': {
      const username = normalizeUsername(config.username);
      if (!username) throw new Error('対象ユーザーを入力してください。');

      return {
        operationType: 'getProfile',
        operationConfig: {
          sourceFeatureId: feature.id,
          username,
          dryRun: true,
        },
        jobConfig: {
          username,
          dryRun: true,
        },
      };
    }

    case 'searchTweets': {
      const query = String(config.query || '').trim();
      const limit = asNumber(config.limit, 30, 1, 100);
      const filter = String(config.filter || 'latest').trim() || 'latest';
      if (!query) throw new Error('検索語句を入力してください。');

      return {
        operationType: 'searchTweets',
        operationConfig: {
          sourceFeatureId: feature.id,
          query,
          limit,
          filter,
          dryRun: true,
        },
        jobConfig: {
          query,
          limit,
          filter,
          dryRun: true,
        },
      };
    }

    case 'getTrends': {
      const category = String(config.category || '').trim();

      return {
        operationType: 'getTrends',
        operationConfig: {
          sourceFeatureId: feature.id,
          category,
          dryRun: true,
        },
        jobConfig: {
          category,
          dryRun: true,
        },
      };
    }

    case 'getBookmarks': {
      const limit = asNumber(config.limit, 50, 1, 200);
      const format = String(config.format || 'json').trim() === 'csv' ? 'csv' : 'json';

      return {
        operationType: 'getBookmarks',
        operationConfig: {
          sourceFeatureId: feature.id,
          limit,
          format,
          dryRun: true,
        },
        jobConfig: {
          limit,
          format,
          dryRun: true,
        },
      };
    }

    case 'getConversations': {
      const limit = asNumber(config.limit, 20, 1, 100);

      return {
        operationType: 'getConversations',
        operationConfig: {
          sourceFeatureId: feature.id,
          limit,
          dryRun: true,
        },
        jobConfig: {
          limit,
          dryRun: true,
        },
      };
    }

    case 'detectUnfollowers': {
      const username = normalizeUsername(config.username || user.twitterUsername);
      const maxUsers = asNumber(config.maxUsers, 1000, 50, 5000);

      return {
        operationType: 'detectUnfollowers',
        operationConfig: {
          sourceFeatureId: feature.id,
          username,
          maxUsers,
          dryRun: true,
        },
        jobConfig: {
          username,
          maxUsers,
          dryRun: true,
        },
      };
    }

    case 'unfollowNonFollowers':
    case 'unfollowEveryone': {
      const username = normalizeUsername(config.username || user.twitterUsername);
      const maxUsers = asNumber(
        config.maxUsers,
        feature.consoleAction === 'unfollowEveryone' ? 500 : 1000,
        50,
        5000
      );
      const limit = asNumber(config.limit || config.maxUnfollows, 20, 1, 100);

      return {
        operationType: feature.operationType,
        operationConfig: {
          sourceFeatureId: feature.id,
          username,
          maxUsers,
          limit,
          dryRun,
        },
        jobConfig: {
          username,
          maxUsers,
          limit,
          dryRun,
        },
      };
    }

    default:
      throw new Error('この機能はまだコンソールから実行できません。');
  }
}

export {
  asBool,
  asNumber,
  createActionPayload,
  hiddenConfigKeys,
  normalizeUsername,
  parseJson,
  sanitizeConfig,
  sanitizeOperation,
};
