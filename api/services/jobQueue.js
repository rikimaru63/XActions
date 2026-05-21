import Queue from 'bull';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { processUnfollowNonFollowers } from './operations/unfollowNonFollowers.js';
import { processUnfollowEveryone } from './operations/unfollowEveryone.js';
import { processDetectUnfollowers } from './operations/detectUnfollowers.js';
import { processAutoLike } from './operations/autoLike.js';
import { processFollowEngagers } from './operations/followEngagers.js';
import { processKeywordFollow } from './operations/keywordFollow.js';
import { processAutoComment } from './operations/autoComment.js';
import { runFollowerScan } from './followerScanner.js';

// Puppeteer processors
import { unfollowNonFollowersBrowser } from './operations/puppeteer/unfollowNonFollowers.js';
import { unfollowEveryoneBrowser } from './operations/puppeteer/unfollowEveryone.js';
import { detectUnfollowersBrowser } from './operations/puppeteer/detectUnfollowers.js';
import { autoLikeBrowser } from './operations/puppeteer/autoLike.js';
import { followEngagersBrowser } from './operations/puppeteer/followEngagers.js';
import { keywordFollowBrowser } from './operations/puppeteer/keywordFollow.js';
import { autoCommentBrowser } from './operations/puppeteer/autoComment.js';
import {
  createPollBrowser,
  postThreadBrowser,
  postTweetBrowser,
} from './operations/puppeteer/posting.js';
import { targetEngageBrowser } from './operations/puppeteer/targetEngage.js';
import browserAutomation, {
  scrapeFollowers,
  scrapeFollowing,
  scrapeHashtag,
  scrapeMedia,
  scrapeProfile,
  scrapeTweets,
  searchTweets as searchTweetsWithCookie,
} from './browserAutomation.js';
import { extractThread, formatAsMarkdown, formatAsText } from './threadExtractor.js';
import { extractVideo } from './videoExtractor.js';
import { getBookmarks } from '../../src/bookmarkManager.js';
import { getExploreFeed, getTrends } from '../../src/discoveryExplore.js';
import { exportConversation, getConversations } from '../../src/dmManager.js';
import { bookmarkTweet, replyToTweet } from '../../src/engagementManager.js';
import { deletePost } from '../../src/postComposer.js';
import { getLiveSpaces, getScheduledSpaces, scrapeSpace } from '../../src/spacesManager.js';
import { aggregateResults, analyzeBatch, analyzeSentiment, analyzeTweetPriceCorrelation } from '../../src/analytics/index.js';
import { DatasetStore, listDatasets } from '../../src/scraping/paginationEngine.js';
import workflows from '../../src/workflows/index.js';
import { Scheduler } from '../../src/agents/scheduler.js';
import { AgentDatabase } from '../../src/agents/database.js';
import { ThoughtLeaderAgent } from '../../src/agents/thoughtLeaderAgent.js';
import { exportAccount } from '../../src/portability/exporter.js';
import { migrate } from '../../src/portability/importer.js';
import { diffAndReport } from '../../src/portability/differ.js';
import { getDecryptedSessionCookie } from '../routes/session-auth.js';
import { getAccountForUser, getDecryptedAccountCookie, markAccountSessionExpired } from './accountStore.js';
import { withAccountExecutionLock } from './accountExecutionLock.js';
import { refreshParentOperationByChild } from './operationBatches.js';
import { startScheduledActionScheduler } from './scheduledActions.js';
import { getJobRetryState, normalizeScheduleMaxRetries } from './retryPolicy.js';

const prisma = new PrismaClient();
const agentRuntime = {
  instance: null,
  startedAt: null,
  lastError: null,
};

// In-memory job cancellation tracking
const cancelledJobs = new Set();

// Create Bull queue with Redis
const operationsQueue = new Queue('operations', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 50
  }
});

for (const client of [operationsQueue.client, operationsQueue.eclient, operationsQueue.bclient]) {
  client?.setMaxListeners?.(50);
}

/**
 * Add a new job to the queue
 * @param {string} type - Job type (operation name)
 * @param {object} data - Job data including sessionCookie, config, etc.
 * @param {object} options - Queue options (priority, delay, etc.)
 */
async function addJob(type, data, options = {}) {
  // Create operation record in database
  const operation = await prisma.operation.create({
    data: {
      type,
      status: 'queued',
      userId: data.userId,
      config: toJsonString(data.config),
      createdAt: new Date()
    }
  });

  const jobData = {
    type,
    operationId: operation.id,
    ...data
  };

  const job = await operationsQueue.add(type, jobData, {
    priority: options.priority || 10,
    delay: options.delay || 0,
    attempts: options.attempts || 3,
    jobId: operation.id // Use operation ID as job ID for easy lookup
  });
  
  console.log(`📨 Job queued: ${job.id} (${type})`);
  return { jobId: operation.id, bullJobId: job.id, operation };
}

