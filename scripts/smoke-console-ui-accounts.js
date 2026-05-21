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
      username: `${accountPrefix}active_a_${smokeId}`,
      displayName: 'Smoke UI Active A',
      status: 'active',
      isDefault: true,
      error: null,
    },
    {
      username: `${accountPrefix}active_b_${smokeId}`,
      displayName: 'Smoke UI Active B',
      status: 'active',
      isDefault: false,
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

function isMockedUiListRequest(request) {
  if (request.method() !== 'GET') return false;
  const url = new URL(request.url());
  return url.pathname === '/api/console/history' || url.pathname === '/api/scheduled-actions';
}

function accountIdSet(ids) {
  return [...new Set(ids.filter(Boolean))].sort();
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
  const filterRequests = [];

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
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (isMockedUiListRequest(request)) {
      const url = new URL(request.url());
      filterRequests.push({
        path: url.pathname,
        featureId: url.searchParams.get('featureId') || '',
        accountIds: accountIdSet((url.searchParams.get('accountIds') || '').split(',')),
      });
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(url.pathname === '/api/console/history' ? { operations: [] } : { schedules: [] }),
      });
      return;
    }
    request.continue();
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

  const activeAccounts = accounts.filter((account) => account.status === 'active');
  const defaultAccount = activeAccounts.find((account) => account.isDefault);
  const secondaryAccount = activeAccounts.find((account) => !account.isDefault);
  const selectedAccountIds = accountIdSet(activeAccounts.map((account) => account.id));

  await page.click(`#account-list [data-account-sidebar-choice][value="${secondaryAccount.id}"]`);
  await page.waitForFunction(
    (id) => document.querySelector(`#account-list [data-account-sidebar-choice][value="${id}"]`)?.checked,
    {},
    secondaryAccount.id
  );
  await page.click('.tabs [data-tab="schedule"]');
  await page.waitForFunction(() => document.querySelector('.tabs [data-tab="schedule"]')?.classList.contains('active'));
  await page.click('.tabs [data-tab="history"]');
  await page.waitForFunction(() => document.querySelector('.tabs [data-tab="history"]')?.classList.contains('active'));
  await page.waitForFunction(
    (ids) => {
      const selected = [...document.querySelectorAll('#account-list [data-account-sidebar-choice]:checked')].map((item) => item.value).sort();
      return selected.join(',') === ids.join(',');
    },
    {},
    selectedAccountIds
  );

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

  const expiredAccount = accounts.find((account) => account.status === 'expired');
  const defaultSidebar = sidebar.items.find((item) => item.accountId === defaultAccount.id);
  const secondarySidebar = sidebar.items.find((item) => item.accountId === secondaryAccount.id);
  const expiredSidebar = sidebar.items.find((item) => item.accountId === expiredAccount.id);
  const activeCards = activeAccounts.map((account) => management.cards.find((card) => card.accountId === account.id));
  const expiredCard = management.cards.find((card) => card.accountId === expiredAccount.id);
  const filterChecks = {
    historyByAccounts: filterRequests.some((request) => (
      request.path === '/api/console/history'
      && request.featureId === 'targetEngage'
      && request.accountIds.join(',') === selectedAccountIds.join(',')
    )),
    schedulesByAccounts: filterRequests.some((request) => (
      request.path === '/api/scheduled-actions'
      && request.featureId === 'targetEngage'
      && request.accountIds.join(',') === selectedAccountIds.join(',')
    )),
  };
  const blockingBadResponses = badResponses.filter((item) => !isIgnorableBadResponse(item));
  const blockingConsoleErrors = consoleErrors.filter((item) => !item.includes('Failed to load resource'));

  const ok = sidebar.accountName === `@${defaultAccount.username}`
    && sidebar.accountState === '3件 / 2件が実行可能'
    && defaultSidebar
    && !defaultSidebar.disabled
    && defaultSidebar.text.includes('デフォルト')
    && secondarySidebar
    && !secondarySidebar.disabled
    && secondarySidebar.text.includes(`@${secondaryAccount.username}`)
    && expiredSidebar
    && expiredSidebar.disabled
    && expiredSidebar.disabledByStatus
    && expiredSidebar.text.includes('期限切れ')
    && management.detailTitle === 'X連携'
    && activeCards.every((card) => card?.badge === '連携済み')
    && expiredCard?.badge === '期限切れ'
    && expiredCard?.text.includes('Smoke UI expired session')
    && filterChecks.historyByAccounts
    && filterChecks.schedulesByAccounts
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
    filterChecks,
    filterRequests,
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
