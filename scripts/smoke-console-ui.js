import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { puppeteerLaunchOptions } from '../src/puppeteerLaunchOptions.js';

puppeteer.use(StealthPlugin());

const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.XACTIONS_SMOKE_TOKEN || '';
const username = process.env.XACTIONS_SMOKE_USERNAME || 'test_account_20260521092255';
const password = process.env.XACTIONS_SMOKE_PASSWORD || '';

async function resolveToken() {
  if (token) return token;
  if (username && process.env.JWT_SECRET) {
    const prisma = new PrismaClient();
    try {
      const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (!user) throw new Error(`Smoke user not found: ${username}`);
      return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '20m' });
    } finally {
      await prisma.$disconnect();
    }
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

function isIgnorableBadResponse(item) {
  return item.includes('/favicon.ico');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const authToken = await resolveToken();
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
    if (response.status() >= 400) {
      badResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.trim());
  });

  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((value) => localStorage.setItem('authToken', value), authToken);
  await page.goto(`${baseUrl}/console`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#feature-list .feature-row', { timeout: 30000 });

  const result = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim(),
    featureCount: document.querySelectorAll('#feature-list .feature-row').length,
    navCount: document.querySelectorAll('#category-nav button').length,
    detailTitle: document.querySelector('#detail-title')?.textContent?.trim(),
    tabIds: [...document.querySelectorAll('.tabs button')].map((element) => element.dataset.tab),
    tabs: [...document.querySelectorAll('.tabs button')].map((element) => element.textContent.trim()),
    bodySample: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 220),
  }));

  await page.click('[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector('[data-mode="live"]')?.classList.contains('active'));
  await page.click('#execute-btn');
  await page.waitForFunction(() => !document.querySelector('#confirm-modal')?.classList.contains('hidden'));
  const confirmation = await page.evaluate(() => ({
    visible: !document.querySelector('#confirm-modal')?.classList.contains('hidden'),
    title: document.querySelector('#confirm-title')?.textContent?.trim(),
    message: document.querySelector('#confirm-message')?.textContent?.trim(),
    confirmText: document.querySelector('#confirm-submit')?.textContent?.trim(),
    cancelText: document.querySelector('#confirm-cancel')?.textContent?.trim(),
  }));
  await page.click('#confirm-cancel');
  await page.waitForFunction(() => document.querySelector('#confirm-modal')?.classList.contains('hidden'));
  await page.click('[data-mode="dryRun"]');
  await page.waitForFunction(() => document.querySelector('[data-mode="dryRun"]')?.classList.contains('active'));

  const categories = await page.evaluate(() => [...document.querySelectorAll('#category-nav button')].map((button) => {
    const [available, total] = (button.querySelector('.count')?.textContent || '0/0')
      .split('/')
      .map((value) => Number(value.trim()));
    return {
      id: button.dataset.category,
      label: button.querySelector('span')?.textContent?.trim(),
      available,
      total,
    };
  }));

  const categoryResults = [];
  for (const category of categories) {
    await page.click(`#category-nav [data-category="${category.id}"]`);
    await page.waitForFunction(
      (categoryId) => document.querySelector(`#category-nav [data-category="${categoryId}"]`)?.classList.contains('active'),
      {},
      category.id
    );
    await page.waitForSelector('#feature-list');

    const categoryState = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#feature-list .feature-row')].map((row) => ({
        id: row.dataset.feature,
        title: row.querySelector('.feature-title')?.textContent?.trim(),
      }));
      return {
        rows,
        selectedFeatureId: document.querySelector('#feature-list .feature-row.active')?.dataset.feature || null,
        detailTitle: document.querySelector('#detail-title')?.textContent?.trim() || '',
      };
    });

    if (categoryState.rows[0]) {
      await page.click(`#feature-list [data-feature="${categoryState.rows[0].id}"]`);
      await page.waitForFunction(
        (featureId) => document.querySelector(`#feature-list [data-feature="${featureId}"]`)?.classList.contains('active'),
        {},
        categoryState.rows[0].id
      );
    }

    const tabStates = [];
    for (const tabId of ['settings', 'schedule', 'history']) {
      await page.click(`.tabs [data-tab="${tabId}"]`);
      await page.waitForFunction(
        (id) => document.querySelector(`.tabs [data-tab="${id}"]`)?.classList.contains('active'),
        {},
        tabId
      );
      await delay(150);
      tabStates.push(await page.evaluate((id) => {
        const panel = document.querySelector(`#${id}-panel`);
        return {
          id,
          visible: !!panel && !panel.classList.contains('hidden'),
          textLength: panel?.textContent?.trim().length || 0,
        };
      }, tabId));
    }

    categoryResults.push({
      ...category,
      featureCount: categoryState.rows.length,
      firstFeature: categoryState.rows[0]?.title || null,
      tabStates,
    });
  }

  const visitedFeatureTotal = categoryResults.reduce((total, category) => total + category.featureCount, 0);
  const blockingBadResponses = badResponses.filter((item) => !isIgnorableBadResponse(item));
  const blockingConsoleErrors = consoleErrors.filter((item) => !item.includes('Failed to load resource'));
  const ok = result.title.includes('コンソール')
    && result.h1 === 'コンソール'
    && result.lang === 'ja'
    && result.navCount >= 10
    && result.featureCount > 0
    && confirmation.visible
    && confirmation.title === '実行前の確認'
    && confirmation.message.includes('実際に操作されます')
    && confirmation.confirmText === '実行する'
    && confirmation.cancelText === '戻る'
    && visitedFeatureTotal >= 33
    && categoryResults.every((category) => category.featureCount === category.total)
    && categoryResults.every((category) => category.tabStates.every((tab) => tab.visible && tab.textLength > 0))
    && result.tabIds.join(',') === 'settings,schedule,history'
    && result.tabs.includes('設定')
    && result.tabs.includes('予約')
    && result.tabs.includes('履歴')
    && pageErrors.length === 0
    && blockingConsoleErrors.length === 0
    && blockingBadResponses.length === 0
    && failedRequests.length === 0;

  console.log(JSON.stringify({
    ok,
    baseUrl,
    result,
    confirmation,
    categoryResults,
    visitedFeatureTotal,
    pageErrors,
    consoleErrors,
    badResponses,
    failedRequests,
  }, null, 2));

  if (!ok) process.exit(1);
} finally {
  await browser.close();
}
