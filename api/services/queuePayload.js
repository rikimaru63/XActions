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

function sanitizeQueueJobData(jobData = {}) {
  const hadSessionCookie = hasSensitiveQueueKey(jobData, 'sessionCookie');
  const sanitized = sanitizeQueueValue(jobData);

  if (hadSessionCookie && sanitized.userId && !sanitized.accountId) {
    sanitized.authMethod = 'session';
  }

  return sanitized;
}

export {
  hasSensitiveQueueKey,
  sanitizeQueueJobData,
  sanitizeQueueValue,
  sensitiveQueueKeys,
};
