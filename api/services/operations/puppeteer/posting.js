import browserAutomation from '../../browserAutomation.js';
import {
  createPoll as createPollPost,
  postThread as publishThread,
  postTweet as publishTweet,
} from '../../../../src/postComposer.js';

function preview(text, length = 120) {
  return String(text || '').trim().slice(0, length);
}

async function createAuthenticatedPage(sessionCookie) {
  if (!sessionCookie) throw new Error('Session cookie is required');

  const page = await browserAutomation.createPage(sessionCookie);
  await browserAutomation.navigateToTwitter(page);
  const isAuthenticated = await browserAutomation.checkAuthentication(page);
  if (!isAuthenticated) {
    await page.close().catch(() => {});
    throw new Error('Session expired - please reconnect your X account');
  }

  return page;
}

async function postTweetBrowser(userId, config) {
  const text = String(config.text || '').trim();
  if (!text) throw new Error('text is required');

  if (config.dryRun === true || config.dryRun === 'true') {
    return {
      success: true,
      dryRun: true,
      textPreview: preview(text),
      textLength: text.length,
    };
  }

  const page = await createAuthenticatedPage(config.sessionCookie);
  try {
    return await publishTweet(page, text, {
      replyTo: config.replyTo || null,
    });
  } finally {
    await page.close();
  }
}

async function postThreadBrowser(userId, config) {
  const tweets = Array.isArray(config.tweets)
    ? config.tweets.map((item) => (typeof item === 'string' ? item : item?.text)).map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (tweets.length < 2) throw new Error('Thread requires at least 2 posts');

  if (config.dryRun === true || config.dryRun === 'true') {
    return {
      success: true,
      dryRun: true,
      tweetCount: tweets.length,
      tweets: tweets.map((text, index) => ({
        index: index + 1,
        textPreview: preview(text, 80),
        textLength: text.length,
      })),
    };
  }

  const page = await createAuthenticatedPage(config.sessionCookie);
  try {
    return await publishThread(page, tweets);
  } finally {
    await page.close();
  }
}

async function createPollBrowser(userId, config) {
  const question = String(config.question || '').trim();
  const options = Array.isArray(config.options)
    ? config.options.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!question) throw new Error('question is required');
  if (options.length < 2 || options.length > 4) throw new Error('Poll requires 2-4 options');

  if (config.dryRun === true || config.dryRun === 'true') {
    return {
      success: true,
      dryRun: true,
      questionPreview: preview(question),
      optionCount: options.length,
      options: options.map((item) => preview(item, 60)),
      durationMinutes: Number(config.durationMinutes) || 1440,
    };
  }

  const page = await createAuthenticatedPage(config.sessionCookie);
  try {
    return await createPollPost(page, question, options, {
      duration: `${Number(config.durationMinutes) || 1440}m`,
    });
  } finally {
    await page.close();
  }
}

export {
  createPollBrowser,
  postThreadBrowser,
  postTweetBrowser,
};
