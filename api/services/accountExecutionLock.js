import { randomUUID } from 'crypto';

const defaultLockTtlMs = 30 * 60 * 1000;
const defaultWaitMs = 10 * 60 * 1000;
const defaultHighRiskCooldownMs = 60 * 1000;
const highRiskActionTypes = new Set(['sendDM', 'followEngagers', 'keywordFollow']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isDryRunValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isTrueValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'yes' || value === 'on';
}

function shouldSerializeAccountJob(jobData = {}) {
  if (!jobData.accountId) return false;
  if (isDryRunValue(jobData.config?.dryRun)) return false;
  return true;
}

function shouldThrottleAccountJob(jobData = {}) {
  if (!shouldSerializeAccountJob(jobData)) return false;

  const type = String(jobData.type || jobData.operationType || '');
  if (highRiskActionTypes.has(type)) return true;
  if (type !== 'targetEngage') return false;

  const config = jobData.config || {};
  return isTrueValue(config.follow)
    || isTrueValue(config.hasDmMessage)
    || !!jobData.hasEncryptedJobConfig;
}

function lockKey(accountId) {
  return `xactions:account:${accountId}:live-lock`;
}

function cooldownKey(accountId) {
  return `xactions:account:${accountId}:high-risk-cooldown`;
}

function cooldownMs(options = {}) {
  const configured = options.cooldownMs ?? process.env.XACTIONS_ACCOUNT_HIGH_RISK_COOLDOWN_MS;
  const parsed = Number(configured);
  if (Number.isFinite(parsed)) return Math.max(Math.trunc(parsed), 0);
  return defaultHighRiskCooldownMs;
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

async function waitForCooldown(redisClient, key, options = {}) {
  if (typeof redisClient.pttl !== 'function') return;

  const waitMs = Math.max(Number(options.cooldownWaitMs) || defaultWaitMs, 0);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= waitMs) {
    const ttl = Number(await redisClient.pttl(key));
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    if (Date.now() - startedAt + ttl > waitMs) {
      throw new Error('このXアカウントはDM / follow系の連続実行間隔内です。少し待って再実行してください。');
    }
    await sleep(Math.min(ttl, 10000));
  }

  throw new Error('このXアカウントはDM / follow系の連続実行間隔内です。少し待って再実行してください。');
}

async function setAccountCooldown(redisClient, key, options = {}) {
  const ttlMs = cooldownMs(options);
  if (ttlMs <= 0) return;

  const value = String(Date.now() + ttlMs);
  if (typeof redisClient.psetex === 'function') {
    await redisClient.psetex(key, ttlMs, value);
    return;
  }
  await redisClient.set(key, value, 'PX', ttlMs);
}

async function withAccountExecutionLock(redisClient, job, handler, options = {}) {
  if (!shouldSerializeAccountJob(job?.data)) {
    return handler();
  }

  const key = lockKey(job.data.accountId);
  const highRiskCooldownKey = cooldownKey(job.data.accountId);
  const throttle = shouldThrottleAccountJob(job.data);
  const token = `${job.data.operationId || job.id || 'job'}:${randomUUID()}`;
  const lock = await acquireLock(redisClient, key, token, options);
  const refreshIntervalMs = Math.max(Math.floor(lock.ttlMs / 3), 10000);
  const refreshTimer = setInterval(() => {
    refreshLock(redisClient, lock.key, lock.token, lock.ttlMs).catch((error) => {
      console.error(`Failed to refresh account execution lock: ${lock.key}`, error);
    });
  }, refreshIntervalMs);

  refreshTimer.unref?.();

  let handlerStarted = false;
  try {
    if (typeof job.progress === 'function') {
      await job.progress('同じXアカウントの実行を直列化しています。').catch(() => {});
    }
    if (throttle) {
      await waitForCooldown(redisClient, highRiskCooldownKey, options);
    }
    handlerStarted = true;
    return await handler();
  } finally {
    if (throttle && handlerStarted) {
      await setAccountCooldown(redisClient, highRiskCooldownKey, options).catch((error) => {
        console.error(`Failed to set account high-risk cooldown: ${highRiskCooldownKey}`, error);
      });
    }
    clearInterval(refreshTimer);
    await releaseLock(redisClient, lock.key, lock.token).catch((error) => {
      console.error(`Failed to release account execution lock: ${lock.key}`, error);
    });
  }
}

export {
  acquireLock,
  cooldownKey,
  lockKey,
  setAccountCooldown,
  shouldSerializeAccountJob,
  shouldThrottleAccountJob,
  waitForCooldown,
  withAccountExecutionLock,
};
