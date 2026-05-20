import browserAutomation from '../../browserAutomation.js';

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Run a small, explicit action set against one target user.
 * Supported actions: like latest posts, follow, send one DM.
 */
async function targetEngageBrowser(userId, config, updateProgress, isCancelled = () => false) {
  const {
    targetUsername,
    likeCount = 0,
    follow = false,
    dmMessage = '',
    dryRun = true,
    delayMs = 3000,
    sessionCookie,
  } = config;

  const username = normalizeUsername(targetUsername);
  if (!username) throw new Error('targetUsername is required');
  if (!sessionCookie) throw new Error('Session cookie is required');

  const page = await browserAutomation.createPage(sessionCookie);

  try {
    await browserAutomation.navigateToTwitter(page);

    const isAuthenticated = await browserAutomation.checkAuthentication(page);
    if (!isAuthenticated) {
      throw new Error('Session expired - please reconnect your X account');
    }

    const result = {
      success: true,
      targetUsername: username,
      dryRun: !!dryRun,
      liked: [],
      followed: null,
      dm: null,
      failed: [],
      cancelled: false,
    };

    const maxLikes = Math.min(Math.max(Number(likeCount) || 0, 0), 10);
    if (maxLikes > 0) {
      updateProgress(`Fetching latest posts from @${username}`);
      const tweets = await browserAutomation.getUserTweets(page, username, maxLikes);
      updateProgress(`Found ${tweets.length} posts from @${username}`);

      for (let index = 0; index < tweets.length; index++) {
        if (isCancelled()) {
          result.cancelled = true;
          updateProgress('Job cancelled by user');
          break;
        }

        const tweet = tweets[index];
        updateProgress(`${dryRun ? 'Checking' : 'Liking'} post ${index + 1}/${tweets.length}`);

        if (dryRun) {
          result.liked.push({
            id: tweet.id,
            url: tweet.url,
            dryRun: true,
          });
        } else {
          const likeResult = await browserAutomation.likePost(page, tweet.url);
          if (likeResult.success) {
            result.liked.push({
              id: tweet.id,
              url: tweet.url,
              alreadyLiked: !!likeResult.alreadyLiked,
            });
          } else {
            result.failed.push({
              action: 'like',
              id: tweet.id,
              url: tweet.url,
              error: likeResult.error || 'Like failed',
            });
          }
          await browserAutomation.randomDelay(delayMs, delayMs + 2000);
        }
      }
    }

    if (!result.cancelled && follow) {
      updateProgress(`${dryRun ? 'Checking follow target' : `Following @${username}`}`);
      if (dryRun) {
        result.followed = { username, dryRun: true };
      } else {
        const followResult = await browserAutomation.followUser(page, username);
        if (followResult.success) {
          result.followed = {
            username,
            alreadyFollowing: !!followResult.alreadyFollowing,
            followed: !!followResult.followed,
          };
        } else {
          result.failed.push({
            action: 'follow',
            username,
            error: followResult.error || 'Follow failed',
          });
        }
        await browserAutomation.randomDelay(delayMs, delayMs + 2000);
      }
    }

    if (!result.cancelled && String(dmMessage || '').trim()) {
      updateProgress(`${dryRun ? 'Checking DM target' : `Sending DM to @${username}`}`);
      if (dryRun) {
        result.dm = {
          username,
          messagePreview: String(dmMessage).slice(0, 100),
          dryRun: true,
        };
      } else {
        const dmResult = await browserAutomation.sendDM(page, username, dmMessage);
        if (dmResult.success) {
          result.dm = {
            username,
            sent: true,
            messagePreview: String(dmMessage).slice(0, 100),
          };
        } else {
          result.failed.push({
            action: 'dm',
            username,
            error: dmResult.error || 'DM failed',
          });
        }
      }
    }

    updateProgress(result.cancelled ? 'Cancelled' : 'Target actions finished');
    return result;
  } finally {
    await page.close();
  }
}

export { targetEngageBrowser };
