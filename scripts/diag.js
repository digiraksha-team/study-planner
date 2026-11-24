/** Throwaway diagnostic: boot the app and dump what the renderer actually did. */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DATA = path.join(os.tmpdir(), `sf-diag-${Date.now()}`);
app.setPath('userData', USER_DATA);
require('../electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const main = require('../electron/main.js');
  for (let i = 0; i < 60; i += 1) {
    if (main.getWindow()) break;
    await sleep(150);
  }
  const win = main.getWindow();
  if (!win) { console.log('NO WINDOW'); app.exit(1); return; }

  win.webContents.on('console-message', (...args) => {
    console.log('CONSOLE:', ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)));
  });
  win.webContents.on('did-fail-load', (_e, c, d, u) => console.log('FAIL-LOAD', c, d, u));
  win.webContents.on('preload-error', (_e, f, e) => console.log('PRELOAD-ERR', f, e.message));

  await sleep(4000);

  const info = await win.webContents.executeJavaScript(`(() => ({
    url: location.href,
    title: document.title,
    bodyChildren: document.body ? document.body.children.length : -1,
    viewHtml: (document.getElementById('view') || {}).innerHTML?.slice(0, 200) ?? 'no #view',
    hasApi: typeof window.api,
    apiKeys: window.api ? Object.keys(window.api) : null,
  }))()`).catch((e) => ({ error: e.message }));

  console.log('RENDERER STATE:', JSON.stringify(info, null, 2));

  const net = await win.webContents.executeJavaScript(
    `fetch('/app.js').then(r => r.status).catch(e => 'err:' + e.message)`,
  );
  console.log('fetch /app.js ->', net);

  fs.rmSync(USER_DATA, { recursive: true, force: true });
  app.exit(0);
});