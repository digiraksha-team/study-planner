'use strict';

const database = require('../db/database');
const materials = require('./materials');
const questions = require('./questions');
const { generatePlan, ValidationError } = require('./scheduler');

/** Plan persistence: every read and write is scoped to the signed-in user. */

function rowToPlan(row, progress) {
  return {
    id: row.id,
    title: row.title,
    examDate: row.exam_date,
    input: JSON.parse(row.input),
    plan: JSON.parse(row.output),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: progress || [],
  };
}

function progressFor(planId) {
  return database
    .all('SELECT session_id, completed_at FROM progress WHERE plan_id = ?', [planId])
    .map((r) => ({ sessionId: r.session_id, completedAt: r.completed_at }));
}

function list(userId) {
  const rows = database.all(
    `SELECT id, title, exam_date, input, output, created_at, updated_at
     FROM plans WHERE user_id = ? ORDER BY exam_date ASC, updated_at DESC`,
    [userId],
  );
  return rows.map((row) => {
    const plan = rowToPlan(row);
    // The dashboard only needs headline numbers, not the whole day breakdown.
    return {
      id: row.id,
      title: row.title,
      examDate: row.exam_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stats: plan.plan.stats,
      range: plan.plan.range,
      warnings: plan.plan.warnings,
      subjectCount: plan.plan.subjects.length,
      progress: progressFor(row.id),
    };
  });
}

function get(userId, planId) {
  const row = database.get('SELECT * FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!row) return null;
  return rowToPlan(row, progressFor(row.id));
}

function create(userId, input) {
  const generated = generatePlan(input);
  const title = String(input.title || '').trim() || `Plan for ${generated.range.examDate}`;
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO plans (user_id, title, exam_date, input, output, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      title,
      generated.range.examDate,
      JSON.stringify(input),
      JSON.stringify(generated),
      now,
      now,
    ],
  );

  const id = database.get('SELECT last_insert_rowid() AS id').id;
  return get(userId, id);
}

function regenerate(userId, planId, input) {
  const existing = database.get('SELECT * FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!existing) return null;

  const merged = { ...JSON.parse(existing.input), ...input };
  const generated = generatePlan(merged);
  const title = String(merged.title || '').trim() || existing.title;
  const now = new Date().toISOString();

  database.run(
    `UPDATE plans SET title = ?, exam_date = ?, input = ?, output = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      title,
      generated.range.examDate,
      JSON.stringify(merged),
      JSON.stringify(generated),
      now,
      planId,
      userId,
    ],
  );

  // Session ids are positional, so a regenerated plan invalidates old ticks.
  database.run('DELETE FROM progress WHERE plan_id = ?', [planId]);

  // Topic ids are positional too, so re-point attached files by name rather
  // than leaving them on the wrong topic.
  try {
    materials.remapTopicsForPlan(userId, planId, generated);
  } catch (err) {
    console.error('Could not re-map study material after regenerate:', err.message);
  }
  try {
    questions.remapTopicsForPlan(userId, planId, generated);
  } catch (err) {
    console.error('Could not re-map questions after regenerate:', err.message);
  }

  return get(userId, planId);
}

function rename(userId, planId, title) {
  const clean = String(title || '').trim();
  if (!clean) throw new ValidationError('The plan needs a title.');
  database.run('UPDATE plans SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    clean,
    new Date().toISOString(),
    planId,
    userId,
  ]);
  return get(userId, planId);
}

function remove(userId, planId) {
  // Collect the file paths first: deleting the plan cascades the material rows
  // away, and afterwards there is nothing left pointing at the bytes on disk.
  const files = materials.pathsForPlan(userId, planId);
  database.run('DELETE FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  materials.purgeFiles(files);
}

function setProgress(userId, planId, sessionId, completed) {
  const plan = database.get('SELECT id FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!plan) return null;

  if (completed) {
    database.run(
      `INSERT OR REPLACE INTO progress (plan_id, session_id, completed_at) VALUES (?, ?, ?)`,
      [planId, sessionId, new Date().toISOString()],
    );
  } else {
    database.run('DELETE FROM progress WHERE plan_id = ? AND session_id = ?', [planId, sessionId]);
  }
  return progressFor(planId);
}

module.exports = { list, get, create, regenerate, rename, remove, setProgress };