/**
 * Queue job (legacy function for backward compatibility)
 */
async function queueJob(jobData) {
  const explicitJobId = jobData.operationId || jobData.id;
  const attempts = Number(jobData.attempts);
  const delay = Number(jobData.delay);
  const job = await operationsQueue.add(jobData.type, jobData, {
    priority: jobData.priority || 10,
    ...(Number.isFinite(delay) && delay > 0 ? { delay } : {}),
    ...(Number.isFinite(attempts) && attempts > 0 ? { attempts: Math.trunc(attempts) } : {}),
    ...(jobData.backoff ? { backoff: jobData.backoff } : {}),
    ...(explicitJobId ? { jobId: explicitJobId } : {})
  });
  
  console.log(`📨 Job queued: ${job.id} (${jobData.type})`);
  return job;
}

/**
 * Get job status and details
 * @param {string} jobId - The operation/job ID
 */
async function getJob(jobId) {
  // Get from database
  const operation = await prisma.operation.findUnique({
    where: { id: jobId }
  });

  if (!operation) {
    const bullJob = await operationsQueue.getJob(jobId);
    if (!bullJob) return null;

    const state = await bullJob.getState();
    const progress = await bullJob.progress();

    return {
      id: jobId,
      type: bullJob.data?.type,
      status: state,
      progress,
      config: bullJob.data?.config || null,
      result: bullJob.returnvalue || null,
      error: bullJob.failedReason || null,
      createdAt: bullJob.timestamp ? new Date(bullJob.timestamp) : null,
      startedAt: bullJob.processedOn ? new Date(bullJob.processedOn) : null,
      completedAt: bullJob.finishedOn ? new Date(bullJob.finishedOn) : null,
      retryCount: bullJob.attemptsMade || 0,
      cancelled: cancelledJobs.has(jobId)
    };
  }

  // Get Bull job for live progress
  const bullJob = await operationsQueue.getJob(jobId);
  let progress = null;
  let state = operation.status;

  if (bullJob) {
    progress = await bullJob.progress();
    state = await bullJob.getState();
  }

  return {
    id: operation.id,
    type: operation.type,
    status: state || operation.status,
    progress,
    config: operation.config,
    result: operation.result,
    error: operation.error,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    retryCount: operation.retryCount || 0,
    cancelled: cancelledJobs.has(jobId)
  };
}

/**
 * Get job history for a user
 * @param {string} userId - User ID
 * @param {number} limit - Max results (default 50)
 */
async function getHistory(userId, limit = 50) {
  const operations = await prisma.operation.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      status: true,
      config: true,
      result: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      retryCount: true
    }
  });

  return operations;
}

async function getRecentJobs({ userId, limit = 50 } = {}) {
  const effectiveLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

  if (userId) {
    return getHistory(userId, effectiveLimit);
  }

  const jobs = await operationsQueue.getJobs(
    ['active', 'waiting', 'delayed', 'completed', 'failed'],
    0,
    effectiveLimit - 1,
    false
  );

  return Promise.all(jobs.map(async (job) => ({
    id: job.data?.operationId || job.data?.id || job.id,
    type: job.data?.type,
    status: await job.getState(),
    progress: await job.progress(),
    config: job.data?.config || null,
    result: job.returnvalue || null,
    error: job.failedReason || null,
    createdAt: job.timestamp ? new Date(job.timestamp) : null,
    startedAt: job.processedOn ? new Date(job.processedOn) : null,
    completedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    retryCount: job.attemptsMade || 0
  })));
}

/**
 * Cancel a running job
 * @param {string} jobId - The operation/job ID
 */
async function cancelJob(jobId) {
  // Mark as cancelled in memory (for long-running operations to check)
  cancelledJobs.add(jobId);
  let found = false;

  // Try to remove from Bull queue if not yet started
  const bullJob = await operationsQueue.getJob(jobId);
  
  if (bullJob) {
    found = true;
    const state = await bullJob.getState();
    
    if (state === 'waiting' || state === 'delayed') {
      await bullJob.remove();
      console.log(`🛑 Job removed from queue: ${jobId}`);
    } else if (state === 'active') {
      // Job is running - mark for cancellation (operation will check this)
      console.log(`⚠️ Job ${jobId} is active, marked for cancellation`);
    }
  }

  const operation = await prisma.operation.findUnique({
    where: { id: jobId },
    select: { id: true }
  });

  if (operation) {
    found = true;
    await prisma.operation.update({
      where: { id: jobId },
      data: {
        status: 'cancelled',
        completedAt: new Date()
      }
    });
  }

  if (!found) {
    cancelledJobs.delete(jobId);
    return null;
  }

  return { success: true, jobId, message: 'Job cancelled' };
}

/**
 * Check if a job has been cancelled
 * @param {string} jobId - The operation/job ID
 */
