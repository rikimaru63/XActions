import { parseJson } from './consoleActions.js';
import { decrypt, encrypt } from './sessionCrypto.js';

function buildEncryptedRetryConfig(config = {}) {
  if (!config || typeof config !== 'object') return {};
  return {
    encryptedRetryConfig: encrypt(JSON.stringify(config)),
    hasRetryConfig: true,
  };
}

function decryptRetryConfig(operationConfig = {}) {
  if (!operationConfig?.encryptedRetryConfig) return {};
  const decrypted = decrypt(operationConfig.encryptedRetryConfig);
  return parseJson(decrypted) || {};
}

function recoverRetryConfig(operationConfig = {}, overrideConfig = {}) {
  const {
    accountIds,
    childCount,
    encryptedRetryConfig,
    hasRetryConfig,
    isBatch,
    mode,
    retryOf,
    ...visibleConfig
  } = operationConfig || {};

  return {
    ...decryptRetryConfig(operationConfig),
    ...visibleConfig,
    ...overrideConfig,
  };
}

export {
  buildEncryptedRetryConfig,
  decryptRetryConfig,
  recoverRetryConfig,
};
