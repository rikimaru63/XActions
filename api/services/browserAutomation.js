/**
 * Browser Automation Service
 * 
 * Provides browser automation for X/Twitter scraping and automation.
 * Wraps the scrapers from src/scrapers with session cookie handling.
 * 
 * @module api/services/browserAutomation
 * @author nichxbt
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { puppeteerLaunchOptions } from '../../src/puppeteerLaunchOptions.js';

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// ============================================================================
// Core Utilities
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min = 1000, max = 3000) => sleep(min + Math.random() * (max - min));

function cleanUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

function parseSessionCookies(sessionCookie) {
  if (!sessionCookie) return [];

  const raw = String(sessionCookie).trim();
  const pairs = raw.includes('=')
    ? raw.split(';').map((part) => part.trim()).filter(Boolean)
    : [`auth_token=${raw}`];

  const cookies = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;

    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value || !/^[A-Za-z0-9_.$-]+$/.test(name)) continue;

    const base = {
      name,
      value,
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: name === 'auth_token',
      sameSite: 'Lax',
    };

    cookies.push(base);
  }

  return cookies;
}

// Browser instance management (singleton)
let browserInstance = null;

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch(puppeteerLaunchOptions({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    }));
  }
  return browserInstance;
}

/**
 * Close browser instance
 */
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Create an authenticated page with session cookie
 */
async function getAuthenticatedPage(sessionCookie) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Set viewport with slight randomization
  await page.setViewport({ 
    width: 1280 + Math.floor(Math.random() * 100), 
    height: 800 + Math.floor(Math.random() * 100) 
  });

  // Set user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const cookies = parseSessionCookies(sessionCookie);
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }

  return page;
}

// ============================================================================
// Profile Scraper
// ============================================================================

/**
 * Scrape profile information for a user
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} username - Twitter username (without @)
 * @returns {Object} Profile data
 */