function isJobCancelled(jobId) {
  return cancelledJobs.has(jobId);
}

/**
 * Clean up old cancelled job markers
 */
function cleanupCancelledJobs() {
  // Clear cancelled markers older than 1 hour (they're in-memory only)
  // In production, you might want to persist this to Redis
  if (cancelledJobs.size > 1000) {
    cancelledJobs.clear();
  }
}

function toJsonString(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function rowsToCsv(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [...rows.reduce((keys, row) => {
    Object.keys(row || {}).forEach((key) => keys.add(key));
    return keys;
  }, new Set())];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row?.[header])).join(',')),
  ].join('\n');
}

function monitorQuery(type, target) {
  const cleaned = String(target || '').trim();
  if (type === 'keyword') return cleaned;
  const username = cleaned.replace(/^@/, '');
  if (type === 'replies') return `to:${username}`;
  return `@${username}`;
}

function parseSessionCookiesForFile(sessionCookie) {
  if (!sessionCookie) return [];
  const raw = String(sessionCookie).trim();
  const pairs = raw.includes('=')
    ? raw.split(';').map((part) => part.trim()).filter(Boolean)
    : [`auth_token=${raw}`];

  return pairs.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value || !/^[A-Za-z0-9_.$-]+$/.test(name)) return null;
    return {
      name,
      value,
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: name === 'auth_token',
      sameSite: 'Lax',
    };
  }).filter(Boolean);
}

function authTokenValue(sessionCookie) {
  const cookies = parseSessionCookiesForFile(sessionCookie);
  return cookies.find((cookie) => cookie.name === 'auth_token')?.value || String(sessionCookie || '').trim();
}

function defaultAgentConfigPath() {
  return path.resolve(process.cwd(), 'data', 'agent-config.json');
}

function loadAgentConfig() {
  const configPath = defaultAgentConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error('Agent config not found. Configure the agent before starting it.');
  }
  return {
    configPath,
    config: ThoughtLeaderAgent.loadConfig(configPath),
  };
}

function redactAgentConfig(config) {
  const safe = JSON.parse(JSON.stringify(config || {}));
  if (safe.llm?.apiKey) {
    safe.llm.apiKey = `${safe.llm.apiKey.slice(0, 8)}...${safe.llm.apiKey.slice(-4)}`;
  }
  if (safe.proxy?.url) safe.proxy.url = '***';
  if (safe.browser?.proxy) safe.browser.proxy = '***';
  return safe;
}

async function prepareAgentSessionFile(config, sessionCookie) {
  const cookies = parseSessionCookiesForFile(sessionCookie);
  if (!cookies.length) return null;
  const sessionPath = path.resolve(process.cwd(), config.browser?.sessionPath || 'data/session.json');
  await fsp.mkdir(path.dirname(sessionPath), { recursive: true });
  await fsp.writeFile(sessionPath, JSON.stringify(cookies, null, 2));
  return sessionPath;
}

function agentStatus(config = null) {
  const running = !!agentRuntime.instance;
  return {
    running,
    startedAt: agentRuntime.startedAt ? new Date(agentRuntime.startedAt).toISOString() : null,
    lastError: agentRuntime.lastError,
    configExists: fs.existsSync(defaultAgentConfigPath()),
    accountUsername: config?.accountUsername || null,
    ...(running && typeof agentRuntime.instance.getStatus === 'function'
      ? { runtime: agentRuntime.instance.getStatus() }
      : {}),
  };
}

