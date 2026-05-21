import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  puppeteerLaunchOptions,
  resolvePuppeteerExecutablePath,
} from '../src/puppeteerLaunchOptions.js';

puppeteer.use(StealthPlugin());

const executablePath = resolvePuppeteerExecutablePath();
if (executablePath && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.PUPPETEER_EXECUTABLE_PATH = executablePath;
}

const smokeUrl = process.env.XACTIONS_HEADLESS_SMOKE_URL
  || 'data:text/html,%3Ctitle%3Exactions-headless-smoke%3C%2Ftitle%3E%3Cmain%3Eok%3C%2Fmain%3E';
const smokeCookie = process.env.XACTIONS_HEADLESS_SMOKE_COOKIE || 'auth_token=fake; ct0=fake';
const launchArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

async function readSmokePage(page) {
  await page.goto(smokeUrl, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  const text = await page.$eval('main', (node) => node.textContent);
  return { title, text };
}

async function verifyDirectPuppeteer() {
  const browser = await puppeteer.launch(puppeteerLaunchOptions({
    headless: 'new',
    args: launchArgs,
  }));

  try {
    const page = await browser.newPage();
    try {
      return await readSmokePage(page);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function verifyBrowserAutomation() {
  const { default: browserAutomation, closeBrowser } = await import('../api/services/browserAutomation.js');
  const page = await browserAutomation.createPage(smokeCookie);

  try {
    return await readSmokePage(page);
  } finally {
    await page.close();
    await closeBrowser();
  }
}

try {
  const direct = await verifyDirectPuppeteer();
  const service = await verifyBrowserAutomation();

  console.log(JSON.stringify({
    ok: direct.text === 'ok' && service.text === 'ok',
    direct,
    service,
    executablePath,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
  }, null, 2));
  process.exit(1);
}
