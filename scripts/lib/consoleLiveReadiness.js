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

function plural(value, noun) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function liveReadinessNextAction({
  ready,
  user,
  smokeUsername,
  profileTarget,
  requireProfileTarget,
  parsed,
  readyWithExistingAccounts,
  activeAccounts,
  requiredAccounts,
  remainingAccounts,
}) {
  if (ready) {
    return 'Run smoke:console-live-readonly using the selected live account source.';
  }
  if (!user) {
    return `Create or verify the smoke user (${smokeUsername}), then rerun SOURCE=diagnose.`;
  }
  if (requireProfileTarget && !profileTarget) {
    return 'Set XACTIONS_LIVE_PROFILE_TARGET, then rerun SOURCE=diagnose.';
  }
  if (parsed.liveCookies[0] && parsed.liveCookies[1] && parsed.liveCookies[0] === parsed.liveCookies[1]) {
    return 'Provide two different X cookies in XACTIONS_LIVE_ACCOUNT_A_COOKIE and XACTIONS_LIVE_ACCOUNT_B_COOKIE.';
  }
  if (parsed.selectorCount > 1) {
    return 'Use only one existing-account selector: account IDs, usernames, or XACTIONS_LIVE_USE_EXISTING_ACCOUNTS.';
  }
  if (parsed.liveCookies.some(Boolean) && !parsed.readyWithCookies) {
    return 'Provide both live cookies, or remove cookie env vars and select two existing active XAccounts.';
  }
  if (parsed.selectorCount === 1 && !readyWithExistingAccounts) {
    if (parsed.requestedIds.length > 0 && parsed.requestedIds.length !== requiredAccounts) {
      return `Select exactly ${requiredAccounts} active XAccount IDs.`;
    }
    if (parsed.requestedUsernames.length > 0 && parsed.requestedUsernames.length !== requiredAccounts) {
      return `Select exactly ${requiredAccounts} active XAccount usernames.`;
    }
    if (activeAccounts.length < requiredAccounts) {
      return `Register ${plural(remainingAccounts, 'more active XAccount')} with scripts/register-console-live-accounts-host.sh, then run SOURCE=existing.`;
    }
    return 'Verify the selected XAccounts are active for the smoke user, then rerun SOURCE=diagnose.';
  }
  if (activeAccounts.length >= requiredAccounts) {
    return 'Run XACTIONS_LIVE_READONLY_SOURCE=existing bash /tmp/xactions-live-readonly.sh.';
  }
  return `Register ${plural(remainingAccounts, 'more active XAccount')} with scripts/register-console-live-accounts-host.sh or provide two live cookies.`;
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
  const requiredAccounts = 2;
  const remainingAccounts = Math.max(requiredAccounts - activeAccounts.length, 0);
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
  const nextAction = liveReadinessNextAction({
    ready,
    user,
    smokeUsername,
    profileTarget,
    requireProfileTarget,
    parsed,
    readyWithExistingAccounts,
    activeAccounts,
    requiredAccounts,
    remainingAccounts,
  });

  return {
    smokeUsername,
    smokeUserFound: Boolean(user),
    ...(requireProfileTarget ? { profileTarget } : {}),
    liveCookies: liveCookieSummary(parsed),
    existingSelectors: existingSelectorSummary(parsed),
    activeXAccounts: activeAccounts.length,
    verifiedActiveXAccounts: activeAccounts.filter((account) => account.lastVerifiedAt).length,
    requiredAccounts,
    remainingAccounts,
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
    nextAction,
  };
}
