'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * SQLite persistence for StudyFlow.
 *
 * sql.js runs SQLite compiled to WebAssembly, so the app needs no native
 * build toolchain on the host - the database is a single portable file inside
 * Electron's userData directory. Writes are debounced and atomic (temp file +
 * rename) so a crash mid-save cannot corrupt an existing database.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  exam_date  TEXT    NOT NULL,
  input      TEXT    NOT NULL,
  output     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  session_id    TEXT    NOT NULL,
  completed_at  TEXT    NOT NULL,
  PRIMARY KEY (plan_id, session_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  subject_index INTEGER,
  topic_id      TEXT,
  topic_name    TEXT    NOT NULL,
  subject_name  TEXT,
  original_name TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL,
  ext           TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id        INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  subject_index  INTEGER,
  topic_id       TEXT,
  topic_name     TEXT    NOT NULL,
  subject_name   TEXT,
  prompt         TEXT    NOT NULL,
  explanation    TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS question_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL
);

-- One row per question: how well it is known and when it comes back.
CREATE TABLE IF NOT EXISTS question_reviews (
  question_id    INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  streak         INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  wrong_count    INTEGER NOT NULL DEFAULT 0,
  last_correct   INTEGER,
  due_date       TEXT    NOT NULL,
  last_reviewed  TEXT
);

-- Per-user AI settings (OpenAI-compatible key). The key is stored locally
-- next to the account; it never leaves this machine except in the request to
-- the provider.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ai_api_key TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_materials_plan ON materials(plan_id);
CREATE INDEX IF NOT EXISTS idx_questions_plan ON questions(plan_id);
CREATE INDEX IF NOT EXISTS idx_qopts_question ON question_options(question_id, position);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON question_reviews(due_date);
`;

let db = null;
let dbFile = null;
let saveTimer = null;
let dirty = false;

/**
 * Locate sql.js's WebAssembly binary.
 *
 * In development it sits under the project's node_modules. In a packaged build
 * electron-builder unpacks it into app.asar.unpacked while the rest of the app
 * stays inside app.asar, so both layouts have to be tried.
 */
function resolveSqlJsDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sql-wasm.wasm'))) return dir;
  }
  throw new Error(`Could not find sql-wasm.wasm. Looked in:\n  ${candidates.join('\n  ')}`);
}

async function open(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  dbFile = path.join(userDataDir, 'studyflow.db');

  const sqlJsDir = resolveSqlJsDir();
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(sqlJsDir, file),
  });

  if (fs.existsSync(dbFile)) {
    try {
      db = new SQL.Database(fs.readFileSync(dbFile));
    } catch (err) {
      // A corrupt file must not brick the app; move it aside and start clean.
      const backup = `${dbFile}.corrupt-${Date.now()}`;
      fs.renameSync(dbFile, backup);
      console.error(`Database was unreadable (${err.message}); moved to ${backup}`);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA);
  enableForeignKeys();
  flushNow();
  return dbFile;
}

function flushNow() {
  if (!db || !dbFile) return;
  const data = Buffer.from(db.export());
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dbFile);
  dirty = false;
  // export() round-trips the database through a fresh internal handle, which
  // resets connection-level settings. Without this, foreign key enforcement
  // would quietly switch itself off after the first save and every ON DELETE
  // CASCADE would stop working.
  enableForeignKeys();
}

/**
 * Turn on foreign key enforcement for cascading deletes.
 * Must be re-applied after every export(), and before every write.
 */
function enableForeignKeys() {
  if (!db) return;
  db.run('PRAGMA foreign_keys = ON;');
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, 150);
}

function close() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) flushNow();
  if (db) {
    db.close();
    db = null;
  }
}

// --- Tiny query helpers ----------------------------------------------------

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  enableForeignKeys();
  db.run(sql, params);
  scheduleSave();
}

function filePath() {
  return dbFile;
}

function userDataDir() {
  return dbFile ? path.dirname(dbFile) : null;
}

module.exports = { open, close, all, get, run, filePath, userDataDir, flushNow };