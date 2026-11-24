'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const database = require('../db/database');
const { ValidationError } = require('./scheduler');

/**
 * Study material attached to plan topics.
 *
 * Files are copied out of wherever the user picked them into the app's own
 * materials folder, so the plan keeps working even if the original is moved,
 * renamed or deleted. Only metadata lives in SQLite; the bytes stay on disk.
 */

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

// Extensions we can render inside the app. Everything else opens in the
// user's default program instead.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const VIEWABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf']);

function materialsRoot() {
  return path.join(database.userDataDir(), 'materials');
}

/** Previewable files are served inline; anything else is treated as inert. */
function viewKind(ext) {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return null;
}

function safeExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  // Limit to a short alphanumeric extension so it can never act as a path.
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function rowToMaterial(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    subjectIndex: row.subject_index,
    topicId: row.topic_id,
    topicName: row.topic_name,
    subjectName: row.subject_name,
    name: row.original_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    view: viewKind(row.ext),
    ext: row.ext,
  };
}

function listForPlan(userId, planId) {
  return database
    .all('SELECT * FROM materials WHERE user_id = ? AND plan_id = ? ORDER BY created_at ASC', [userId, planId])
    .map(rowToMaterial);
}

function listByTopic(userId, planId) {
  const grouped = new Map();
  for (const material of listForPlan(userId, planId)) {
    const key = material.topicId || '__plan__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(material);
  }
  return Object.fromEntries(grouped);
}

/** Copy a picked file into the app's materials folder and record it. */
function attach(userId, planId, { sourcePath, topicId, topicName, subjectIndex, subjectName }) {
  const plan = database.get('SELECT id FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!plan) throw new ValidationError('That plan no longer exists.');
  if (!topicName) throw new ValidationError('Choose a topic to attach the material to.');

  let stats;
  try {
    stats = fs.statSync(sourcePath);
  } catch {
    throw new ValidationError('That file could not be read.');
  }
  if (!stats.isFile()) throw new ValidationError('Only files can be attached.');
  if (stats.size > MAX_FILE_BYTES) {
    throw new ValidationError(
      `"${path.basename(sourcePath)}" is ${Math.round(stats.size / 1048576)} MB, over the 100 MB limit.`,
    );
  }

  const ext = safeExt(sourcePath);
  const dir = path.join(materialsRoot(), String(userId));
  fs.mkdirSync(dir, { recursive: true });

  // Random stored name: the original filename is kept only as a label, so an
  // odd or hostile filename can never influence where bytes land on disk.
  const storedName = `${crypto.randomUUID()}${ext}`;
  const target = path.join(dir, storedName);

  try {
    fs.copyFileSync(sourcePath, target);
  } catch (err) {
    throw new ValidationError(`Could not copy the file: ${err.message}`);
  }

  let row;
  try {
    database.run(
      `INSERT INTO materials
         (user_id, plan_id, subject_index, topic_id, topic_name, subject_name,
          original_name, stored_name, ext, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        planId,
        subjectIndex ?? null,
        topicId ?? null,
        topicName,
        subjectName ?? null,
        path.basename(sourcePath),
        storedName,
        ext,
        stats.size,
        new Date().toISOString(),
      ],
    );
    row = database.get('SELECT * FROM materials WHERE id = last_insert_rowid()');
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }

  return rowToMaterial(row);
}

function remove(userId, materialId) {
  const row = database.get('SELECT * FROM materials WHERE id = ? AND user_id = ?', [materialId, userId]);
  if (!row) return false;
  database.run('DELETE FROM materials WHERE id = ? AND user_id = ?', [materialId, userId]);
  fs.rmSync(storedPath(row), { force: true });
  return true;
}

function storedPath(row) {
  return path.join(materialsRoot(), String(row.user_id), row.stored_name);
}

/**
 * Resolve a material id to a file on disk, but only for the user who owns it.
 * Returns null when the row is missing or belongs to somebody else, which is
 * what the material:// protocol handler relies on to refuse unauthorised reads.
 */
function resolveForUser(userId, materialId) {
  const row = database.get('SELECT * FROM materials WHERE id = ? AND user_id = ?', [materialId, userId]);
  if (!row) return null;
  const file = storedPath(row);
  if (!fs.existsSync(file)) return null;
  return { row, file, material: rowToMaterial(row) };
}

/**
 * Regenerating a plan produces positional topic ids, so re-point materials at
 * their topics by name. Files attached to topics that no longer exist are
 * dropped rather than silently reattached to the wrong subject.
 */
function remapTopicsForPlan(userId, planId, newPlan) {
  const materials = database.all('SELECT * FROM materials WHERE user_id = ? AND plan_id = ?', [userId, planId]);

  for (const row of materials) {
    const subject = row.subject_index != null ? newPlan.subjects[row.subject_index] : null;
    const topic = subject
      ? newPlan.days
        .flatMap((d) => d.sessions)
        .find((s) => s.topicName === row.topic_name && s.subjectIndex === row.subject_index)
      : null;

    if (!topic) {
      database.run('DELETE FROM materials WHERE id = ?', [row.id]);
      fs.rmSync(storedPath(row), { force: true });
      continue;
    }
    database.run('UPDATE materials SET topic_id = ? WHERE id = ?', [topic.topicId, row.id]);
  }
}

/** Absolute paths of every file attached to a plan, gathered before deletion. */
function pathsForPlan(userId, planId) {
  return database
    .all('SELECT * FROM materials WHERE user_id = ? AND plan_id = ?', [userId, planId])
    .map(storedPath);
}

/** Delete the plan's files. Call before the plan row itself is removed. */
function purgeFiles(files) {
  for (const file of files) fs.rmSync(file, { force: true });
}

module.exports = {
  MAX_FILE_BYTES,
  listForPlan,
  listByTopic,
  attach,
  remove,
  resolveForUser,
  remapTopicsForPlan,
  viewKind,
  materialsRoot,
  pathsForPlan,
  purgeFiles,
};