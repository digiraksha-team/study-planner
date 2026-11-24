'use strict';

const database = require('../db/database');
const { ValidationError } = require('./scheduler');

/**
 * Self-testing flashcards.
 *
 * Each question hangs off a topic and carries several options with exactly one
 * correct answer. Answering feeds a small spaced-repetition schedule: a wrong
 * answer brings the question back tomorrow, consecutive correct answers push it
 * further out. Questions you never attempt are always due.
 */

// Days until a question comes back, indexed by consecutive correct answers.
const INTERVALS = [1, 3, 7, 14, 30, 60];
const RELEARN_DELAY_DAYS = 1;

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function rowToQuestion(row, options, review) {
  return {
    id: row.id,
    planId: row.plan_id,
    subjectIndex: row.subject_index,
    topicId: row.topic_id,
    topicName: row.topic_name,
    subjectName: row.subject_name,
    prompt: row.prompt,
    explanation: row.explanation || '',
    createdAt: row.created_at,
    options: options.map((o) => ({ id: o.id, label: o.label, isCorrect: !!o.is_correct })),
    review: {
      streak: review ? review.streak : 0,
      attempts: review ? review.attempts : 0,
      wrongCount: review ? review.wrong_count : 0,
      lastCorrect: review ? !!review.last_correct : null,
      dueDate: review ? review.due_date : today(),
      lastReviewed: review ? review.last_reviewed : null,
      // "known" means it has been answered correctly at least three times.
      known: !!review && review.streak >= 3,
    },
  };
}

function optionsFor(questionIds) {
  if (!questionIds.length) return new Map();
  const placeholders = questionIds.map(() => '?').join(',');
  const rows = database.all(
    `SELECT * FROM question_options WHERE question_id IN (${placeholders}) ORDER BY position ASC`,
    questionIds,
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.question_id)) grouped.set(row.question_id, []);
    grouped.get(row.question_id).push(row);
  }
  return grouped;
}

function reviewsFor(questionIds) {
  if (!questionIds.length) return new Map();
  const placeholders = questionIds.map(() => '?').join(',');
  const rows = database.all(`SELECT * FROM question_reviews WHERE question_id IN (${placeholders})`, questionIds);
  return new Map(rows.map((r) => [r.question_id, r]));
}

function listForPlan(userId, planId) {
  const rows = database.all(
    'SELECT * FROM questions WHERE user_id = ? AND plan_id = ? ORDER BY id ASC',
    [userId, planId],
  );
  const ids = rows.map((r) => r.id);
  const options = optionsFor(ids);
  const reviews = reviewsFor(ids);

  return rows.map((row) => rowToQuestion(row, options.get(row.id) || [], reviews.get(row.id)));
}

function get(userId, questionId) {
  const row = database.get('SELECT * FROM questions WHERE id = ? AND user_id = ?', [questionId, userId]);
  if (!row) return null;
  const options = optionsFor([row.id]).get(row.id) || [];
  const reviews = reviewsFor([row.id]);
  return rowToQuestion(row, options, reviews.get(row.id));
}

function normaliseOptions(raw) {
  const cleaned = (Array.isArray(raw) ? raw : [])
    .map((o) => ({
      label: String((o && o.label) || '').trim(),
      isCorrect: !!(o && o.isCorrect),
    }))
    .filter((o) => o.label);

  if (cleaned.length < MIN_OPTIONS) {
    throw new ValidationError(`A question needs at least ${MIN_OPTIONS} answer options.`);
  }
  if (cleaned.length > MAX_OPTIONS) {
    throw new ValidationError(`A question can have at most ${MAX_OPTIONS} options.`);
  }
  const correct = cleaned.filter((o) => o.isCorrect);
  if (correct.length !== 1) {
    throw new ValidationError('Mark exactly one option as the correct answer.');
  }
  return cleaned;
}

function create(userId, planId, input) {
  const plan = database.get('SELECT id FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!plan) throw new ValidationError('That plan no longer exists.');

  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new ValidationError('Write the question before saving it.');
  if (prompt.length > 1000) throw new ValidationError('That question is too long.');

  const topicName = String(input.topicName || '').trim();
  if (!topicName) throw new ValidationError('Choose which topic this question belongs to.');

  const options = normaliseOptions(input.options);
  const explanation = String(input.explanation || '').trim().slice(0, 2000) || null;
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO questions
       (user_id, plan_id, subject_index, topic_id, topic_name, subject_name,
        prompt, explanation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      planId,
      input.subjectIndex ?? null,
      input.topicId || null,
      topicName,
      input.subjectName ?? null,
      prompt,
      explanation,
      now,
      now,
    ],
  );

  const id = database.get('SELECT last_insert_rowid() AS id').id;
  options.forEach((option, index) => {
    database.run(
      'INSERT INTO question_options (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)',
      [id, option.label, option.isCorrect ? 1 : 0, index],
    );
  });

  // A brand new question is due straight away.
  database.run(
    'INSERT INTO question_reviews (question_id, streak, attempts, wrong_count, last_correct, due_date) VALUES (?, 0, 0, 0, NULL, ?)',
    [id, today()],
  );

  return get(userId, id);
}