function withAgentDatabase(config, callback) {
  const { config: agentConfig } = loadAgentConfig();
  const db = new AgentDatabase(agentConfig.dbPath || 'data/agent.db');
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function handleAgentCommand(config) {
  const action = config.action || 'status';

  if (action === 'status') return agentStatus(config);

  if (action === 'config') {
    const { config: agentConfig } = loadAgentConfig();
    return { config: redactAgentConfig(agentConfig) };
  }

  if (action === 'schedule') {
    const { config: agentConfig } = loadAgentConfig();
    const scheduler = agentRuntime.instance?.scheduler || new Scheduler({
      timezone: agentConfig.schedule?.timezone || 'Asia/Tokyo',
      sleepHours: agentConfig.schedule?.sleepHours || [23, 6],
      searchTerms: agentConfig.niche?.searchTerms || [],
      influencers: agentConfig.niche?.influencers || [],
    });
    const schedule = scheduler.getDailyPlan();
    return { schedule, count: schedule.length };
  }

  if (action === 'report') {
    return withAgentDatabase(config, (db) => ({
      report: db.getGrowthReport(config.days || 30),
      days: config.days || 30,
    }));
  }

  if (action === 'content') {
    return withAgentDatabase(config, (db) => {
      const content = db.getRecentPosts(config.limit || 20);
      return { content, count: content.length };
    });
  }

  if (action === 'score') {
    if (!agentRuntime.instance?.llm) {
      throw new Error('Agent is not running. Start the agent before scoring feed text.');
    }
    const { config: agentConfig } = loadAgentConfig();
    const score = await agentRuntime.instance.llm.scoreRelevance(
      config.text,
      agentConfig.niche?.keywords || []
    );
    return { score, textPreview: String(config.text || '').slice(0, 140) };
  }

  if (action === 'stop') {
    if (config.dryRun !== false) {
      return { dryRun: true, action, running: !!agentRuntime.instance };
    }
    if (!agentRuntime.instance) return { running: false, stopped: false };
    const instance = agentRuntime.instance;
    agentRuntime.instance = null;
    agentRuntime.startedAt = null;
    await instance.stop();
    return { running: false, stopped: true };
  }

  if (action === 'start') {
    const { configPath, config: agentConfig } = loadAgentConfig();
    const sessionPath = await prepareAgentSessionFile(agentConfig, config.sessionCookie);
    if (config.dryRun !== false) {
      return {
        dryRun: true,
        action,
        configPath,
        sessionPrepared: !!sessionPath,
        alreadyRunning: !!agentRuntime.instance,
      };
    }
    if (agentRuntime.instance) return agentStatus(config);

    const instance = new ThoughtLeaderAgent(agentConfig);
    agentRuntime.instance = instance;
    agentRuntime.startedAt = Date.now();
    agentRuntime.lastError = null;
    instance.start().catch((error) => {
      console.error('Agent runtime crashed:', error);
      agentRuntime.instance = null;
      agentRuntime.startedAt = null;
      agentRuntime.lastError = error.message;
    });

    return {
      running: true,
      startedAt: new Date(agentRuntime.startedAt).toISOString(),
      sessionPrepared: !!sessionPath,
    };
  }

  return agentStatus(config);
}

const portabilityExportsRoot = () => path.resolve(process.cwd(), 'exports');

function resolveExportDir(value) {
  if (!value) return null;
  const root = portabilityExportsRoot();
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Export directory must be inside the exports directory.');
  }
  return resolved;
}

async function listPortabilityExports() {
  const root = portabilityExportsRoot();
  let dirs = [];
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return [];
  }

  const exports = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    const stat = await fsp.stat(dirPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const summary = await fsp.readFile(path.join(dirPath, 'summary.json'), 'utf-8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    exports.push({
      name: dir,
      path: dirPath,
      date: summary?.date || dir.split('_').pop(),
      username: summary?.username || dir.split('_')[0],
      phases: summary?.phases || {},
      hasArchive: await fsp.access(path.join(dirPath, 'index.html')).then(() => true).catch(() => false),
    });
  }

  return exports.sort((a, b) => b.name.localeCompare(a.name));
}

async function findPortabilityExport(username, requestedDir) {
  if (requestedDir) return resolveExportDir(requestedDir);
  const clean = String(username || '').replace(/^@/, '');
  if (!clean) return null;
  const exports = await listPortabilityExports();
  return exports.find((item) => item.username === clean || item.name.startsWith(`${clean}_`))?.path || null;
}

