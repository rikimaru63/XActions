import { existsSync } from 'fs';

const executableCandidates = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function resolvePuppeteerExecutablePath() {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;
  return executableCandidates.find((candidate) => existsSync(candidate)) || null;
}

function puppeteerLaunchOptions(options = {}) {
  const executablePath = options.executablePath || resolvePuppeteerExecutablePath();

  return {
    ...options,
    ...(executablePath ? { executablePath } : {}),
  };
}

export {
  puppeteerLaunchOptions,
  resolvePuppeteerExecutablePath,
};
