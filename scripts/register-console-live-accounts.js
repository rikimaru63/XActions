import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../api/services/sessionCrypto.js';
import browserAutomation from '../api/services/browserAutomation.js';
import { evaluateLiveReadiness } from './lib/consoleLiveReadiness.js';

const prisma = new PrismaClient();

const smokeUsername = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const verifyCookies = !['0', 'false', 'no', 'off'].includes(
  String(process.env.XACTIONS_REGISTER_LIVE_ACCOUNTS_VERIFY || 'true').trim().toLowerCase()
);

function normalizeUsername(username = '') {
  return String(username).trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

async function readStdinLines() {
  if (process.stdin.isTTY) return [];
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.split(/\r?\n/);
}

function accountInput(lines, slot) {
  const index = slot === 'A' ? 0 : 1;
  const username = normalizeUsername(process.env[`XACTIONS_LIVE_ACCOUNT_${slot}_USERNAME`]);
  const cookie = String(lines[index] || process.env[`XACTIONS_LIVE_ACCOUNT_${slot}_COOKIE`] || '').trim();
  return { slot, username, cookie };
}

function assertInput(accounts) {
  for (const account of accounts) {
    if (!account.username) throw new Error(`XACTIONS_LIVE_ACCOUNT_${account.slot}_USERNAME is required.`);
    if (!account.cookie) throw new Error(`X Cookie ${account.slot} is required via stdin or env.`);
  }
  if (accounts[0].username.toLowerCase() === accounts[1].username.toLowerCase()) {
    throw new Error('Two different X usernames are required.');
  }
  if (accounts[0].cookie === accounts[1].cookie) {
    throw new Error('Two different X cookies are required.');
  }
}

async function verifySessionCookie(cookie) {
  const page = await browserAutomation.createPage(cookie);
  try {
    await browserAutomation.navigateToTwitter(page);
    return await browserAutomation.checkAuthentication(page);
  } finally {
    await page.close();
  }
}

async function ensureSingleDefault(userId, accountId) {
  await prisma.xAccount.updateMany({
    where: { userId, id: { not: accountId } },
    data: { isDefault: false },
  });
}

async function upsertAccount(user, account, shouldDefault) {
  const now = new Date();
  const existingDefault = await prisma.xAccount.findFirst({
    where: { userId: user.id, isDefault: true },
    select: { id: true },
  });
  const isDefault = shouldDefault || !existingDefault;

  const saved = await prisma.xAccount.upsert({
    where: {
      userId_username: {
        userId: user.id,
        username: account.username,
      },
    },
    create: {
      userId: user.id,
      username: account.username,
      displayName: account.username,
      encryptedCookie: encrypt(account.cookie),
      authMethod: 'session',
      status: 'active',
      isDefault,
      lastVerifiedAt: now,
      error: null,
    },
    update: {
      displayName: account.username,
      encryptedCookie: encrypt(account.cookie),
      authMethod: 'session',
      status: 'active',
      ...(isDefault ? { isDefault: true } : {}),
      lastVerifiedAt: now,
      error: null,
    },
  });

  if (isDefault || saved.isDefault) await ensureSingleDefault(user.id, saved.id);
  return saved;
}

async function main() {
  const stdinLines = await readStdinLines();
  const accounts = [accountInput(stdinLines, 'A'), accountInput(stdinLines, 'B')];
  assertInput(accounts);

  const user = await prisma.user.findUnique({
    where: { username: smokeUsername },
    select: { id: true, username: true },
  });
  if (!user) throw new Error(`Smoke user not found: ${smokeUsername}`);

  const verification = [];
  if (verifyCookies) {
    for (const account of accounts) {
      const verified = await verifySessionCookie(account.cookie);
      verification.push({ username: account.username, verified });
      if (!verified) throw new Error(`X login check failed for @${account.username}.`);
    }
  }

  const savedAccounts = [];
  for (const [index, account] of accounts.entries()) {
    const saved = await upsertAccount(user, account, index === 0);
    savedAccounts.push(saved);
  }

  const activeAccounts = await prisma.xAccount.findMany({
    where: { userId: user.id, status: 'active' },
    select: {
      id: true,
      username: true,
      status: true,
      isDefault: true,
      lastVerifiedAt: true,
      updatedAt: true,
    },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    take: 10,
  });

  console.log(JSON.stringify({
    ok: true,
    smokeUsername,
    verifyCookies,
    accounts: savedAccounts.map((account) => ({
      id: account.id,
      username: account.username,
      status: account.status,
      isDefault: account.isDefault,
      verified: Boolean(account.lastVerifiedAt),
    })),
    ...(verification.length ? { verification } : {}),
    readiness: evaluateLiveReadiness({
      user,
      activeAccounts,
      smokeUsername,
      env: { XACTIONS_LIVE_USE_EXISTING_ACCOUNTS: 'true' },
    }),
  }, null, 2));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
