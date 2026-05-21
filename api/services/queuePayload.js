import { decrypt, encrypt } from './sessionCrypto.js';

const sensitiveQueueKeys = new Set([
  'sessionCookie',
  'encryptedCookie',
  'cookie',
  'cookies',
  'authToken',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
]);

const encryptedConfigKeysByType = new Map([
  ['agentCommand', ['text']],
  ['analyzeSentiment', ['text']],
  ['autoComment', ['comment']],
  ['createPoll', ['question', 'options']],
  ['postThread', ['tweets']],
  ['postTweet', ['text']],
  ['priceCorrelation', ['tweets']],
  ['replyToTweet', ['text']],
  ['runWorkflow', ['context']],
  ['sendDM', ['message']],
  ['targetEngage', ['dmMessage']],
]);

function sanitizeQueueValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeQueueValue(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveQueueKeys.has(key))
      .map(([key, item]) => [key, sanitizeQueueValue(item)])
  );
}

function hasSensitiveQueueKey(value, keyName = null) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveQueueKey(item, keyName));

  return Object.entries(value).some(([key, item]) => (
    sensitiveQueueKeys.has(key)
      && (!keyName || key === keyName)
  ) || hasSensitiveQueueKey(item, keyName));
}

function splitEncryptedJobConfig(type, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { visibleConfig: config, encryptedJobConfig: null };
  }

  const keys = encryptedConfigKeysByType.get(type) || [];
  if (!keys.length) return { visibleConfig: config, encryptedJobConfig: null };

  const visibleConfig = { ...config };
  const encryptedConfig = {};

  for (const key of keys) {
    if (typeof visibleConfig[key] !== 'undefined') {
      encryptedConfig[key] = visibleConfig[key];
      delete visibleConfig[key];
    }
  }

  if (!Object.keys(encryptedConfig).length) {
    return { visibleConfig, encryptedJobConfig: null };
  }

  return {
    visibleConfig,
    encryptedJobConfig: encrypt(JSON.stringify(encryptedConfig)),
  };
}

function sanitizeQueueJobData(jobData = {}) {
  const hadSessionCookie = hasSensitiveQueueKey(jobData, 'sessionCookie');
  const sanitized = sanitizeQueueValue(jobData);
  const { visibleConfig, encryptedJobConfig } = splitEncryptedJobConfig(
    sanitized.type,
    sanitized.config
  );

  sanitized.config = visibleConfig;
  if (encryptedJobConfig) {
    sanitized.encryptedJobConfig = encryptedJobConfig;
    sanitized.hasEncryptedJobConfig = true;
  }

  if (hadSessionCookie && sanitized.userId && !sanitized.accountId) {
    sanitized.authMethod = 'session';
  }

  return sanitized;
}

function decryptEncryptedJobConfig(jobData = {}) {
  if (!jobData.encryptedJobConfig) return {};
  return JSON.parse(decrypt(jobData.encryptedJobConfig));
}

function restoreQueueJobConfig(jobData = {}, config = jobData.config || {}) {
  return {
    ...(config || {}),
    ...decryptEncryptedJobConfig(jobData),
  };
}

export {
  decryptEncryptedJobConfig,
  hasSensitiveQueueKey,
  restoreQueueJobConfig,
  sanitizeQueueJobData,
  sanitizeQueueValue,
  sensitiveQueueKeys,
};
