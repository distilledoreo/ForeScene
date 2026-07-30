import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const downloadDir = resolve(repoRoot, 'artifacts/goal-workflow-smoke');
const appUrl = await resolveAppUrl();
console.error(`[goal:smoke] Using ${appUrl}`);

const chromePath = await resolveChromePath();
console.error(`[goal:smoke] Browser: ${chromePath}`);
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9331);
const profileDir = resolve(repoRoot, '.tmp-goal-chrome-profile');

await rm(profileDir, { recursive: true, force: true });
await rm(downloadDir, { recursive: true, force: true });
await mkdir(profileDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' });

chrome.on('error', (error) => {
  console.error(`[goal:smoke] Failed to spawn browser: ${error.message}`);
  process.exitCode = 1;
});

try {
  const pageSocketUrl = await waitForPageSocket(debugPort);
  const client = await createCdpClient(pageSocketUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  }).catch(() => client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
  }));
  await client.send('Page.navigate', { url: appUrl });
  await waitFor(client, 'document.title === "ForeScene"', 'app shell');

  // Select the visible production mode explicitly; do not click a Build control behind the chooser.
  await clickOptionalButton(client, 'Open ForeScene', 4000, { exact: true });

  await waitFor(
    client,
    `([...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('Build'))
      || document.body.textContent.includes('Render 360'))`,
    'continuity shell',
  );

  // Build → graybox
  await clickWorkspaceTab(client, 'Build');
  await clickOptionalButton(client, 'Got it', 2000);
  await clickOptionalButton(client, 'Not right now', 1500);
  await clickButton(client, 'Render 360 Reference');
  await waitFor(
    client,
    `document.body.textContent.includes('Build is ready')
      || document.body.textContent.includes('Download Graybox')
      || document.body.textContent.includes('Re-render after scene changes')`,
    'graybox pano',
    60000,
  );
  await clickOptionalButton(client, 'Continue to Reference', 5000);
  await clickOptionalButton(client, 'Not right now', 1500);

  // Reference → approve
  await clickWorkspaceTab(client, 'Reference');
  await completeReferenceStep(client);
  await clickOptionalButton(client, 'Continue to Shots', 5000);
  await clickOptionalButton(client, 'Not right now', 1500);

  // Shots — land framing (no Review stage)
  await clickWorkspaceTab(client, 'Shots');
  await clickOptionalButton(client, 'Got it', 2000);
  await clickOptionalButton(client, 'Not right now', 1500);
  await waitFor(
    client,
    `document.body.textContent.includes('Capture')
      || document.body.textContent.includes('Camera')
      || document.querySelector('[data-shots-camera-shell]')`,
    'shots workspace',
  );

  // Projected-style occlusion: switch the visible viewport appearance and
  // confirm the engine reaches a terminal state. These controls now live in
  // the Shots chrome instead of the Camera settings drawer.
  await clickButton(client, 'Projected', 10000, { exact: true });
  await waitFor(
    client,
    `['ready', 'unavailable'].includes(
      document.querySelector('[data-testid="scene-viewport"]')?.dataset.occlusionStatus
    )`,
    'occlusion engine terminal state',
    60000,
  );

  // Capture a still if shutter is available.
  if (await isButtonEnabled(client, 'Capture')) {
    await clickButton(client, 'Capture');
    await waitFor(
      client,
      `document.querySelector('[data-shots-library-thumb] img') !== null`,
      'captured shot thumbnail',
      30000,
    );
  }
  await clickOptionalButton(client, 'Continue to Export', 4000);
  await clickOptionalButton(client, 'Not right now', 1500);

  // Export selected shots package (modern path — no AI Brief / Review)
  await clickWorkspaceTab(client, 'Export');
  await clickOptionalButton(client, 'Got it', 2000);
  await clickButton(client, 'Export Selected Shots');
  await waitFor(
    client,
    `document.querySelector('[data-export-last-export]') !== null
      || document.querySelector('[data-export-error]') !== null`,
    'package export completion',
    180000,
  );
  const exportError = await evaluate(
    client,
    `document.querySelector('[data-export-error]')?.textContent?.trim() || ''`,
  );
  if (exportError) throw new Error(`Package export failed: ${exportError}`);
  const zipPath = await waitForDownloadedZip(downloadDir, 30000);

  console.log(JSON.stringify({
    ok: true,
    zipPath,
    bytes: (await stat(zipPath)).size,
    flow: 'build → reference → shots → export',
  }, null, 2));
  await client.close();
} finally {
  chrome.kill();
}

async function resolveChromePath() {
  if (process.env.CHROME_PATH) {
    await assertExecutable(process.env.CHROME_PATH);
    return process.env.CHROME_PATH;
  }

  const candidates = platform() === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
          '/snap/bin/chromium',
        ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await assertExecutable(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    'No Chrome/Edge binary found. Set CHROME_PATH to a Chromium-based browser executable.',
  );
}