async function handlePortability(config, progress) {
  const action = config.action || 'exports';

  if (action === 'exports') {
    const exports = await listPortabilityExports();
    return { exports, count: exports.length };
  }

  if (action === 'diff') {
    const dirA = resolveExportDir(config.dirA);
    const dirB = resolveExportDir(config.dirB);
    const { diff, report } = await diffAndReport(dirA, dirB);
    return { summary: diff.summary, diff, report };
  }

  if (action === 'migrate') {
    const username = config.username || config.accountUsername;
    const exportDir = await findPortabilityExport(username, config.exportDir);
    if (!exportDir) throw new Error('No export found. Run an export first.');
    return migrate({
      platform: config.platform,
      exportDir,
      dryRun: config.dryRun !== false,
      credentials: {},
    });
  }

  const username = String(config.username || config.accountUsername || '').replace(/^@/, '');
  if (!username) throw new Error('Export username is required.');

  if (config.dryRun !== false) {
    return {
      dryRun: true,
      action: 'export',
      username,
      formats: config.formats || ['json', 'csv', 'md'],
      only: config.only || [],
      limit: config.limit || 500,
    };
  }

  if (!config.sessionCookie) throw new Error('Session cookie required. Reconnect your X account.');
  const scrapersModule = await import('../../src/scrapers/index.js');
  const scrapers = scrapersModule.default || scrapersModule;
  const browser = await scrapers.createBrowser();
  const page = await scrapers.createPage(browser);

  try {
    await scrapers.loginWithCookie(page, authTokenValue(config.sessionCookie));
    return await exportAccount({
      page,
      username,
      formats: config.formats || ['json', 'csv', 'md'],
      only: config.only?.length ? config.only : undefined,
      limit: config.limit || 500,
      scrapers,
      onProgress: progress,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function resolveJobConfig(job) {
  const config = job.data.config || {};

  if (job.data.accountId) {
    const account = job.data.userId
      ? await getAccountForUser(job.data.userId, job.data.accountId).catch(() => null)
      : null;
    const accountCookie = job.data.userId
      ? await getDecryptedAccountCookie(job.data.userId, job.data.accountId).catch(() => null)
      : null;

    if (!accountCookie) throw new Error('Xアカウントの連携情報を取得できませんでした。');

    return {
      ...config,
      username: config.username || account?.username || undefined,
      accountUsername: account?.username || undefined,
      sessionCookie: accountCookie,
    };
  }

  if (job.data.authMethod === 'session' || config.sessionCookie) {
    const storedCookie = job.data.userId
      ? await getDecryptedSessionCookie(job.data.userId).catch(() => null)
      : null;

    return {
      ...config,
      sessionCookie: storedCookie || config.sessionCookie,
    };
  }

  return config;
}

function tweetUrlFromConfig(config) {
  if (config.tweetUrl) return config.tweetUrl;
  if (config.tweetId) return `https://x.com/i/status/${config.tweetId}`;
  throw new Error('tweetId or tweetUrl is required');
}

const getJobStatus = getJob;
const isWorkerProcess = process.env.XACTIONS_WORKER === 'true'
  || (process.argv[1] || '').replace(/\\/g, '/').endsWith('api/services/jobQueue.js');

if (isWorkerProcess) {

// Process jobs - unfollowNonFollowers
operationsQueue.process('unfollowNonFollowers', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: unfollowNonFollowers`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    // Check if browser automation or API
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await unfollowNonFollowersBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processUnfollowNonFollowers(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - unfollowEveryone
operationsQueue.process('unfollowEveryone', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: unfollowEveryone`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await unfollowEveryoneBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processUnfollowEveryone(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - detectUnfollowers
operationsQueue.process('detectUnfollowers', 3, async (job) => {
  console.log(`🔄 Processing job ${job.id}: detectUnfollowers`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await detectUnfollowersBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processDetectUnfollowers(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - autoLike
operationsQueue.process('autoLike', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: autoLike`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await autoLikeBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processAutoLike(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - followEngagers
operationsQueue.process('followEngagers', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: followEngagers`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await followEngagersBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processFollowEngagers(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - keywordFollow
operationsQueue.process('keywordFollow', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: keywordFollow`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await keywordFollowBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processKeywordFollow(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - autoComment
operationsQueue.process('autoComment', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: autoComment`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    if (job.data.authMethod === 'session') {
      const config = await resolveJobConfig(job);
      return await autoCommentBrowser(
        job.data.userId,
        config,
        (message) => job.progress(message),
        () => isJobCancelled(job.data.operationId)
      );
    }

    return await processAutoComment(job.data, () => isJobCancelled(job.data.operationId));
  });
});

// Process jobs - read-only collection actions
operationsQueue.process('getProfile', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getProfile`);

  const config = await resolveJobConfig(job);
  return scrapeProfile(config.sessionCookie, config.username);
});

operationsQueue.process('getFollowers', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getFollowers`);

  const config = await resolveJobConfig(job);
  return scrapeFollowers(config.sessionCookie, config.username, {
    limit: config.limit,
  });
});

operationsQueue.process('getFollowing', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getFollowing`);

  const config = await resolveJobConfig(job);
  return scrapeFollowing(config.sessionCookie, config.username, {
    limit: config.limit,
  });
});

operationsQueue.process('getTweets', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getTweets`);

  const config = await resolveJobConfig(job);
  return scrapeTweets(config.sessionCookie, config.username, {
    limit: config.limit,
    includeReplies: config.includeReplies,
  });
});

operationsQueue.process('searchTweets', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: searchTweets`);

  const config = await resolveJobConfig(job);
  return searchTweetsWithCookie(config.sessionCookie, config.query, {
    limit: config.limit,
    filter: config.filter,
  });
});

operationsQueue.process('searchHashtag', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: searchHashtag`);

  const config = await resolveJobConfig(job);
  return scrapeHashtag(config.sessionCookie, config.hashtag, {
    limit: config.limit,
    filter: config.filter,
  });
});

operationsQueue.process('getTrends', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getTrends`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getTrends(page, { location: config.category || 'global' });
  } finally {
    await page.close();
  }
});

operationsQueue.process('getExploreFeed', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getExploreFeed`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getExploreFeed(page, {
      tab: config.tab,
      limit: config.limit,
    });
  } finally {
    await page.close();
  }
});

operationsQueue.process('getBookmarks', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getBookmarks`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getBookmarks(page, {
      limit: config.limit,
      format: config.format,
    });
  } finally {
    await page.close();
  }
});

operationsQueue.process('getMedia', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getMedia`);

  const config = await resolveJobConfig(job);
  return scrapeMedia(config.sessionCookie, config.username, {
    limit: config.limit,
    type: config.type,
  });
});

