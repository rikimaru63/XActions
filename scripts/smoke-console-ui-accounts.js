import 'dotenv/config';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { encrypt } from '../api/services/sessionCrypto.js';
import { puppeteerLaunchOptions } from '../src/puppeteerLaunchOptions.js';

puppeteer.use(StealthPlugin());

const prisma = new PrismaClient();
const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.XACTIONS_SMOKE_TOKEN || '';
const username = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const password = process.env.XACTIONS_SMOKE_PASSWORD || '';
const smokeId = `ui_accounts_${Date.now()}_${randomUUID().slice(0, 8)}`;
const accountPrefix = 'smoke_console_ui_';
const created = { accountIds: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function resolveSmokeUser() {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });
  if (!user) throw new Error(`Smoke user not found: ${username}`);
  return user;
}

async function resolveToken(user) {
  if (token) return token;
  if (process.env.JWT_SECRET) {
    return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '20m' });
  }
  if (!username || !password) {
    throw new Error('Set XACTIONS_SMOKE_TOKEN or XACTIONS_SMOKE_USERNAME/XACTIONS_SMOKE_PASSWORD.');
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    throw new Error(body.error || `Login failed with HTTP ${response.status}`);
  }
  return body.token;
}

async function cleanupSmokeAccounts(userId) {
  const accounts = await prisma.xAccount.findMany({
    where: {
      userId,
      OR: [
        ...(created.accountIds.length ? [{ id: { in: created.accountIds } }] : []),
        { username: { contains: smokeId } },
        { username: { startsWith: accountPrefix } },
      ],
    },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length) {
    await prisma.xAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
  }
  return { accounts: accountIds.length };
}

async function createUiAccounts(userId) {
  const rows = [
    {
      username: `${accountPrefix}active_${smokeId}`,
      displayName: 'Smoke UI Active',
      status: 'active',
      isDefault: true,
      error: null,
    },
    {
      username: `${accountPrefix}expired_${smokeId}`,
      displayName: 'Smoke UI Expired',
      status: 'expired',
      isDefault: false,
      error: 'Smoke UI expired session',
    },
  ];

  const accounts = [];
  for (const [index, row] of rows.entries()) {
    const account = await prisma.xAccount.create({
      data: {
        userId,
        ...row,
        encryptedCookie: encrypt(`auth_token=${smokeId}_${index}; ct0=${smokeId}_csrf_${index}`),
        authMethod: 'session',
        lastVerifiedAt: new Date(),
      },
      select: {
        id: true,
        username: true,
        status: true,
        isDefault: true,
      },
    });
    accounts.push(account);
    created.accountIds.push(account.id);
  }
  return accounts;
}

function isIgnorableBadResponse(item) {
  return item.includes('/favicon.ico');
}

const user = await resolveSmokeUser();
await cleanupSmokeAccounts(user.id);
const accounts = await createUiAccounts(user.id);
const authToken = await resolveToken(user);
const browser = await puppeteer.launch(puppeteerLaunchOptions({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
}));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  const failedRequests = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.trim());
  });

  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((value) => localStorage.setItem('authToken', value), authToken);
  await page.goto(`${baseUrl}/console`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#account-list [data-account-sidebar-choice]', { timeout: 30000 });

  const sidebar = await page.evaluate(() => ({
    accountName: document.querySelector('#account-name')?.textContent?.trim(),
    accountState: document.querySelector('#account-state')?.textContent?.trim(),
    items: [...document.querySelectorAll('#account-list label.account-item')].map((item) => {
      const input = item.querySelector('[data-account-sidebar-choice]');
      return {
        accountId: input?.value,
        disabled: !!input?.disabled,
        disabledByStatus: input?.hasAttribute('data-disabled-by-status') || false,
        text: item.textContent.replace(/\s+/g, ' ').trim(),
      };
    }),
  }));

  await page.click('#category-nav [data-category="settings"]');
  await page.waitForFunction(() => document.querySelector('#category-nav [data-category="settings"]')?.classList.contains('active'));
  await page.click('#feature-list [data-feature="accounts"]');
  await page.waitForSelector('#settings-panel [data-account-card]', { timeout: 30000 });

  const management = await page.evaluate(() => ({
    detailTitle: document.querySelector('#detail-title')?.textContent?.trim(),
    cards: [...document.querySelectorAll('#settings-panel [data-account-card]')].map((card) => ({
      accountId: card.dataset.accountCard,
      badge: card.querySelector('.badge')?.textContent?.trim(),
      text: card.textContent.replace(/\s+/g, ' ').trim(),
    })),
  }));

  const activeAccount = accounts.find((account) => account.status === 'active');
  const expiredAccount = accounts.find((account) => account.status === 'expired');
  const activeSidebar = sidebar.items.find((item) => item.accountId === activeAccount.id);
  const expiredSidebar = sidebar.items.find((item) => item.accountId === expiredAccount.id);
  const activeCard = management.cards.find((card) => card.accountId === activeAccount.id);
  const expiredCard = management.cards.find((card) => card.accountId === expiredAccount.id);
  const blockingBadResponses = badResponses.filter((item) => !isIgnorableBadResponse(item));
  const blockingConsoleErrors = consoleErrors.filter((item) => !item.includes('Failed to load resource'));

  const ok = sidebar.accountName === `@${activeAccount.username}`
    && sidebar.accountState === '2件 / 1件が実行可能'
    && activeSidebar
    && !activeSidebar.disabled
    && activeSidebar.text.includes('デフォルト')
    && expiredSidebar
    && expiredSidebar.disabled
    && expiredSidebar.disabledByStatus
    && expiredSidebar.text.includes('期限切れ')
    && management.detailTitle === 'X連携'
    && activeCard?.badge === '連携済み'
    && expiredCard?.badge === '期限切れ'
    && expiredCard?.text.includes('Smoke UI expired session')
    && pageErrors.length === 0
    && blockingConsoleErrors.length === 0
    && blockingBadResponses.length === 0
    && failedRequests.length === 0;

  console.log(JSON.stringify({
    ok,
    baseUrl,
    smokeId,
    accounts,
    sidebar,
    management,
    pageErrors,
    consoleErrors,
    badResponses,
    failedRequests,
  }, null, 2));

  if (!ok) process.exit(1);
} finally {
  await browser.close();
  try {
    const cleanup = await cleanupSmokeAccounts(user.id);
    const residue = await prisma.xAccount.count({
      where: { userId: user.id, username: { startsWith: accountPrefix } },
    });
    assert(residue === 0, `UI account smoke residue remains: ${residue}`);
    if (process.env.XACTIONS_AUDIT_VERBOSE === 'true') {
      console.log(JSON.stringify({ cleanup }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}
