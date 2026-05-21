const hiddenConfigKeys = new Set([
  'comment',
  'comments',
  'cookie',
  'dmMessage',
  'encryptedRetryConfig',
  'message',
  'options',
  'previews',
  'question',
  'questionPreview',
  'sessionCookie',
  'text',
  'textPreview',
  'token',
  'tweets',
]);

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

    case 'exportDMs': {
      const conversationUrl = String(config.conversationUrl || '').trim();
      const limit = asNumber(config.limit, 100, 1, 500);
      const format = String(config.format || 'json').trim().toLowerCase() === 'csv' ? 'csv' : 'json';

      return {
        operationType: 'exportDMs',
        operationConfig: {
          sourceFeatureId: feature.id,
          hasConversationUrl: !!conversationUrl,
          limit,
          format,
          dryRun: true,
        },
        jobConfig: {
          conversationUrl,
          limit,
          format,
          dryRun: true,
        },
      };
    }

    case 'followerScan': {
      const username = normalizeUsername(config.username);
      const limit = asNumber(config.limit, 5000, 50, 5000);

      return {
        operationType: 'followerScan',
        operationConfig: {
          sourceFeatureId: feature.id,
          username,
          limit,
          dryRun: true,
        },
        jobConfig: {
          username,
          limit,
          dryRun: true,
        },
      };
    }

    case 'getSpaces': {
      const requestedMode = String(config.mode || 'live').trim().toLowerCase();
      const mode = ['live', 'scheduled', 'scrape'].includes(requestedMode) ? requestedMode : 'live';
      const topic = String(config.topic || '').trim();
      const username = normalizeUsername(config.username);
      const spaceUrl = String(config.spaceUrl || '').trim();
      const limit = asNumber(config.limit, 20, 1, 100);
      if (mode === 'scrape' && !spaceUrl) throw new Error('Space URLを入力してください。');

      const operationType = mode === 'scheduled'
        ? 'getScheduledSpaces'
        : mode === 'scrape'
          ? 'scrapeSpace'
          : 'getLiveSpaces';

      return {
        operationType,
        operationConfig: {
          sourceFeatureId: feature.id,
          mode,
          topic,
          username,
          hasSpaceUrl: !!spaceUrl,
          limit,
          dryRun: true,
        },
        jobConfig: {
          mode,
          topic,
          username,
          spaceUrl,
          limit,
          dryRun: true,
        },
      };
    }

    case 'analyzeSentiment': {
      const text = String(config.text || '').trim().slice(0, 10000);
      const requestedMode = String(config.mode || 'rules').trim().toLowerCase();
      const mode = requestedMode === 'llm' ? 'llm' : 'rules';
      if (!text) throw new Error('分析するテキストを入力してください。');

      return {
        operationType: 'analyzeSentiment',
        operationConfig: {
          sourceFeatureId: feature.id,
          textLength: text.length,
          mode,
          dryRun: true,
        },
        jobConfig: {
          text,
          mode,
          dryRun: true,
        },
      };
    }

    case 'priceCorrelation': {
      const tweets = parseJson(config.tweets);
      const tokenId = String(config.tokenId || '').trim();
      const network = String(config.network || '').trim();
      const poolAddress = String(config.poolAddress || '').trim();
      const windows = String(config.windows || '1,24')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0)
        .slice(0, 8);

      if (!Array.isArray(tweets) || tweets.length === 0) {
        throw new Error('投稿データJSONを配列で入力してください。');
      }
      if (!tokenId && !(network && poolAddress)) {
        throw new Error('CoinGecko ID、または network と poolAddress を入力してください。');
      }

      const normalizedTweets = tweets.slice(0, 5000).map((tweet) => {
        const rawTimestamp = tweet.timestamp ?? tweet.date ?? tweet.createdAt ?? '';
        const numericTimestamp = Number(rawTimestamp);
        return {
          timestamp: Number.isFinite(numericTimestamp) ? numericTimestamp : Date.parse(String(rawTimestamp)),
          text: String(tweet.text || ''),
          url: tweet.url ? String(tweet.url) : undefined,
        };
      }).filter((tweet) => Number.isFinite(tweet.timestamp) && tweet.text);

      if (!normalizedTweets.length) {
        throw new Error('timestamp と text を含む投稿データを入力してください。');
      }

      return {
        operationType: 'priceCorrelation',
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetCount: normalizedTweets.length,
          tokenId,
          network,
          hasPoolAddress: !!poolAddress,
          windows: windows.length ? windows : [1, 24],
          dryRun: true,
        },
        jobConfig: {
          tweets: normalizedTweets,
          tokenId,
          network,
          poolAddress,
          windows: windows.length ? windows : [1, 24],
          dryRun: true,
        },
      };
    }

    case 'datasets': {
      const requestedAction = String(config.action || 'list').trim().toLowerCase();
      const action = ['list', 'get', 'export'].includes(requestedAction) ? requestedAction : 'list';
      const name = String(config.name || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '');
      const format = String(config.format || 'json').trim().toLowerCase();
      const offset = asNumber(config.offset, 0, 0, 100000);
      const limit = asNumber(config.limit, 100, 1, 1000);
      if (action !== 'list' && !name) throw new Error('データセット名を入力してください。');

      return {
        operationType: 'datasets',
        operationConfig: {
          sourceFeatureId: feature.id,
          action,
          name,
          format,
          offset,
          limit,
          dryRun: true,
        },
        jobConfig: {
          action,
          name,
          format,
          offset,
          limit,
          dryRun: true,
        },
      };
    }

    case 'monitorSnapshot': {
      const target = String(config.target || '').trim();
      const requestedType = String(config.monitorType || config.type || 'mentions').trim().toLowerCase();
      const monitorType = ['mentions', 'keyword', 'replies'].includes(requestedType) ? requestedType : 'mentions';
      const limit = asNumber(config.limit, 20, 1, 100);
      const requestedMode = String(config.sentimentMode || 'rules').trim().toLowerCase();
      const sentimentMode = requestedMode === 'llm' ? 'llm' : 'rules';
      if (!target) throw new Error('監視対象を入力してください。');

      return {
        operationType: 'monitorSnapshot',
        operationConfig: {
          sourceFeatureId: feature.id,
          target,
          monitorType,
          limit,
          sentimentMode,
          dryRun: true,
        },
        jobConfig: {
          target,
          monitorType,
          limit,
          sentimentMode,
          dryRun: true,
        },
      };
    }

    case 'runWorkflow': {
      const requestedAction = String(config.action || 'list').trim().toLowerCase();
      const action = ['list', 'actions', 'run', 'runs'].includes(requestedAction) ? requestedAction : 'list';
      const workflowId = String(config.workflowId || '').trim();
      const context = parseJson(config.context) || {};
      const limit = asNumber(config.limit, 20, 1, 100);
      if ((action === 'run' || action === 'runs') && !workflowId) {
        throw new Error('ワークフローIDを入力してください。');
      }

      return {
        operationType: 'runWorkflow',
        operationConfig: {
          sourceFeatureId: feature.id,
          action,
          workflowId,
          hasContext: Object.keys(context).length > 0,
          limit,
          dryRun,
        },
        jobConfig: {
          action,
          workflowId,
          context,
          limit,
          dryRun,
        },
      };
    }

    case 'agentCommand': {
      const requestedAction = String(config.action || 'status').trim().toLowerCase();
      const action = ['status', 'config', 'schedule', 'report', 'content', 'score', 'start', 'stop'].includes(requestedAction)
        ? requestedAction
        : 'status';
      const text = String(config.text || '').trim().slice(0, 10000);
      const days = asNumber(config.days, 30, 1, 90);
      const limit = asNumber(config.limit, 20, 1, 100);
      if (action === 'score' && !text) throw new Error('スコア対象テキストを入力してください。');

      return {
        operationType: 'agentCommand',
        operationConfig: {
          sourceFeatureId: feature.id,
          action,
          hasText: !!text,
          days,
          limit,
          dryRun,
        },
        jobConfig: {
          action,
          text,
          days,
          limit,
          dryRun,
        },
      };
    }

    case 'portability': {
      const requestedAction = String(config.action || 'exports').trim().toLowerCase();
      const action = ['exports', 'export', 'migrate', 'diff'].includes(requestedAction) ? requestedAction : 'exports';
      const username = normalizeUsername(config.username);
      const formats = String(config.formats || 'json,csv,md')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => ['json', 'csv', 'md'].includes(item));
      const only = String(config.only || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const limit = asNumber(config.limit, 500, 1, 5000);
      const platform = String(config.platform || '').trim().toLowerCase();
      const exportDir = String(config.exportDir || '').trim();
      const dirA = String(config.dirA || '').trim();
      const dirB = String(config.dirB || '').trim();

      if (action === 'migrate' && !platform) throw new Error('移行先を入力してください。');
      if (action === 'diff' && (!dirA || !dirB)) throw new Error('比較する2つのディレクトリを入力してください。');

      return {
        operationType: 'portability',
        operationConfig: {
          sourceFeatureId: feature.id,
          action,
          username,
          formats: formats.length ? formats : ['json', 'csv', 'md'],
          only,
          limit,
          platform,
          hasExportDir: !!exportDir,
          hasDiffDirs: !!(dirA && dirB),
          dryRun,
        },
        jobConfig: {
          action,
          username,
          formats: formats.length ? formats : ['json', 'csv', 'md'],
          only,
          limit,
          platform,
          exportDir,
          dirA,
          dirB,
          dryRun,
        },
      };
    }

    case 'extractVideo': {
      const tweetUrl = String(config.tweetUrl || '').trim();
      if (!tweetUrl) throw new Error('投稿URLを入力してください。');

      return {
        operationType: 'extractVideo',
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetUrl,
          dryRun: true,
        },
        jobConfig: {
          tweetUrl,
          dryRun: true,
        },
      };
    }

    case 'unrollThread': {
      const tweetUrl = String(config.tweetUrl || '').trim();
      const requestedFormat = String(config.format || 'text').trim().toLowerCase();
      const format = ['text', 'markdown', 'json'].includes(requestedFormat) ? requestedFormat : 'text';
      const maxTweets = asNumber(config.maxTweets, 100, 1, 100);
      if (!tweetUrl) throw new Error('投稿URLを入力してください。');

      return {
        operationType: 'unrollThread',
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetUrl,
          format,
          maxTweets,
          dryRun: true,
        },
        jobConfig: {
          tweetUrl,
          format,
          maxTweets,
          dryRun: true,
        },
      };
    }

    case 'postTweet': {
      const text = String(config.text || '').trim().slice(0, 25000);
      const replyTo = String(config.replyTo || '').trim();
      if (!text) throw new Error('本文を入力してください。');

      return {
        operationType: 'postTweet',
        operationConfig: {
          sourceFeatureId: feature.id,
          textLength: text.length,
          hasReplyTo: !!replyTo,
          dryRun,
        },
        jobConfig: {
          text,
          replyTo,
          dryRun,
        },
      };
    }

    case 'postThread': {
      const tweets = Array.isArray(config.tweets)
        ? config.tweets
        : String(config.tweets || '').split(/\n-{3,}\n/g);
      const cleaned = tweets
        .map((item) => String(typeof item === 'string' ? item : item?.text || '').trim())
        .filter(Boolean)
        .slice(0, 25);
      if (cleaned.length < 2) throw new Error('スレッドは2件以上の本文を入力してください。');

      return {
        operationType: 'postThread',
        operationConfig: {
          sourceFeatureId: feature.id,
          tweetCount: cleaned.length,
          dryRun,
        },
        jobConfig: {
          tweets: cleaned,
          dryRun,
        },
      };
    }

    case 'createPoll': {
      const question = String(config.question || '').trim().slice(0, 280);
      const options = Array.isArray(config.options)
        ? config.options
        : String(config.options || '').split(/\r?\n/g);
      const cleanedOptions = options
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 4);
      const durationMinutes = asNumber(config.durationMinutes, 1440, 5, 10080);
      if (!question) throw new Error('質問を入力してください。');
      if (cleanedOptions.length < 2) throw new Error('選択肢は2件以上入力してください。');

      return {
        operationType: 'createPoll',
        operationConfig: {
          sourceFeatureId: feature.id,
          questionLength: question.length,
          optionCount: cleanedOptions.length,
          durationMinutes,
          dryRun,
        },
        jobConfig: {
          question,
          options: cleanedOptions,
          durationMinutes,
          dryRun,
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