operationsQueue.process('getConversations', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getConversations`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getConversations(page, { limit: config.limit });
  } finally {
    await page.close();
  }
});

operationsQueue.process('exportDMs', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: exportDMs`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    const result = config.conversationUrl
      ? await exportConversation(page, config.conversationUrl, { limit: config.limit })
      : await getConversations(page, { limit: config.limit });

    if (config.format !== 'csv') return { ...result, format: 'json' };

    const rows = result.messages || result.conversations || [];
    return {
      ...result,
      format: 'csv',
      content: rowsToCsv(rows),
    };
  } finally {
    await page.close();
  }
});

operationsQueue.process('followerScan', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: followerScan`);

  const config = await resolveJobConfig(job);
  const username = String(config.username || config.accountUsername || '').replace(/^@/, '');
  if (!username) throw new Error('Follower scan requires a username.');
  if (!config.sessionCookie) throw new Error('Session cookie required. Reconnect your X account.');

  return runFollowerScan(job.data.userId, config.sessionCookie, username, {
    limit: config.limit || 5000,
  });
});

operationsQueue.process('getLiveSpaces', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getLiveSpaces`);

  const config = await resolveJobConfig(job);
  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getLiveSpaces(page, {
      query: config.topic || config.query || '',
      limit: config.limit || 20,
    });
  } finally {
    await page.close();
  }
});

operationsQueue.process('getScheduledSpaces', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: getScheduledSpaces`);

  const config = await resolveJobConfig(job);
  const username = String(config.username || config.accountUsername || '').replace(/^@/, '');
  if (!username) throw new Error('Scheduled Spaces requires a username.');

  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return getScheduledSpaces(page, username);
  } finally {
    await page.close();
  }
});

operationsQueue.process('scrapeSpace', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: scrapeSpace`);

  const config = await resolveJobConfig(job);
  if (!config.spaceUrl && !config.url) throw new Error('Space URL is required.');

  const page = await browserAutomation.createPage(config.sessionCookie);
  try {
    return scrapeSpace(page, config.spaceUrl || config.url);
  } finally {
    await page.close();
  }
});

operationsQueue.process('extractVideo', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: extractVideo`);

  const config = job.data.config || {};
  return extractVideo(config.tweetUrl || config.url);
});

operationsQueue.process('unrollThread', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: unrollThread`);

  const config = job.data.config || {};
  const thread = await extractThread(config.tweetUrl || config.url, {
    maxTweets: config.maxTweets || 100,
  });

  if (config.format === 'markdown') {
    return {
      ...thread,
      format: 'markdown',
      formatted: formatAsMarkdown(thread),
    };
  }

  if (config.format === 'json') {
    return {
      ...thread,
      format: 'json',
    };
  }

  return {
    ...thread,
    format: 'text',
    formatted: formatAsText(thread),
  };
});

operationsQueue.process('analyzeSentiment', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: analyzeSentiment`);

  const config = job.data.config || {};
  return analyzeSentiment(config.text, { mode: config.mode || 'rules' });
});

operationsQueue.process('priceCorrelation', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: priceCorrelation`);

  const config = job.data.config || {};
  return analyzeTweetPriceCorrelation({
    tweets: config.tweets || [],
    tokenId: config.tokenId,
    network: config.network,
    poolAddress: config.poolAddress,
    windows: config.windows || [1, 24],
  });
});

operationsQueue.process('datasets', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: datasets`);

  const config = job.data.config || {};
  const action = config.action || 'list';

  if (action === 'get') {
    const store = new DatasetStore(config.name);
    return store.getData({
      offset: config.offset || 0,
      limit: config.limit || 100,
    });
  }

  if (action === 'export') {
    const store = new DatasetStore(config.name);
    const content = await store.export(config.format || 'json');
    return {
      name: config.name,
      format: config.format || 'json',
      content,
      exportedAt: new Date().toISOString(),
    };
  }

  const datasets = await listDatasets();
  return {
    datasets,
    count: datasets.length,
  };
});

operationsQueue.process('monitorSnapshot', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: monitorSnapshot`);

  const config = await resolveJobConfig(job);
  const target = String(config.target || '').trim();
  if (!target) throw new Error('Monitor target is required.');

  const query = monitorQuery(config.monitorType, target);
  const tweets = await searchTweetsWithCookie(config.sessionCookie, query, {
    limit: config.limit || 20,
    filter: 'latest',
  });
  const items = Array.isArray(tweets) ? tweets : tweets?.tweets || tweets?.results || [];
  const texts = items
    .map((item) => String(item.text || item.content || item.fullText || '').trim())
    .filter(Boolean);
  const sentiment = await analyzeBatch(texts, {
    mode: config.sentimentMode || 'rules',
  });

  return {
    target,
    monitorType: config.monitorType || 'mentions',
    query,
    count: items.length,
    sentiment: aggregateResults(sentiment),
    items: items.slice(0, config.limit || 20),
    analyzedAt: new Date().toISOString(),
  };
});