function update(userId, questionId, input) {
  const existing = database.get('SELECT * FROM questions WHERE id = ? AND user_id = ?', [questionId, userId]);
  if (!existing) throw new ValidationError('That question no longer exists.');

  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new ValidationError('Write the question before saving it.');

  let options = null;
  if (input.options) options = normaliseOptions(input.options);

  database.run(
    'UPDATE questions SET prompt = ?, explanation = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [
      prompt,
      String(input.explanation || '').trim().slice(0, 2000) || null,
      new Date().toISOString(),
      questionId,
      userId,
    ],
  );

  if (options) {
    database.run('DELETE FROM question_options WHERE question_id = ?', [questionId]);
    options.forEach((option, index) => {
      database.run(
        'INSERT INTO question_options (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)',
        [questionId, option.label, option.isCorrect ? 1 : 0, index],
      );
    });
    // Changing the answers invalidates what the learner already knows.
    database.run(
      'UPDATE question_reviews SET streak = 0, due_date = ? WHERE question_id = ?',
      [today(), questionId],
    );
  }

  return get(userId, questionId);
}

function remove(userId, questionId) {
  return database.run('DELETE FROM questions WHERE id = ? AND user_id = ?', [questionId, userId]);
}

/**
 * Record an answer and reschedule the question.
 * Returns the verdict plus the updated review state so the UI can react
 * without another round trip.
 */
function answer(userId, questionId, optionId) {
  const question = get(userId, questionId);
  if (!question) throw new ValidationError('That question no longer exists.');

  const chosen = question.options.find((o) => o.id === Number(optionId));
  if (!chosen) throw new ValidationError('Pick one of the listed options.');

  const correct = chosen.isCorrect;
  const previous = question.review;
  const streak = correct ? previous.streak + 1 : 0;
  const interval = correct
    ? INTERVALS[Math.min(streak - 1, INTERVALS.length - 1)]
    : RELEARN_DELAY_DAYS;

  database.run(
    `UPDATE question_reviews
     SET streak = ?, attempts = attempts + 1, wrong_count = wrong_count + ?,
         last_correct = ?, due_date = ?, last_reviewed = ?
     WHERE question_id = ?`,
    [
      streak,
      correct ? 0 : 1,
      correct ? 1 : 0,
      shiftDays(interval),
      new Date().toISOString(),
      questionId,
    ],
  );

  return {
    correct,
    correctOptionId: (question.options.find((o) => o.isCorrect) || {}).id,
    explanation: question.explanation,
    streak,
    dueDate: shiftDays(interval),
    nextReviewInDays: interval,
  };
}

/** Questions worth practising now, soonest due first. */
function dueForPlan(userId, planId, { topicId, limit = 50 } = {}) {
  const questions = listForPlan(userId, planId)
    .filter((q) => (topicId ? q.topicId === topicId : true))
    .filter((q) => q.review.dueDate <= today());

  questions.sort((a, b) => {
    if (a.review.dueDate !== b.review.dueDate) return a.review.dueDate < b.review.dueDate ? -1 : 1;
    if (a.review.wrongCount !== b.review.wrongCount) return b.review.wrongCount - a.review.wrongCount;
    return a.id - b.id;
  });

  return questions.slice(0, Math.max(1, Math.min(limit, 200)));
}

function summary(questions) {
  const now = today();
  const total = questions.length;
  const due = questions.filter((q) => q.review.dueDate <= now).length;
  const known = questions.filter((q) => q.review.known).length;
  const attempts = questions.reduce((a, q) => a + q.review.attempts, 0);
  const wrong = questions.reduce((a, q) => a + q.review.wrongCount, 0);

  return {
    total,
    due,
    known,
    unseen: questions.filter((q) => q.review.attempts === 0).length,
    attempts,
    accuracy: attempts ? Math.round(((attempts - wrong) / attempts) * 100) : null,
    byTopic: questions.reduce((acc, q) => {
      const key = q.topicId || `__plan__:${q.topicName}`;
      if (!acc[key]) acc[key] = { topicId: q.topicId, topicName: q.topicName, total: 0, due: 0, known: 0 };
      acc[key].total += 1;
      if (q.review.dueDate <= now) acc[key].due += 1;
      if (q.review.known) acc[key].known += 1;
      return acc;
    }, {}),
  };
}

/** Re-point questions at their topics by name after a plan is regenerated. */
function remapTopicsForPlan(userId, planId, newPlan) {
  const rows = database.all('SELECT * FROM questions WHERE user_id = ? AND plan_id = ?', [userId, planId]);
  for (const row of rows) {
    const session = newPlan.days
      .flatMap((d) => d.sessions)
      .find((s) => s.topicName === row.topic_name && s.subjectIndex === row.subject_index);
    if (session) database.run('UPDATE questions SET topic_id = ? WHERE id = ?', [session.topicId, row.id]);
  }
}

module.exports = {
  INTERVALS,
  MIN_OPTIONS,
  MAX_OPTIONS,
  listForPlan,
  get,
  create,
  update,
  remove,
  answer,
  dueForPlan,
  summary,
  remapTopicsForPlan,
};