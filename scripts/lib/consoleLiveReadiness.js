const truthyValues = new Set(['1', 'true', 'yes', 'on']);

export function envBool(env, name) {
  return truthyValues.has(String(env[name] || '').trim().toLowerCase());
}

export function envList(env, name) {
  return String(env[name] || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

export function unique(values) {
  return [...new Set(values)];
}

export function parseLiveReadinessEnv(env = process.env) {
  const liveCookies = [
    env.XACTIONS_LIVE_ACCOUNT_A_COOKIE,
    env.XACTIONS_LIVE_ACCOUNT_B_COOKIE,
  ].map((value) => String(value || '').trim());
  const requestedIds = unique([
    ...envList(env, 'XACTIONS_LIVE_ACCOUNT_IDS'),
    env.XACTIONS_LIVE_ACCOUNT_A_ID,
    env.XACTIONS_LIVE_ACCOUNT_B_ID,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const requestedUsernames = unique([
    ...envList(env, 'XACTIONS_LIVE_ACCOUNT_USERNAMES'),
    env.XACTIONS_LIVE_ACCOUNT_A_USERNAME,
    env.XACTIONS_LIVE_ACCOUNT_B_USERNAME,
  ]
    .map((value) => String(value || '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean));
  const useExisting = envBool(env, 'XACTIONS_LIVE_USE_EXISTING_ACCOUNTS');
  const selectorCount = [
    requestedIds.length > 0,
    requestedUsernames.length > 0,
    useExisting,
  ].filter(Boolean).length;
  const readyWithCookies = Boolean(liveCookies[0] && liveCookies[1] && liveCookies[0] !== liveCookies[1]);

  return {
    liveCookies,
    requestedIds,
    requestedUsernames,
    useExisting,
    selectorCount,
    readyWithCookies,
  };
}

export function liveCookieSummary(parsed) {
  return {
    accountA: Boolean(parsed.liveCookies[0]),
    accountB: Boolean(parsed.liveCookies[1]),
    bothPresent: Boolean(parsed.liveCookies[0] && parsed.liveCookies[1]),
    different: parsed.readyWithCookies,
  };
}

export function existingSelectorSummary(parsed) {
  return {
    ids: parsed.requestedIds.length,
    usernames: parsed.requestedUsernames.length,
    useFirstActive: parsed.useExisting,
    selectorCount: parsed.selectorCount,
  };
}

export function shouldUseExistingAccounts(env = process.env) {
  const parsed = parseLiveReadinessEnv(env);
  return parsed.requestedIds.length > 0
    || parsed.requestedUsernames.length > 0
    || parsed.useExisting;
}

export function evaluateLiveReadiness({
  env = process.env,
  user,
  activeAccounts = [],
  smokeUsername,
  profileTarget = '',
  requireProfileTarget = false,
}) {
  const parsed = parseLiveReadinessEnv(env);
  const activeIds = new Set(activeAccounts.map((account) => account.id));
  const activeUsernames = new Set(activeAccounts.map((account) => String(account.username || '').toLowerCase()));
  const readyWithIds = parsed.requestedIds.length === 2
    && parsed.requestedIds.every((id) => activeIds.has(id));
  const readyWithUsernames = parsed.requestedUsernames.length === 2
    && parsed.requestedUsernames.every((username) => activeUsernames.has(username));
  const readyWithFirstActive = parsed.useExisting && activeAccounts.length >= 2;
  const readyWithExistingAccounts = parsed.selectorCount === 1
    && (readyWithIds || readyWithUsernames || readyWithFirstActive);

  const reasons = [];
  if (!user) reasons.push(`Smoke user not found: ${smokeUsername}`);
  if (requireProfileTarget && !profileTarget) reasons.push('XACTIONS_LIVE_PROFILE_TARGET is empty.');
  if (parsed.liveCookies[0] && parsed.liveCookies[1] && parsed.liveCookies[0] === parsed.liveCookies[1]) {
    reasons.push('XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE must be different.');
  }
  if (parsed.selectorCount > 1) {
    reasons.push('Use only one existing-account selector at a time.');
  }
  if (!parsed.readyWithCookies && !readyWithExistingAccounts) {
    reasons.push('Provide two live cookies or select exactly two active existing XAccounts.');
  }

  const ready = Boolean(
    user
      && (!requireProfileTarget || profileTarget)
      && (parsed.readyWithCookies || readyWithExistingAccounts)
  );

  return {
    smokeUsername,
    smokeUserFound: Boolean(user),
    ...(requireProfileTarget ? { profileTarget } : {}),
    liveCookies: liveCookieSummary(parsed),
    existingSelectors: existingSelectorSummary(parsed),
    activeXAccounts: activeAccounts.length,
    verifiedActiveXAccounts: activeAccounts.filter((account) => account.lastVerifiedAt).length,
    accounts: activeAccounts.map((account) => ({
      id: account.id,
      username: account.username,
      ...(typeof account.status !== 'undefined' ? { status: account.status } : {}),
      isDefault: account.isDefault,
      verified: Boolean(account.lastVerifiedAt),
      ...(typeof account.updatedAt !== 'undefined' ? { updatedAt: account.updatedAt } : {}),
    })),
    readyWithCookies: parsed.readyWithCookies,
    readyWithExistingAccounts,
    ready,
    reasons,
  };
}
