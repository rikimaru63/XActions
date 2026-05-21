import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { puppeteerLaunchOptions } from '../src/puppeteerLaunchOptions.js';

puppeteer.use(StealthPlugin());

const baseUrl = (process.env.XACTIONS_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const token = process.env.XACTIONS_SMOKE_TOKEN || '';
const username = process.env.XACTIONS_SMOKE_USERNAME || '';
const password = process.env.XACTIONS_SMOKE_PASSWORD || '';

async function resolveToken() {
  if (token) return token;
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

const authToken = await resolveToken();
const browser = await puppeteer.launch(puppeteerLaunchOptions({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
}));

try {
  const page = await browser.newPage();
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
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim(),
    featureCount: document.querySelectorAll('#feature-list .feature-row').length,
    navCount: document.querySelectorAll('#category-nav button').length,
    detailTitle: document.querySelector('#detail-title')?.textContent?.trim(),
    tabs: [...document.querySelectorAll('.tabs button')].map((element) => element.textContent.trim()),
    bodySample: document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 220),
  }));

  const blockingBadResponses = badResponses.filter((item) => !isIgnorableBadResponse(item));
  const blockingConsoleErrors = consoleErrors.filter((item) => !item.includes('Failed to load resource'));
  const ok = result.title.includes('コンソール')
    && result.h1 === 'コンソール'
    && result.navCount >= 10
    && result.featureCount > 0
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
    pageErrors,
    consoleErrors,
    badResponses,
    failedRequests,
  }, null, 2));

  if (!ok) process.exit(1);
} finally {
  await browser.close();
}
