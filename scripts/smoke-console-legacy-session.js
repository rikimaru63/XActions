import 'dotenv/config';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { decrypt, encrypt } from '../api/services/sessionCrypto.js';

const prisma = new PrismaClient();

const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const smokeId = `legacy_${Date.now()}_${randomUUID().slice(0, 8)}`;
const username = `smoke_legacy_session_${smokeId}`;
const twitterUsername = `legacy_${smokeId}`;
const rawCookie = `auth_token=${smokeId}; ct0=${smokeId}_csrf`;
const created = { userIds: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        ...(created.userIds.length ? [{ id: { in: created.userIds } }] : []),
        { username: { startsWith: 'smoke_legacy_session_' } },
      ],
    },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  return { users: userIds.length };
}

async function requestJson(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GET ${path} failed with HTTP ${response.status}: ${body?.error || text}`);
  }
  return body;
}

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required.');
  assert(process.env.JWT_SECRET, 'JWT_SECRET is required.');

  await cleanup();

  const user = await prisma.user.create({
    data: {
      username,
      twitterUsername,
      sessionCookie: encrypt(rawCookie),
      authMethod: 'session',
    },
    select: { id: true, username: true, twitterUsername: true },
  });
  created.userIds.push(user.id);

  const before = await prisma.xAccount.count({ where: { userId: user.id } });
  assert(before === 0, `Expected no XAccounts before compatibility migration, got ${before}.`);

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const consoleAccounts = await requestJson('/api/console/accounts', token);
  const accountsApi = await requestJson('/api/accounts', token);

  const rows = await prisma.xAccount.findMany({
    where: { userId: user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  assert(rows.length === 1, `Expected one migrated XAccount, got ${rows.length}.`);
  const account = rows[0];
  assert(account.username === twitterUsername, `Migrated username mismatch: ${account.username}`);
  assert(account.isDefault === true, 'Migrated XAccount is not default.');
  assert(account.status === 'active', `Migrated XAccount status mismatch: ${account.status}`);
  assert(decrypt(account.encryptedCookie) === rawCookie, 'Migrated XAccount cookie did not decrypt to the legacy cookie.');
  assert(consoleAccounts.accounts?.[0]?.id === account.id, '/api/console/accounts did not expose migrated account.');
  assert(accountsApi.accounts?.[0]?.id === account.id, '/api/accounts did not expose migrated account.');
  assert(accountsApi.defaultAccountId === account.id, '/api/accounts did not expose migrated account as default.');

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    smokeId,
    user: {
      id: user.id,
      username: user.username,
      twitterUsername: user.twitterUsername,
    },
    migratedAccount: {
      id: account.id,
      username: account.username,
      status: account.status,
      isDefault: account.isDefault,
      cookieRoundTrip: true,
    },
    api: {
      consoleAccounts: consoleAccounts.accounts?.length || 0,
      accounts: accountsApi.accounts?.length || 0,
      defaultAccountId: accountsApi.defaultAccountId,
    },
  }, null, 2));
}

try {
  await main();
} finally {
  try {
    const cleanupResult = await cleanup();
    const residue = await prisma.user.count({
      where: { username: { startsWith: 'smoke_legacy_session_' } },
    });
    assert(residue === 0, `Legacy session smoke residue remains: ${residue}`);
    if (process.env.XACTIONS_AUDIT_VERBOSE === 'true') {
      console.log(JSON.stringify({ cleanup: cleanupResult }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}
