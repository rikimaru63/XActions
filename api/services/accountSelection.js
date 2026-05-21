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

export {
  explicitAccountIdsFromBody,
};