operationsQueue.process('runWorkflow', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: runWorkflow`);

  const config = await resolveJobConfig(job);
  const action = config.action || 'list';

  if (action === 'actions') {
    return {
      actions: workflows.listActions(),
      operators: workflows.getAvailableOperators(),
    };
  }

  if (action === 'runs') {
    return workflows.runs(config.workflowId, config.limit || 20);
  }

  if (action !== 'run') {
    const list = await workflows.list();
    return {
      workflows: list,
      count: list.length,
    };
  }

  const workflow = await workflows.get(config.workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${config.workflowId}`);

  if (config.dryRun !== false) {
    return {
      dryRun: true,
      workflow: {
        id: workflow.id,
        name: workflow.name,
        enabled: workflow.enabled !== false,
        stepsCount: workflow.steps?.length || 0,
        trigger: workflow.trigger || { type: 'manual' },
      },
      contextKeys: Object.keys(config.context || {}),
    };
  }

  return workflows.run(workflow, {
    trigger: 'console',
    initialContext: config.context || {},
    authToken: config.sessionCookie,
    userId: job.data.userId || 'console',
    isCancelled: () => isJobCancelled(job.data.operationId),
    onProgress: (event) => Promise.resolve(job.progress(event)).catch(() => {}),
  });
});

operationsQueue.process('agentCommand', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: agentCommand`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return handleAgentCommand(config);
  });
});

operationsQueue.process('portability', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: portability`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return handlePortability(config, (progress) => job.progress(progress));
  });
});

// Process jobs - posting actions
operationsQueue.process('postTweet', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: postTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return postTweetBrowser(job.data.userId, config);
  });
});

operationsQueue.process('postThread', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: postThread`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return postThreadBrowser(job.data.userId, config);
  });
});

operationsQueue.process('createPoll', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: createPoll`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return createPollBrowser(job.data.userId, config);
  });
});

// Process jobs - explicit target actions (like latest posts, follow, DM)
operationsQueue.process('targetEngage', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: targetEngage`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    return await targetEngageBrowser(
      job.data.userId,
      config,
      (message) => job.progress(message),
      () => isJobCancelled(job.data.operationId)
    );
  });
});

// Process jobs - direct tweet engagement
operationsQueue.process('likeTweet', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: likeTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await browserAutomation.likePost(page, tweetUrlFromConfig(config));
    } finally {
      await page.close();
    }
  });
});

operationsQueue.process('unlikeTweet', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: unlikeTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await browserAutomation.unlikePost(page, tweetUrlFromConfig(config));
    } finally {
      await page.close();
    }
  });
});

operationsQueue.process('replyToTweet', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: replyToTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await replyToTweet(page, tweetUrlFromConfig(config), config.text);
    } finally {
      await page.close();
    }
  });
});

operationsQueue.process('bookmarkTweet', 2, async (job) => {
  console.log(`🔄 Processing job ${job.id}: bookmarkTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await bookmarkTweet(page, tweetUrlFromConfig(config));
    } finally {
      await page.close();
    }
  });
});

