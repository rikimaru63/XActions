const MAX_ACCOUNT_SELECTION = 2;

function explicitAccountIdsFromBody(body = {}) {
  const raw = Array.isArray(body.accountIds)
    ? body.accountIds
    : typeof body.accountId !== 'undefined'
      ? [body.accountId]
      : [];

  return [...new Set(raw
    .map((accountId) => String(accountId || '').trim())
    .filter(Boolean))];
}

function assertAccountSelectionLimit(accountIds = []) {
  const count = new Set(accountIds.filter(Boolean)).size;
  if (count > MAX_ACCOUNT_SELECTION) {
    const error = new Error(`一度に選べるXアカウントは${MAX_ACCOUNT_SELECTION}件までです。`);
    error.statusCode = 400;
    throw error;
  }
}

export {
  MAX_ACCOUNT_SELECTION,
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
};