async function assertExecutable(path) {
  await access(path, fsConstants.X_OK).catch(async () => {
    // On Windows, X_OK is not always reliable; fall back to F_OK.
    await access(path, fsConstants.F_OK);
  });
}

async function resolveAppUrl() {
  const configured = process.env.FORESCENE_URL ?? process.env.CONTINUITY_STAGE_URL;
  if (configured) {
    return configured;
  }

  const ports = Array.from({ length: 11 }, (_, index) => 3000 + index);
  for (const port of ports) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const html = await response.text();
      if (html.includes('ForeScene') || html.includes('root')) return candidate;
    } catch {
      // Try the next dev-server port.
    }
  }

  throw new Error(
    'No ForeScene dev server found on ports 3000-3010. '
    + 'Start one with `npm run dev`, or set FORESCENE_URL.',
  );
}

async function waitForPageSocket(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((candidate) => candidate.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools endpoint did not become available.');
}

async function createCdpClient(socketUrl) {
  const socket = new WebSocket(socketUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: res, reject: rej } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rej(new Error(message.error.message));
    else res(message.result);
  });
  return {
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolvePromise, reject) => pending.set(id, { resolve: resolvePromise, reject }));
    },
    close() {
      socket.close();
    },
  };
}

function buttonMatchExpression(text, { exact = false } = {}) {
  const label = JSON.stringify(text);
  if (exact) {
    return `(candidate) => candidate.textContent?.trim() === ${label}
      || candidate.getAttribute('aria-label')?.trim() === ${label}`;
  }
  return `(candidate) => candidate.textContent?.includes(${label})
    || candidate.getAttribute('aria-label')?.includes(${label})`;
}

async function isButtonEnabled(client, text, { exact = false } = {}) {
  return evaluate(client, `
    (() => {
      const match = ${buttonMatchExpression(text, { exact })};
      const button = [...document.querySelectorAll('button')].find(match);
      return Boolean(button && !button.disabled && button.offsetParent !== null);
    })()
  `);
}

async function clickButton(client, text, timeout = 20000, { exact = false } = {}) {
  const start = Date.now();
  const match = buttonMatchExpression(text, { exact });
  while (Date.now() - start < timeout) {
    const clicked = await evaluate(client, `
      (() => {
        const button = [...document.querySelectorAll('button')].find(${match});
        if (!button || button.disabled || button.offsetParent === null) return false;
        button.click();
        return true;
      })()
    `);
    if (clicked) {
      await delay(300);
      return;
    }
    await delay(200);
  }
  const available = await evaluate(client, '[...document.querySelectorAll("button")].map((button) => button.textContent?.trim()).join(" | ")');
  throw new Error(`Could not find enabled button: ${text}. Available: ${available}`);
}

async function completeReferenceStep(client) {
  await clickOptionalButton(client, 'Got it');

  if (await isButtonEnabled(client, 'Use Attached Reference')) {
    await clickButton(client, 'Use Attached Reference');
    await waitFor(
      client,
      `document.body.textContent.includes("Check pano alignment")
        || document.body.textContent.includes("Approve as Reference")
        || document.body.textContent.includes("Start checking")`,
      'attached reference alignment',
    );
  }

  await clickOptionalButton(client, 'Start checking');
  await clickOptionalButton(client, 'Looks good enough', 3000);
  await clickButton(client, 'Approve as Reference');
  await waitFor(
    client,
    `document.body.textContent.includes("Reference is ready")
      || document.body.textContent.includes("Continue to Shots")
      || document.body.textContent.includes("Approve as Reference")`,
    'approved reference',
  );
}

async function clickWorkspaceTab(client, label, timeout = 20000) {
  const start = Date.now();
  const tabLabel = JSON.stringify(label);
  while (Date.now() - start < timeout) {
    const clicked = await evaluate(client, `
      (() => {
        const button = [...document.querySelectorAll('header nav button, header button')]
          .find((candidate) => candidate.textContent?.trim() === ${tabLabel}
            || candidate.textContent?.includes(${tabLabel}));
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()
    `);
    if (clicked) {
      await delay(300);
      return;
    }
    await delay(200);
  }
  throw new Error(`Could not find workspace tab: ${label}`);
}

async function clickOptionalButton(client, text, timeout = 3000, options = {}) {
  try {
    await clickButton(client, text, timeout, options);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(client, expression, label, timeout = 20000) {
  await waitForValue(client, `${expression} ? "ok" : ""`, label, timeout);
}

async function waitForValue(client, expression, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await evaluate(client, expression);
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime evaluation failed.');
  }
  return result.result.value;
}

async function waitForDownloadedZip(dir, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = await readdir(dir);
    const zip = files.find((name) => name.endsWith('.zip'));
    const partial = files.some((name) => name.endsWith('.crdownload'));
    if (zip && !partial) return resolve(dir, zip);
    await delay(250);
  }
  throw new Error('Timed out waiting for downloaded ZIP.');
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
