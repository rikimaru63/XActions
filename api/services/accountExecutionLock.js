import { randomUUID } from 'crypto';

const defaultLockTtlMs = 30 * 60 * 1000;
const defaultWaitMs = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isDryRunValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function shouldSerializeAccountJob(jobData = {}) {
  if (!jobData.accountId) return false;
  if (isDryRunValue(jobData.config?.dryRun)) return false;
  return true;
}

function lockKey(accountId) {
  return `xactions:account:${accountId}:live-lock`;
}

async function releaseLock(redisClient, key, token) {
  await redisClient.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token
  );
}

async function refreshLock(redisClient, key, token, ttlMs) {
  await redisClient.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    key,
    token,
    String(ttlMs)
  );
}

async function acquireLock(redisClient, key, token, options = {}) {
  const ttlMs = Math.max(Number(options.ttlMs) || defaultLockTtlMs, 30000);
  const waitMs = Math.max(Number(options.waitMs) || defaultWaitMs, 0);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= waitMs) {
    const acquired = await redisClient.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') return { key, token, ttlMs };
    await sleep(1800 + Math.floor(Math.random() * 700));
  }

  throw new Error('同じXアカウントの実行が続いているため開始できませんでした。少し待って再実行してください。');
}

async function withAccountExecutionLock(redisClient, job, handler, options = {}) {
  if (!shouldSerializeAccountJob(job?.data)) {
    return handler();
  }

  const key = lockKey(job.data.accountId);
  const token = `${job.data.operationId || job.id || 'job'}:${randomUUID()}`;
  const lock = await acquireLock(redisClient, key, token, options);
  const refreshIntervalMs = Math.max(Math.floor(lock.ttlMs / 3), 10000);
  const refreshTimer = setInterval(() => {
    refreshLock(redisClient, lock.key, lock.token, lock.ttlMs).catch((error) => {
      console.error(`Failed to refresh account execution lock: ${lock.key}`, error);
    });
  }, refreshIntervalMs);

  refreshTimer.unref?.();

  try {
    if (typeof job.progress === 'function') {
      await job.progress('同じXアカウントの実行を直列化しています。').catch(() => {});
    }
    return await handler();
  } finally {
    clearInterval(refreshTimer);
    await releaseLock(redisClient, lock.key, lock.token).catch((error) => {
      console.error(`Failed to release account execution lock: ${lock.key}`, error);
    });
  }
}

export {
  acquireLock,
  lockKey,
  shouldSerializeAccountJob,
  withAccountExecutionLock,
};
