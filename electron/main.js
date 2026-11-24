'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, Menu, nativeTheme } = require('electron');
const path = require('path');

const database = require('./db/database');
const auth = require('./services/auth');
const plans = require('./services/plans');
const materials = require('./services/materials');
const questions = require('./services/questions');
const ai = require('./services/ai');
const { ValidationError } = require('./services/scheduler');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const VENDOR_ROOT = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const SCHEME = 'app';
const MATERIAL_SCHEME = 'material';
const isDev = process.argv.includes('--dev');

let mainWindow = null;

// A random per-login capability that the renderer must present to read
// material over material://. Without it, any page able to reach the protocol
// could try to read arbitrary file ids.
let materialCapability = crypto.randomBytes(24).toString('hex');
let materialUserId = null;

// Pin the data directory so it is identical whether the app is launched from
// source (`npm start`) or from an installed build. Without this, userData
// follows the app name, which differs between the dev package and the
// packaged product, and the two would silently use different databases.
//
// STUDYFLOW_DATA_DIR lets a test harness (or a portable launcher) redirect it.
const DATA_DIR = process.env.STUDYFLOW_DATA_DIR
  ? path.resolve(process.env.STUDYFLOW_DATA_DIR)
  : path.join(app.getPath('appData'), 'StudyFlow');
app.setPath('userData', DATA_DIR);

// ---------------------------------------------------------------------------
// Renderer is served over a custom scheme instead of file://
// ---------------------------------------------------------------------------
// ES modules are blocked on file:// origins, so a real (file-backed) scheme
// keeps the renderer code modular without pulling in a bundler.

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: MATERIAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const MATERIAL_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** Serve a file from disk with an explicit content type. */
async function fileResponse(target, type) {
  const body = await fs.promises.readFile(target);
  return new Response(body, {
    headers: {
      'content-type': type,
      // Belt and braces: never let the renderer treat a stored file as markup.
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    },
  });
}

function serveRenderer() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relative = pathname === '/' ? '/index.html' : pathname;

    // /vendor/* exposes the bundled PDF renderer. In a packaged build
    // electron-builder unpacks it next to the asar, so both layouts are tried.
    const vendorBases = [
      VENDOR_ROOT,
      path.join(
        process.resourcesPath || '',
        'app.asar.unpacked', 'node_modules', 'pdfjs-dist', 'build',
      ),
    ];
    const isVendor = relative.startsWith('/vendor/');
    const stripped = isVendor ? relative.slice('/vendor'.length) : relative;
    const safe = path.normalize(stripped).replace(/^([/\\])+/, '');

    if (!isVendor) {
      const target = path.join(RENDERER_ROOT, safe);
      if (!target.startsWith(RENDERER_ROOT)) return new Response('Forbidden', { status: 403 });
      return serveFile(target);
    }

    for (const base of vendorBases) {
      const target = path.join(base, safe);
      if (!target.startsWith(base)) continue;
      try {
        return await serveFile(target);
      } catch {
        // Try the next candidate layout.
      }
    }
    return new Response('Not found', { status: 404 });
  });
}

async function serveFile(target) {
  const type = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const body = await fs.promises.readFile(target);
  return new Response(body, {
    headers: { 'content-type': type, 'x-content-type-options': 'nosniff' },
  });
}

/**
 * Serve attached study material.
 *
 * material://f/<id>?k=<capability> only resolves for the signed-in user and
 * only while they hold the current capability token.
 */
