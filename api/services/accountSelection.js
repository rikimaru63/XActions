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

function explicitAccountIdsFromQuery(query = {}) {
  const raw = [
    ...String(query.accountIds || '')
      .split(',')
      .map((item) => item.trim()),
    String(query.accountId || '').trim(),
  ];

  return [...new Set(raw.filter(Boolean))];
}

function assertAccountSelectionLimit(accountIds = []) {
  const count = new Set(accountIds.filter(Boolean)).size;
  if (count > MAX_ACCOUNT_SELECTION) {
    const error = new Error(`一度に選べるXアカウントは${MAX_ACCOUNT_SELECTION}件までです。`);
    error.statusCode = 400;
    throw error;
  }
}

function operationAccountHistoryWhere(accountIds = []) {
  const uniqueAccountIds = [...new Set(accountIds
    .map((accountId) => String(accountId || '').trim())
    .filter(Boolean))];

  if (!uniqueAccountIds.length) return {};

  const accountId = uniqueAccountIds.length === 1
    ? uniqueAccountIds[0]
    : { in: uniqueAccountIds };

  return {
    OR: [
      { accountId },
      { childOperations: { some: { accountId } } },
    ],
  };
}

export {
  MAX_ACCOUNT_SELECTION,
  assertAccountSelectionLimit,
  explicitAccountIdsFromBody,
  explicitAccountIdsFromQuery,
  operationAccountHistoryWhere,
};