operationsQueue.process('deleteTweet', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: deleteTweet`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await deletePost(page, tweetUrlFromConfig(config));
    } finally {
      await page.close();
    }
  });
});

operationsQueue.process('sendDM', 1, async (job) => {
  console.log(`🔄 Processing job ${job.id}: sendDM`);

  return withAccountExecutionLock(operationsQueue.client, job, async () => {
    const config = await resolveJobConfig(job);
    const page = await browserAutomation.createPage(config.sessionCookie);

    try {
      await browserAutomation.navigateToTwitter(page);
      const isAuthenticated = await browserAutomation.checkAuthentication(page);
      if (!isAuthenticated) throw new Error('Session expired - please reconnect your X account');
      return await browserAutomation.sendDM(page, config.username, config.message);
    } finally {
      await page.close();
    }
  });
});

// Job event handlers
operationsQueue.on('active', async (job) => {
  if (!job.data.operationId) return;

  await prisma.operation.updateMany({
    where: {
      id: job.data.operationId,
      status: { notIn: ['completed', 'failed', 'cancelled'] },
    },
    data: {
      status: 'processing',
      startedAt: new Date()
    }
  }).catch((error) => {
    console.error(`Failed to mark job active: ${job.id}`, error);
  });

  if (job.data.scheduledActionRunId) {
    await prisma.scheduledActionRun.updateMany({
      where: {
        id: job.data.scheduledActionRunId,
        status: { notIn: ['completed', 'failed', 'skipped'] },
      },
      data: {
        status: 'running',
        startedAt: new Date(),
      },
    }).catch((error) => {
      console.error(`Failed to mark scheduled run active: ${job.id}`, error);
    });
  }

  await refreshParentOperationByChild(job.data.operationId).catch((error) => {
    console.error(`Failed to update parent operation active state: ${job.id}`, error);
  });
});

operationsQueue.on('completed', async (job, result) => {
  console.log(`✅ Job completed: ${job.id}`);

  if (!job.data.operationId) return;

  await prisma.operation.update({
    where: { id: job.data.operationId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      result: toJsonString(result)
    }
  });

  await refreshParentOperationByChild(job.data.operationId).catch((error) => {
    console.error(`Failed to update parent operation completion state: ${job.id}`, error);
  });

  if (job.data.scheduledActionRunId) {
    await prisma.scheduledActionRun.update({
      where: { id: job.data.scheduledActionRunId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
      },
    }).catch((error) => {
      console.error(`Failed to mark scheduled run completed: ${job.id}`, error);
    });
  }

  if (job.data.scheduledActionId && job.data.scheduledTrigger === 'due') {
    const schedule = await prisma.scheduledAction.findUnique({
      where: { id: job.data.scheduledActionId },
      select: { id: true, scheduleType: true },
    }).catch(() => null);

    if (schedule) {
      await prisma.scheduledAction.update({
        where: { id: schedule.id },
        data: {
          status: schedule.scheduleType === 'once' ? 'completed' : 'active',
          failureCount: 0,
          lastError: null,
        },
      }).catch((error) => {
        console.error(`Failed to update scheduled action completion state: ${job.id}`, error);
      });
    }
  }
});

operationsQueue.on('failed', async (job, err) => {
  console.error(`❌ Job failed: ${job.id}`, err);

  if (!job.data.operationId) return;
  const retryState = getJobRetryState(job);
  const errorMessage = err?.message || String(err || 'Job failed');
  const now = new Date();

  await prisma.operation.update({
    where: { id: job.data.operationId },
    data: {
      status: retryState.willRetry ? 'processing' : 'failed',
      error: errorMessage,
      retryCount: retryState.attemptsMade,
      ...(retryState.willRetry ? {} : { completedAt: now }),
    }
  });

  if (!retryState.willRetry) {
    await markAccountSessionExpired(job.data.userId, job.data.accountId, err).catch((error) => {
      console.error(`Failed to mark X account expired: ${job.id}`, error);
    });
  }

  await refreshParentOperationByChild(job.data.operationId).catch((error) => {
    console.error(`Failed to update parent operation failure state: ${job.id}`, error);
  });

  if (job.data.scheduledActionRunId) {
    await prisma.scheduledActionRun.update({
      where: { id: job.data.scheduledActionRunId },
      data: {
        status: retryState.willRetry ? 'running' : 'failed',
        error: errorMessage,
        ...(retryState.willRetry ? {} : { finishedAt: now }),
      },
    }).catch((error) => {
      console.error(`Failed to mark scheduled run failed: ${job.id}`, error);
    });
  }

  if (job.data.scheduledActionId && job.data.scheduledTrigger === 'due') {
    const schedule = await prisma.scheduledAction.findUnique({
      where: { id: job.data.scheduledActionId },
      select: { id: true, failureCount: true, maxRetries: true, status: true, scheduleType: true },
    }).catch(() => null);

    if (schedule) {
      if (retryState.willRetry) {
        await prisma.scheduledAction.update({
          where: { id: schedule.id },
          data: {
            lastError: errorMessage,
          },
        }).catch((error) => {
          console.error(`Failed to update scheduled action retry state: ${job.id}`, error);
        });
        return;
      }

      const nextFailureCount = (schedule.failureCount || 0) + 1;
      const maxRetries = normalizeScheduleMaxRetries(schedule.maxRetries);
      const nextStatus = schedule.scheduleType === 'once'
        ? 'failed'
        : nextFailureCount > maxRetries ? 'failed' : schedule.status;
      await prisma.scheduledAction.update({
        where: { id: schedule.id },
        data: {
          failureCount: nextFailureCount,
          lastError: errorMessage,
          status: nextStatus,
        },
      }).catch((error) => {
        console.error(`Failed to update scheduled action failure state: ${job.id}`, error);
      });
    }
  }
});

operationsQueue.on('stalled', async (job) => {
  console.warn(`⚠️ Job stalled: ${job.id}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📊 Closing queue...');
  await operationsQueue.close();
  await prisma.$disconnect();
  process.exit(0);
});

// Periodic cleanup of cancelled job markers
setInterval(cleanupCancelledJobs, 3600000); // Every hour

startScheduledActionScheduler(queueJob, {
  intervalMs: Number(process.env.SCHEDULED_ACTIONS_INTERVAL_MS) || 30000,
});

}

export {
  addJob,
  queueJob,
  getJob,
  getJobStatus,
  getHistory,
  getRecentJobs,
  cancelJob,
  isJobCancelled,
  operationsQueue
};