function serveMaterials() {
  protocol.handle(MATERIAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    // material://f/<id> parses with "f" as the host and "<id>" as the path.
    const id = Number(url.pathname.replace(/^\/+|\/+$/g, ''));
    const key = url.searchParams.get('k');

    if (!Number.isInteger(id) || id <= 0) return new Response('Bad request', { status: 400 });
    if (!key || key !== materialCapability) return new Response('Forbidden', { status: 403 });
    if (!materialUserId) return new Response('Forbidden', { status: 403 });

    const found = materials.resolveForUser(materialUserId, id);
    if (!found) return new Response('Not found', { status: 404 });

    const type = MATERIAL_MIME[found.row.ext];
    if (!type) {
      // Not previewable here; force a download rather than rendering it.
      return new Response(await fs.promises.readFile(found.file), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${found.row.original_name.replace(/"/g, '')}"`,
          'x-content-type-options': 'nosniff',
        },
      });
    }

    try {
      return await fileResponse(found.file, type);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0f1220',
    show: false,
    title: 'StudyFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`${SCHEME}://local/index.html`);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // External links open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://`)) event.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC - one handler per use case, each validating its own inputs
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      const known = err instanceof ValidationError
        || err instanceof auth.AuthError
        || err instanceof ai.AiError;
      if (!known) console.error(`[${channel}]`, err);
      return {
        ok: false,
        error: known ? err.message : 'Something went wrong. Please try again.',
        kind: known ? err.name : 'InternalError',
      };
    }
  });
}

/** The renderer sends its stored token; resolve it to a user or throw. */
function requireUser(token) {
  const user = auth.userForToken(token);
  if (!user) throw new auth.AuthError('Your session expired. Please sign in again.');
  return user;
}

/**
 * Record who is signed in so the material:// protocol can authorise reads.
 * The capability rotates on every sign-in.
 */
function rememberSession(user) {
  materialUserId = user ? user.id : null;
  materialCapability = crypto.randomBytes(24).toString('hex');
}

function registerIpc() {
  handle('auth:register', (p) => {
    const result = auth.register(p);
    rememberSession(result.user);
    return { ...result, materialKey: materialCapability };
  });
  handle('auth:login', (p) => {
    const result = auth.login(p);
    rememberSession(result.user);
    return { ...result, materialKey: materialCapability };
  });
  handle('auth:logout', (p) => {
    auth.logout(p.token);
    rememberSession(null);
    return { ok: true };
  });
  handle('auth:session', (p) => {
    const user = auth.userForToken(p.token);
    if (user) rememberSession(user);
    return { user, materialKey: materialCapability };
  });

  handle('plans:list', (p) => plans.list(requireUser(p.token).id));
  handle('plans:get', (p) => plans.get(requireUser(p.token).id, Number(p.id)));
  handle('plans:create', (p) => plans.create(requireUser(p.token).id, p.input));
  handle('plans:regenerate', (p) => plans.regenerate(requireUser(p.token).id, Number(p.id), p.input));
  handle('plans:rename', (p) => plans.rename(requireUser(p.token).id, Number(p.id), p.title));
  handle('plans:delete', (p) => plans.remove(requireUser(p.token).id, Number(p.id)));
  handle('plans:progress', (p) => plans.setProgress(
    requireUser(p.token).id,
    Number(p.id),
    String(p.sessionId || ''),
    Boolean(p.completed),
  ));

  handle('materials:list', (p) => ({
    byTopic: materials.listByTopic(requireUser(p.token).id, Number(p.id)),
    maxBytes: materials.MAX_FILE_BYTES,
  }));

  handle('materials:attach', async (p) => {
    const user = requireUser(p.token);
    const target = {
      topicId: p.topicId || null,
      topicName: p.topicName,
      subjectIndex: p.subjectIndex,
      subjectName: p.subjectName,
    };

    // Let the user pick one or several files; anything over the limit is
    // reported without aborting the rest.
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: `Attach material to "${p.topicName}"`,
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || !picked.filePaths.length) return { added: [], rejected: [] };

    const added = [];
    const rejected = [];
    for (const sourcePath of picked.filePaths) {
      try {
        added.push(materials.attach(user.id, Number(p.id), { ...target, sourcePath }));
      } catch (err) {
        rejected.push({ name: path.basename(sourcePath), reason: err.message });
      }
    }
    return { added, rejected };
  });

  handle('materials:remove', (p) => ({
    ok: materials.remove(requireUser(p.token).id, Number(p.id)),
  }));

  handle('materials:openExternal', (p) => {
    const user = requireUser(p.token);
    const found = materials.resolveForUser(user.id, Number(p.id));
    if (!found) throw new ValidationError('That file is no longer available.');
    return { ok: shell.openPath(found.file) };
  });

  handle('questions:list', (p) => {
    const user = requireUser(p.token);
    const list = questions.listForPlan(user.id, Number(p.id));
    return { questions: list, summary: questions.summary(list) };
  });

  handle('questions:create', (p) => questions.create(requireUser(p.token).id, Number(p.id), p.question));
  handle('questions:update', (p) => questions.update(
    requireUser(p.token).id, Number(p.id), p.question,
  ));
  handle('questions:remove', (p) => ({
    ok: questions.remove(requireUser(p.token).id, Number(p.id)),
  }));

  handle('questions:answer', (p) => questions.answer(
    requireUser(p.token).id, Number(p.id), p.optionId,
  ));

  handle('questions:due', (p) => questions.dueForPlan(
    requireUser(p.token).id, Number(p.id), { topicId: p.topicId, limit: p.limit },
  ));

  handle('ai:status', (p) => ai.statusFor(requireUser(p.token).id));
  handle('ai:setKey', (p) => ai.setApiKey(requireUser(p.token).id, String(p.apiKey || '')));

  handle('ai:ask', async (p) => {
    const user = requireUser(p.token);
    return ai.ask(user.id, Number(p.planId), String(p.prompt || ''));
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    databasePath: database.filePath(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  handle('app:revealDatabase', () => {
    if (database.filePath()) shell.showItemInFolder(database.filePath());
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running. Exiting silently looks like a crash, so
  // say what happened and point at the window that is already open.
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'StudyFlow',
      message: 'StudyFlow is already running.',
      detail: 'The window that is already open has been brought to the front.\n\n'
        + 'Only one copy can run at a time.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    });
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    serveRenderer();
    serveMaterials();
    Menu.setApplicationMenu(buildMenu());
    registerIpc();

    try {
      await database.open(DATA_DIR);
      auth.purgeExpiredSessions();
    } catch (err) {
      dialog.showErrorBox('StudyFlow could not start', `Opening the database failed:\n\n${err.message}`);
      app.quit();
      return;
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => database.close());
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Show Database File',
          click: () => {
            if (database.filePath()) shell.showItemInFolder(database.filePath());
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

module.exports = { SCHEME, getWindow: () => mainWindow };