export async function scrapeProfile(sessionCookie, username) {
  const page = await getAuthenticatedPage(sessionCookie);
  
  try {
    await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const profile = await page.evaluate(() => {
      const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
      const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

      // Get avatar
      const avatar = document.querySelector('[data-testid="UserAvatar-Container-unknown"] img, [data-testid*="UserAvatar"] img')?.src;

      // Parse name and username
      const nameSection = document.querySelector('[data-testid="UserName"]');
      const fullText = nameSection?.textContent || '';
      const usernameMatch = fullText.match(/@(\w+)/);

      // Get stats
      const followingLink = document.querySelector('a[href$="/following"]');
      const followersLink = document.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');

      return {
        name: fullText.split('@')[0]?.trim() || null,
        username: usernameMatch?.[1] || null,
        bio: getText('[data-testid="UserDescription"]'),
        location: getText('[data-testid="UserLocation"]'),
        website: getAttr('[data-testid="UserUrl"] a', 'href'),
        joinDate: getText('[data-testid="UserJoinDate"]'),
        following: followingLink?.querySelector('span')?.textContent || null,
        followers: followersLink?.querySelector('span')?.textContent || null,
        profileImage: avatar || null,
        verified: !!document.querySelector('[data-testid="UserName"] svg[aria-label*="Verified"]'),
        protected: !!document.querySelector('[data-testid="UserName"] svg[aria-label*="Protected"]'),
      };
    });

    return profile;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Followers Scraper
// ============================================================================

/**
 * Scrape followers for a user
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} username - Twitter username
 * @param {Object} options - Scraping options
 * @returns {Object} { users: [], nextCursor }
 */
export async function scrapeFollowers(sessionCookie, username, options = {}) {
  const { limit = 100, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/${username}/followers`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const users = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (users.size < limit && retries < maxRetries) {
      const userData = await page.evaluate(() => {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        return Array.from(cells).map((cell) => {
          const link = cell.querySelector('a[href^="/"]');
          const nameEl = cell.querySelector('[dir="ltr"] > span');
          const bioEl = cell.querySelector('[data-testid="UserDescription"]');
          const verifiedEl = cell.querySelector('svg[aria-label*="Verified"]');
          const avatarEl = cell.querySelector('img[src*="profile_images"]');

          const href = link?.getAttribute('href') || '';
          const username = href.split('/')[1];

          return {
            username,
            name: nameEl?.textContent || null,
            bio: bioEl?.textContent || null,
            verified: !!verifiedEl,
            profileImage: avatarEl?.src || null,
          };
        }).filter(u => u.username && !u.username.includes('?'));
      });

      const prevSize = users.size;
      userData.forEach((u) => users.set(u.username, u));

      if (users.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      // Scroll down
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      users: Array.from(users.values()).slice(0, limit),
      nextCursor: null, // Browser automation doesn't have cursor support
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Following Scraper
// ============================================================================

/**
 * Scrape accounts a user is following
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} username - Twitter username
 * @param {Object} options - Scraping options
 * @returns {Object} { users: [], nextCursor }
 */
export async function scrapeFollowing(sessionCookie, username, options = {}) {
  const { limit = 100, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/${username}/following`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const users = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (users.size < limit && retries < maxRetries) {
      const userData = await page.evaluate(() => {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        return Array.from(cells).map((cell) => {
          const link = cell.querySelector('a[href^="/"]');
          const nameEl = cell.querySelector('[dir="ltr"] > span');
          const bioEl = cell.querySelector('[data-testid="UserDescription"]');
          const followsBackEl = cell.querySelector('[data-testid="userFollowIndicator"]');
          const verifiedEl = cell.querySelector('svg[aria-label*="Verified"]');
          const avatarEl = cell.querySelector('img[src*="profile_images"]');

          const href = link?.getAttribute('href') || '';
          const username = href.split('/')[1];

          return {
            username,
            name: nameEl?.textContent || null,
            bio: bioEl?.textContent || null,
            followsBack: !!followsBackEl,
            verified: !!verifiedEl,
            profileImage: avatarEl?.src || null,
          };
        }).filter(u => u.username && !u.username.includes('?'));
      });

      const prevSize = users.size;
      userData.forEach((u) => users.set(u.username, u));

      if (users.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      users: Array.from(users.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Tweets Scraper
// ============================================================================

/**
 * Scrape tweets from a user's profile
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} username - Twitter username
 * @param {Object} options - Scraping options
 * @returns {Object} { items: [], nextCursor }
 */
export async function scrapeTweets(sessionCookie, username, options = {}) {
  const { limit = 50, includeReplies = false, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    const url = includeReplies 
      ? `https://x.com/${username}/with_replies`
      : `https://x.com/${username}`;
      
    await page.goto(url, { waitUntil: 'networkidle2' });
    await randomDelay();

    const tweets = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (tweets.size < limit && retries < maxRetries) {
      const tweetData = await page.evaluate(() => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        return Array.from(articles).map((article) => {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const timeEl = article.querySelector('time');
          const likesEl = article.querySelector('[data-testid="like"] span span');
          const retweetsEl = article.querySelector('[data-testid="retweet"] span span');
          const repliesEl = article.querySelector('[data-testid="reply"] span span');
          const viewsEl = article.querySelector('a[href*="/analytics"] span span');
          const linkEl = article.querySelector('a[href*="/status/"]');
          
          // Get media
          const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(i => ({
            type: 'image',
            url: i.src,
          }));
          const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]');
          
          return {
            id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
            text: textEl?.textContent || null,
            timestamp: timeEl?.getAttribute('datetime') || null,
            likes: likesEl?.textContent || '0',
            retweets: retweetsEl?.textContent || '0',
            replies: repliesEl?.textContent || '0',
            views: viewsEl?.textContent || null,
            url: linkEl?.href || null,
            media: [...images, ...(hasVideo ? [{ type: 'video', url: linkEl?.href }] : [])],
            isRetweet: !!article.querySelector('[data-testid="socialContext"]'),
            isQuote: !!article.querySelector('[data-testid="quoteTweet"]'),
          };
        }).filter(t => t.id);
      });

      const prevSize = tweets.size;
      tweetData.forEach((t) => tweets.set(t.id, t));

      if (tweets.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      items: Array.from(tweets.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Search Tweets
// ============================================================================

/**
 * Search tweets by query
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} query - Search query
 * @param {Object} options - Scraping options
 * @returns {Object} { items: [], nextCursor }
 */
export async function searchTweets(sessionCookie, query, options = {}) {
  const { limit = 50, filter = 'latest', cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    const filterMap = {
      latest: 'live',
      top: 'top',
      people: 'user',
      photos: 'image',
      videos: 'video',
      media: 'media',
    };
    
    const encodedQuery = encodeURIComponent(query);
    const f = filterMap[filter] || 'live';
    
    await page.goto(`https://x.com/search?q=${encodedQuery}&src=typed_query&f=${f}`, {
      waitUntil: 'networkidle2',
    });
    await randomDelay();

    const tweets = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (tweets.size < limit && retries < maxRetries) {
      const tweetData = await page.evaluate(() => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        return Array.from(articles).map((article) => {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
          const authorName = article.querySelector('[data-testid="User-Name"]')?.textContent;
          const timeEl = article.querySelector('time');
          const linkEl = article.querySelector('a[href*="/status/"]');
          const likesEl = article.querySelector('[data-testid="like"] span span');
          const retweetsEl = article.querySelector('[data-testid="retweet"] span span');
          const repliesEl = article.querySelector('[data-testid="reply"] span span');
          
          return {
            id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
            text: textEl?.textContent || null,
            author: {
              username: authorLink?.href?.split('/')[3] || null,
              name: authorName?.split('@')[0]?.trim() || null,
            },
            timestamp: timeEl?.getAttribute('datetime') || null,
            likes: likesEl?.textContent || '0',
            retweets: retweetsEl?.textContent || '0',
            replies: repliesEl?.textContent || '0',
            url: linkEl?.href || null,
          };
        }).filter(t => t.id);
      });

      const prevSize = tweets.size;
      tweetData.forEach((t) => tweets.set(t.id, t));

      if (tweets.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      items: Array.from(tweets.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Thread Scraper
// ============================================================================

/**
 * Scrape a full tweet thread
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} tweetId - Tweet ID to scrape thread from
 * @returns {Object} { author, tweets: [] }
 */
export async function scrapeThread(sessionCookie, tweetId) {
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'networkidle2' });
    await randomDelay();

    // Scroll to load full thread
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1000, 2000);
    }

    const thread = await page.evaluate((mainTweetId) => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      
      // Get main author
      const mainArticle = Array.from(articles).find(a => 
        a.querySelector(`a[href*="/status/${mainTweetId}"]`)
      );
      const mainAuthorEl = mainArticle?.querySelector('[data-testid="User-Name"] a');
      const mainAuthor = mainAuthorEl?.href?.split('/')[3];
      const mainAuthorName = mainArticle?.querySelector('[data-testid="User-Name"]')?.textContent?.split('@')[0]?.trim();

      const tweets = Array.from(articles)
        .map((article) => {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
          const timeEl = article.querySelector('time');
          const linkEl = article.querySelector('a[href*="/status/"]');
          const likesEl = article.querySelector('[data-testid="like"] span span');
          const retweetsEl = article.querySelector('[data-testid="retweet"] span span');
          const repliesEl = article.querySelector('[data-testid="reply"] span span');
          
          const author = authorLink?.href?.split('/')[3];
          
          return {
            id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
            text: textEl?.textContent || null,
            author,
            timestamp: timeEl?.getAttribute('datetime') || null,
            likes: likesEl?.textContent || '0',
            retweets: retweetsEl?.textContent || '0',
            replies: repliesEl?.textContent || '0',
            url: linkEl?.href || null,
            isMainAuthor: author === mainAuthor,
          };
        })
        .filter(t => t.id && t.isMainAuthor);

      return {
        author: {
          username: mainAuthor,
          name: mainAuthorName,
        },
        tweets,
      };
    }, tweetId);

    return thread;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Hashtag Scraper
// ============================================================================

/**
 * Scrape tweets for a hashtag
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} hashtag - Hashtag to search (with or without #)
 * @param {Object} options - Scraping options
 * @returns {Object} { items: [], nextCursor }
 */
export async function scrapeHashtag(sessionCookie, hashtag, options = {}) {
  const tag = hashtag.startsWith('#') ? hashtag.slice(1) : hashtag;
  return searchTweets(sessionCookie, `#${tag}`, options);
}

// ============================================================================
// Media Scraper
// ============================================================================

/**
 * Scrape media (images/videos) from a user
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} username - Twitter username
 * @param {Object} options - Scraping options
 * @returns {Object} { items: [], nextCursor }
 */
export async function scrapeMedia(sessionCookie, username, options = {}) {
  const { limit = 50, type = 'all', cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/${username}/media`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const media = [];
    let retries = 0;
    const maxRetries = 10;

    while (media.length < limit && retries < maxRetries) {
      const newMedia = await page.evaluate(() => {
        const items = document.querySelectorAll('article[data-testid="tweet"]');
        return Array.from(items).flatMap((article) => {
          const tweetUrl = article.querySelector('a[href*="/status/"]')?.href;
          const tweetId = tweetUrl?.match(/status\/(\d+)/)?.[1];
          
          const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
            .map(img => ({
              type: 'image',
              url: img.src.replace(/&name=\w+/, '&name=large'),
              tweetUrl,
              tweetId,
            }));
          
          const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]');
          const videos = hasVideo ? [{
            type: 'video',
            url: tweetUrl,
            tweetUrl,
            tweetId,
          }] : [];
          
          return [...images, ...videos];
        });
      });

      const prevLength = media.length;
      newMedia.forEach((m) => {
        if (!media.find(existing => existing.url === m.url)) {
          if (type === 'all' || type === m.type + 's') {
            media.push(m);
          }
        }
      });

      if (media.length === prevLength) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      items: media.slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Tweet Likes Scraper (users who liked a tweet)
// ============================================================================

/**
 * Scrape users who liked a tweet
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} tweetId - Tweet ID
 * @param {Object} options - Scraping options
 * @returns {Object} { users: [], nextCursor }
 */
export async function scrapeTweetLikes(sessionCookie, tweetId, options = {}) {
  const { limit = 100, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/i/status/${tweetId}/likes`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const users = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (users.size < limit && retries < maxRetries) {
      const userData = await page.evaluate(() => {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        return Array.from(cells).map((cell) => {
          const link = cell.querySelector('a[href^="/"]');
          const nameEl = cell.querySelector('[dir="ltr"] > span');
          const bioEl = cell.querySelector('[data-testid="UserDescription"]');
          const verifiedEl = cell.querySelector('svg[aria-label*="Verified"]');

          const href = link?.getAttribute('href') || '';
          const username = href.split('/')[1];

          return {
            username,
            name: nameEl?.textContent || null,
            bio: bioEl?.textContent || null,
            verified: !!verifiedEl,
          };
        }).filter(u => u.username && !u.username.includes('?'));
      });

      const prevSize = users.size;
      userData.forEach((u) => users.set(u.username, u));

      if (users.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      users: Array.from(users.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// Alias for backward compatibility
export const scrapeLikes = scrapeTweetLikes;

// ============================================================================
// Tweet Retweets Scraper (users who retweeted a tweet)
// ============================================================================

/**
 * Scrape users who retweeted a tweet
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} tweetId - Tweet ID
 * @param {Object} options - Scraping options
 * @returns {Object} { users: [], nextCursor }
 */
export async function scrapeTweetRetweets(sessionCookie, tweetId, options = {}) {
  const { limit = 100, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/i/status/${tweetId}/retweets`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const users = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (users.size < limit && retries < maxRetries) {
      const userData = await page.evaluate(() => {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        return Array.from(cells).map((cell) => {
          const link = cell.querySelector('a[href^="/"]');
          const nameEl = cell.querySelector('[dir="ltr"] > span');
          const bioEl = cell.querySelector('[data-testid="UserDescription"]');
          const verifiedEl = cell.querySelector('svg[aria-label*="Verified"]');

          const href = link?.getAttribute('href') || '';
          const username = href.split('/')[1];

          return {
            username,
            name: nameEl?.textContent || null,
            bio: bioEl?.textContent || null,
            verified: !!verifiedEl,
          };
        }).filter(u => u.username && !u.username.includes('?'));
      });

      const prevSize = users.size;
      userData.forEach((u) => users.set(u.username, u));

      if (users.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      users: Array.from(users.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// Alias for backward compatibility
export const scrapeRetweets = scrapeTweetRetweets;

// ============================================================================
// Bookmarks Scraper
// ============================================================================

/**
 * Scrape user's bookmarks
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {Object} options - Scraping options
 * @returns {Object} { items: [], nextCursor }
 */
export async function scrapeBookmarks(sessionCookie, options = {}) {
  const { limit = 100, cursor } = options;
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'networkidle2' });
    await randomDelay();

    const bookmarks = new Map();
    let retries = 0;
    const maxRetries = 10;

    while (bookmarks.size < limit && retries < maxRetries) {
      const bookmarkData = await page.evaluate(() => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        return Array.from(articles).map((article) => {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
          const authorName = article.querySelector('[data-testid="User-Name"]')?.textContent;
          const timeEl = article.querySelector('time');
          const linkEl = article.querySelector('a[href*="/status/"]');
          const likesEl = article.querySelector('[data-testid="like"] span span');
          const retweetsEl = article.querySelector('[data-testid="retweet"] span span');
          const repliesEl = article.querySelector('[data-testid="reply"] span span');
          
          return {
            id: linkEl?.href?.match(/status\/(\d+)/)?.[1] || null,
            text: textEl?.textContent || null,
            author: {
              username: authorLink?.href?.split('/')[3] || null,
              name: authorName?.split('@')[0]?.trim() || null,
            },
            timestamp: timeEl?.getAttribute('datetime') || null,
            likes: likesEl?.textContent || '0',
            retweets: retweetsEl?.textContent || '0',
            replies: repliesEl?.textContent || '0',
            url: linkEl?.href || null,
          };
        }).filter(t => t.id);
      });

      const prevSize = bookmarks.size;
      bookmarkData.forEach((b) => bookmarks.set(b.id, b));

      if (bookmarks.size === prevSize) {
        retries++;
      } else {
        retries = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await randomDelay(1500, 3000);
    }

    return {
      items: Array.from(bookmarks.values()).slice(0, limit),
      nextCursor: null,
    };
  } finally {
    await page.close();
  }
}

// ============================================================================
// Tweet Details Scraper
// ============================================================================

/**
 * Scrape details of a specific tweet
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} tweetId - Tweet ID
 * @returns {Object} Tweet details
 */
export async function scrapeTweetDetails(sessionCookie, tweetId) {
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'networkidle2' });
    await randomDelay();

    const tweet = await page.evaluate(() => {
      const article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const authorName = article.querySelector('[data-testid="User-Name"]')?.textContent;
      const timeEl = article.querySelector('time');
      const likesEl = article.querySelector('[data-testid="like"] span span');
      const retweetsEl = article.querySelector('[data-testid="retweet"] span span');
      const repliesEl = article.querySelector('[data-testid="reply"] span span');
      const viewsEl = article.querySelector('a[href*="/analytics"] span span');
      
      // Get media
      const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(i => ({
        type: 'image',
        url: i.src,
      }));
      const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]');

      return {
        id: window.location.pathname.match(/status\/(\d+)/)?.[1] || null,
        text: textEl?.textContent || null,
        author: {
          username: authorLink?.href?.split('/')[3] || null,
          name: authorName?.split('@')[0]?.trim() || null,
        },
        timestamp: timeEl?.getAttribute('datetime') || null,
        likes: likesEl?.textContent || '0',
        retweets: retweetsEl?.textContent || '0',
        replies: repliesEl?.textContent || '0',
        views: viewsEl?.textContent || null,
        media: [...images, ...(hasVideo ? [{ type: 'video' }] : [])],
        isQuote: !!article.querySelector('[data-testid="quoteTweet"]'),
      };
    });

    return tweet;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Video URL Extractor
// ============================================================================

/**
 * Extract video URLs from a tweet
 * @param {string} sessionCookie - X/Twitter auth token
 * @param {string} tweetId - Tweet ID containing video
 * @returns {Array} Array of video URLs with quality info
 */
export async function extractVideoUrls(sessionCookie, tweetId) {
  const page = await getAuthenticatedPage(sessionCookie);

  try {
    await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'networkidle2' });
    await randomDelay();

    // Click on video to ensure it loads
    const videoPlayer = await page.$('[data-testid="videoPlayer"]');
    if (videoPlayer) {
      await videoPlayer.click().catch(() => {});
      await sleep(2000);
    }

    const videos = await page.evaluate(() => {
      const results = [];
      const pageContent = document.documentElement.innerHTML;
      
      // Look for video URLs in the page
      const patterns = [
        /https:\/\/video\.twimg\.com\/[^"'\s]+\.mp4[^"'\s]*/g,
        /https:\/\/[^"'\s]*\/amplify_video[^"'\s]*\.mp4[^"'\s]*/g,
        /https:\/\/[^"'\s]*\/ext_tw_video[^"'\s]*\.mp4[^"'\s]*/g,
      ];
      
      patterns.forEach(pattern => {
        const matches = pageContent.match(pattern) || [];
        matches.forEach(url => {
          // Clean up URL
          let cleanUrl = url.replace(/\\u002F/g, '/').replace(/\\/g, '');
          cleanUrl = cleanUrl.split('"')[0].split("'")[0].split(' ')[0];
          
          if (cleanUrl.includes('.mp4')) {
            // Extract quality from URL
            const qualityMatch = cleanUrl.match(/\/(\d+x\d+)\//);
            const quality = qualityMatch ? qualityMatch[1] : 'unknown';
            
            // Extract bitrate if available
            const bitrateMatch = cleanUrl.match(/vid\/(\d+)/);
            const bitrate = bitrateMatch ? parseInt(bitrateMatch[1]) : null;
            
            results.push({ 
              url: cleanUrl, 
              quality,
              bitrate,
              contentType: 'video/mp4',
            });
          }
        });
      });

      // Deduplicate by URL (ignoring query params)
      const unique = [];
      const seen = new Set();
      results.forEach(v => {
        const key = v.url.split('?')[0];
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(v);
        }
      });

      // Sort by quality (highest first)
      return unique.sort((a, b) => {
        const getPixels = (q) => {
          const match = q.match(/(\d+)x(\d+)/);
          return match ? parseInt(match[1]) * parseInt(match[2]) : 0;
        };
        return getPixels(b.quality) - getPixels(a.quality);
      });
    });

    return videos;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Legacy BrowserAutomation Class (for backward compatibility)
// ============================================================================

class BrowserAutomation {
  constructor() {
    this.browser = null;
  }

  async initialize() {
    this.browser = await getBrowser();
    return this.browser;
  }

  async createPage(sessionCookie) {
    return getAuthenticatedPage(sessionCookie);
  }

  async navigateToTwitter(page, url = 'https://x.com/home') {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await randomDelay(1200, 2200);
    return page;
  }

  async checkAuthentication(page) {
    if (!page.url().includes('x.com')) {
      await this.navigateToTwitter(page);
    }

    await page.waitForSelector('body', { timeout: 15000 }).catch(() => null);

    return page.evaluate(() => {
      const path = window.location.pathname;
      if (path.includes('/login') || path.includes('/i/flow/login')) return false;
      if (document.querySelector('input[name="text"], input[autocomplete="username"]')) return false;

      return Boolean(
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
        document.querySelector('a[href="/home"]') ||
        document.querySelector('a[data-testid="AppTabBar_Home_Link"]')
      );
    });
  }

  async getUserTweets(page, username, limit = 10) {
    const clean = cleanUsername(username);
    if (!clean) throw new Error('Target username is required');

    await this.navigateToTwitter(page, `https://x.com/${clean}`);

    const tweets = new Map();
    let scrolls = 0;
    const maxScrolls = Math.max(2, Math.ceil(limit / 4) + 2);

    while (tweets.size < limit && scrolls < maxScrolls) {
      const batch = await page.evaluate((targetUsername) => {
        return Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
          .map((article) => {
            const link = article.querySelector('a[href*="/status/"]');
            const url = link?.href || '';
            const id = url.match(/status\/(\d+)/)?.[1] || null;
            const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
            const author = authorLink?.getAttribute('href')?.split('/')[1] || targetUsername;
            const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';

            return { id, url, username: author, text };
          })
          .filter((tweet) => tweet.id && tweet.url && tweet.username.toLowerCase() === targetUsername.toLowerCase());
      }, clean);

      for (const tweet of batch) {
        tweets.set(tweet.id, tweet);
      }

      if (tweets.size >= limit) break;
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await randomDelay(1200, 2200);
      scrolls++;
    }

    return Array.from(tweets.values()).slice(0, limit);
  }

  async searchTweets(page, query, limit = 20) {
    if (!query) throw new Error('Search query is required');

    await this.navigateToTwitter(
      page,
      `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`
    );

    const tweets = new Map();
    let scrolls = 0;
    const maxScrolls = Math.max(2, Math.ceil(limit / 5) + 2);

    while (tweets.size < limit && scrolls < maxScrolls) {
      const batch = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
          .map((article) => {
            const link = article.querySelector('a[href*="/status/"]');
            const url = link?.href || '';
            const id = url.match(/status\/(\d+)/)?.[1] || null;
            const authorLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
            const username = authorLink?.getAttribute('href')?.split('/')[1] || null;
            const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';

            return { id, url, username, text };
          })
          .filter((tweet) => tweet.id && tweet.url);
      });

      for (const tweet of batch) {
        tweets.set(tweet.id, tweet);
      }

      if (tweets.size >= limit) break;
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await randomDelay(1200, 2200);
      scrolls++;
    }

    return Array.from(tweets.values()).slice(0, limit);
  }

  async likePost(page, tweetUrl) {
    if (!tweetUrl) throw new Error('tweetUrl is required');

    await this.navigateToTwitter(page, tweetUrl);

    const alreadyLiked = await page.$('[data-testid="unlike"]');
    if (alreadyLiked) {
      return { success: true, alreadyLiked: true, url: tweetUrl };
    }

    const likeButton = await page.waitForSelector('[data-testid="like"]', { timeout: 15000 }).catch(() => null);
    if (!likeButton) {
      return { success: false, error: 'Like button not found', url: tweetUrl };
    }

    await likeButton.click();
    await randomDelay(1000, 1800);

    return { success: true, liked: true, url: tweetUrl };
  }

  async unlikePost(page, tweetUrl) {
    if (!tweetUrl) throw new Error('tweetUrl is required');

    await this.navigateToTwitter(page, tweetUrl);

    const unlikeButton = await page.$('[data-testid="unlike"]');
    if (!unlikeButton) {
      return { success: true, alreadyUnliked: true, url: tweetUrl };
    }

    await unlikeButton.click();
    await randomDelay(1000, 1800);

    return { success: true, unliked: true, url: tweetUrl };
  }

  async followUser(page, username) {
    const clean = cleanUsername(username);
    if (!clean) throw new Error('Target username is required');

    await this.navigateToTwitter(page, `https://x.com/${clean}`);

    const result = await page.evaluate(() => {
      const alreadyFollowing = document.querySelector('[data-testid$="-unfollow"]');
      if (alreadyFollowing) {
        return { success: true, alreadyFollowing: true };
      }

      const buttons = Array.from(document.querySelectorAll('button'));
      const followButton = buttons.find((button) => {
        const testId = button.getAttribute('data-testid') || '';
        const label = button.getAttribute('aria-label') || '';
        const text = button.textContent || '';
        return (
          (testId.endsWith('-follow') && !testId.endsWith('-unfollow')) ||
          /^Follow\b/i.test(text.trim()) ||
          /^Follow @/i.test(label)
        );
      });

      if (!followButton) {
        return { success: false, error: 'Follow button not found' };
      }

      followButton.click();
      return { success: true, followed: true };
    });

    await randomDelay(1200, 2200);
    return { username: clean, ...result };
  }

  async sendDM(page, username, message) {
    const clean = cleanUsername(username);
    const text = String(message || '').trim();
    if (!clean) throw new Error('Target username is required');
    if (!text) throw new Error('DM message is required');

    await this.navigateToTwitter(page, 'https://x.com/messages');

    const passcodeRequired = await page.evaluate(() => (
      location.pathname.includes('/i/chat/pin/new') ||
      Boolean(document.querySelector('[data-testid="pin-onboarding-setup-now"]'))
    )).catch(() => false);
    if (passcodeRequired) {
      return {
        success: false,
        username: clean,
        error: 'X chat passcode setup is required before sending DMs',
      };
    }

    await this.navigateToTwitter(page, 'https://x.com/messages/compose');

    const searchInput = await page.waitForSelector(
      '[data-testid="searchPeople"], [role="dialog"] input[data-testid="SearchBox_Search_Input"], [aria-modal="true"] input[data-testid="SearchBox_Search_Input"]',
      { timeout: 20000 }
    ).catch(() => null);
    if (!searchInput) {
      return { success: false, username: clean, error: 'DM recipient search was not available' };
    }

    await searchInput.click({ clickCount: 3 });
    await page.keyboard.type(clean, { delay: 35 });
    await randomDelay(1500, 2500);

    const selected = await page.evaluate((targetUsername) => {
      const scope = document.querySelector('[role="dialog"], [aria-modal="true"]') || document;
      const users = Array.from(scope.querySelectorAll('[data-testid="TypeaheadUser"], [data-testid="UserCell"], div[role="option"]'));
      const target = users.find((user) => (user.textContent || '').toLowerCase().includes(`@${targetUsername.toLowerCase()}`)) || users[0];
      if (!target) return false;
      target.click();
      return true;
    }, clean);

    if (!selected) {
      return { success: false, username: clean, error: 'DM recipient was not found' };
    }

    await randomDelay(800, 1400);

    const nextClicked = await page.evaluate(() => {
      const scope = document.querySelector('[role="dialog"], [aria-modal="true"]') || document;
      const buttons = Array.from(scope.querySelectorAll('button'));
      const next = buttons.find((button) => {
        const testId = button.getAttribute('data-testid') || '';
        const label = (button.getAttribute('aria-label') || '').trim();
        const text = (button.textContent || '').trim();
        return !button.disabled && (
          testId === 'nextButton' ||
          /^Next$/i.test(text) ||
          text === '次へ' ||
          /^Next$/i.test(label) ||
          label === '次へ'
        );
      });
      if (!next) return false;
      next.click();
      return true;
    });

    if (!nextClicked) {
      return { success: false, username: clean, error: 'DM next button was not found' };
    }

    const input = await page.waitForSelector('[data-testid="dmComposerTextInput"]', { timeout: 20000 }).catch(() => null);
    if (!input) {
      return { success: false, username: clean, error: 'DM composer was not available' };
    }

    await input.click();
    await page.keyboard.type(text, { delay: 20 });
    await randomDelay(500, 1000);

    const sendClicked = await page.evaluate(() => {
      const send = document.querySelector('[data-testid="dmComposerSendButton"]');
      if (!send) return false;
      send.click();
      return true;
    });

    if (!sendClicked) {
      return { success: false, username: clean, error: 'DM send button was not available' };
    }

    await randomDelay(1200, 2200);
    return { success: true, username: clean, sent: true };
  }

  async getTweetEngagers(page, tweetUrl, engagementType = 'likes', limit = 50) {
    if (!tweetUrl) throw new Error('tweetUrl is required');

    const suffix = engagementType === 'retweets' ? 'retweets' : 'likes';
    const url = tweetUrl.replace(/\/$/, '') + `/${suffix}`;
    await this.navigateToTwitter(page, url);

    const users = new Map();
    let scrolls = 0;
    const maxScrolls = Math.max(3, Math.ceil(limit / 8) + 2);

    while (users.size < limit && scrolls < maxScrolls) {
      const batch = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[data-testid="UserCell"]'))
          .map((cell) => {
            const link = cell.querySelector('a[href^="/"]');
            const href = link?.getAttribute('href') || '';
            const username = href.split('/')[1];
            const displayName = cell.querySelector('[dir="ltr"] span')?.textContent || username;
            return { username, displayName };
          })
          .filter((user) => user.username && !user.username.includes('?'));
      });

      for (const user of batch) {
        users.set(user.username.toLowerCase(), user);
      }

      if (users.size >= limit) break;
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await randomDelay(1200, 2200);
      scrolls++;
    }

    return Array.from(users.values()).slice(0, limit);
  }

  async close() {
    await closeBrowser();
  }

  async randomDelay(min, max) {
    return randomDelay(min, max);
  }
}

// Create singleton instance
const browserAutomation = new BrowserAutomation();

// Export everything
export { BrowserAutomation };
export default browserAutomation;
