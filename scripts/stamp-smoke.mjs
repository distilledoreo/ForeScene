import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const appUrl = process.env.FORESCENE_URL ?? process.env.CONTINUITY_STAGE_URL ?? 'http://127.0.0.1:3004';
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9332);
const profileDir = resolve(repoRoot, '.tmp-stamp-chrome-profile');

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' });

try {
  const pageSocketUrl = await waitForPageSocket(debugPort);
  const client = await createCdpClient(pageSocketUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: appUrl });
  await waitFor(client, 'document.querySelector("[data-testid=\\"scene-viewport\\"]")', 'viewport');

  const beforeCount = await countLayerItems(client);

  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51 });
  await delay(300);

  const modeAfterKey = await evaluate(client, `
    (() => {
      const badge = [...document.querySelectorAll('div')].find((node) => node.textContent?.includes('Stamping Box'));
      return badge?.textContent?.replace(/\\s+/g, ' ').trim() ?? 'missing';
    })()
  `);

  const viewportBox = await evaluate(client, `
    (() => {
      const viewport = document.querySelector('[data-testid="scene-viewport"]');
      const canvas = viewport?.querySelector('canvas');
      const viewportRect = viewport?.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      return {
        viewport: viewportRect ? { x: viewportRect.x, y: viewportRect.y, width: viewportRect.width, height: viewportRect.height } : null,
        canvas: canvasRect ? { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height } : null,
        canvasAttrs: canvas ? { width: canvas.width, height: canvas.height } : null,
      };
    })()
  `);

  const clickX = Math.round(viewportBox.viewport.x + viewportBox.viewport.width * 0.5);
  const clickY = Math.round(viewportBox.viewport.y + viewportBox.viewport.height * 0.62);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await delay(400);

  const afterCount = await countLayerItems(client);
  const boxLabels = await evaluate(client, `
    [...document.querySelectorAll('aside button span')]
      .map((node) => node.textContent?.trim())
      .filter((text) => text === 'Box')
  `);

  console.log(JSON.stringify({ beforeCount, modeAfterKey, viewportBox, click: { x: clickX, y: clickY }, afterCount, boxLabels }, null, 2));
  await client.close();
} finally {
  chrome.kill();
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
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitFor(client, expression, label, timeout = 20000) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countLayerItems(client) {
  return evaluate(client, `
    (() => {
      const headings = [...document.querySelectorAll('h2')];
      const panel = headings.find((heading) => heading.textContent?.includes('Toybox Layers'))?.parentElement?.parentElement;
      return panel ? panel.querySelectorAll('button').length : -1;
    })()
  `);
}