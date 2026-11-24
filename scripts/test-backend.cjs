/**
 * Integration check for the database, auth and plan services.
 * Uses a throwaway database in a temp directory - no Electron required.
 * Run with: node scripts/test-backend.cjs
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyflow-test-'));

const database = require('../electron/db/database');
const auth = require('../electron/services/auth');
const plans = require('../electron/services/plans');
const questions = require('../electron/services/questions');
const ai = require('../electron/services/ai');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const input = {
  title: 'Backend test plan',
  startDate: '2026-03-02',
  examDate: '2026-03-27',
  studyDays: [1, 2, 3, 4, 5, 6],
  dailyHours: 3,
  sessionMinutes: 60,
  breakMinutes: 10,
  reserveDays: 2,
  reviews: true,
  subjects: [
    { name: 'Mathematics', difficulty: 'hard', priority: 'high', topics: [
      { name: 'Algebra', importance: 'core' },
      { name: 'Calculus', importance: 'core' } ] },
    { name: 'History', difficulty: 'easy', topics: [{ name: 'Revolutions', importance: 'medium' }] },
  ],
};

/** First scheduled session anywhere in the plan, wherever the engine put it. */
function firstSessionId(userId, id) {
  const saved = plans.get(userId, id);
  for (const day of saved.plan.days) {
    if (day.sessions.length) return day.sessions[0].id;
  }
  throw new Error('plan has no scheduled sessions');
}

(async () => {
  await database.open(tmpDir);
  console.log(`\ndatabase: ${database.filePath()}\n`);

  // --- auth --------------------------------------------------------------
  let token = null;
  let userId = null;

  await test('registers a new account', () => {
    const result = auth.register({ email: 'Alex@Example.com ', name: 'Alex', password: 'correcthorse' });
    assert.equal(result.user.email, 'alex@example.com', 'email should be normalised');
    assert.equal(result.user.name, 'Alex');
    assert.ok(result.token.length >= 32);
    assert.equal(result.user.password_hash, undefined, 'must not leak the hash');
    token = result.token;
    userId = result.user.id;
  });

  await test('rejects duplicate emails regardless of case', () => {
    assert.throws(
      () => auth.register({ email: 'ALEX@example.com', password: 'correcthorse' }),
      /already exists/,
    );
  });

  await test('rejects short passwords', () => {
    assert.throws(
      () => auth.register({ email: 'new@example.com', password: 'short' }),
      /at least 8/,
    );
  });

  await test('rejects malformed emails', () => {
    assert.throws(
      () => auth.register({ email: 'nope', password: 'correcthorse' }),
      /valid email/,
    );
  });

  await test('signs in with the right password', () => {
    const result = auth.login({ email: 'alex@example.com', password: 'correcthorse' });
    assert.equal(result.user.id, userId);
    assert.ok(result.token !== token, 'a fresh session token is issued');
  });

  await test('rejects the wrong password', () => {
    assert.throws(
      () => auth.login({ email: 'alex@example.com', password: 'wrongpassword' }),
      /Incorrect email or password/,
    );
  });

  await test('resolves a valid token to a user', () => {
    const user = auth.userForToken(token);
    assert.equal(user.id, userId);
  });

  await test('returns null for an unknown token', () => {
    assert.equal(auth.userForToken('deadbeef'), null);
    assert.equal(auth.userForToken(''), null);
    assert.equal(auth.userForToken(null), null);
  });

  // --- plans -------------------------------------------------------------
  let planId = null;

  await test('creates a plan', () => {
    const saved = plans.create(userId, input);
    assert.ok(saved.id > 0);
    assert.equal(saved.title, 'Backend test plan');
    assert.ok(saved.plan.days.length > 0);
    assert.ok(saved.plan.stats.totalSessions > 0);
    planId = saved.id;
  });

  await test('titles an unnamed plan automatically', () => {
    const saved = plans.create(userId, { ...input, title: '   ' });
    assert.match(saved.title, /^Plan for 2026/);
  });

  await test('rejects an invalid plan at the service boundary', () => {
    assert.throws(() => plans.create(userId, { ...input, subjects: [] }), /at least one subject/);
  });

  await test('lists only the owner\'s plans', () => {
    const other = auth.register({ email: 'bob@example.com', password: 'hunter2hunter2' });
    assert.equal(plans.list(userId).length, 2);
    assert.equal(plans.list(other.user.id).length, 0, "another user must not see these plans");
  });

  await test('blocks reading someone else\'s plan', () => {
    const other = auth.login({ email: 'bob@example.com', password: 'hunter2hunter2' });
    assert.equal(plans.get(other.user.id, planId), null);
  });

  await test('blocks deleting someone else\'s plan', () => {
    const other = auth.login({ email: 'bob@example.com', password: 'hunter2hunter2' });
    plans.remove(other.user.id, planId);
    assert.ok(plans.get(userId, planId), 'plan should survive another user\'s delete attempt');
  });

  await test('toggles progress on a session', () => {
    const sessionId = firstSessionId(userId, planId);
    let progress = plans.setProgress(userId, planId, sessionId, true);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].sessionId, sessionId);
    // Toggling twice must not duplicate the row.
    progress = plans.setProgress(userId, planId, sessionId, true);
    assert.equal(progress.length, 1, 'repeat ticks are idempotent');
    progress = plans.setProgress(userId, planId, sessionId, false);
    assert.equal(progress.length, 0);
  });

  await test('regenerating clears stale progress', () => {
    const sessionId = firstSessionId(userId, planId);
    plans.setProgress(userId, planId, sessionId, true);
    assert.equal(plans.get(userId, planId).progress.length, 1);
    const updated = plans.regenerate(userId, planId, { dailyHours: 4 });
    assert.equal(updated.progress.length, 0, 'session ids change, so ticks must reset');
    assert.equal(updated.input.dailyHours, 4);
    assert.equal(updated.input.examDate, input.examDate, 'unspecified fields are preserved');
  });

  await test('renames a plan and rejects an empty title', () => {
    assert.equal(plans.rename(userId, planId, '  Renamed  ').title, 'Renamed');
    assert.throws(() => plans.rename(userId, planId, '   '), /needs a title/);
  });

  // --- questions ---------------------------------------------------------
  let questionId = null;
  const mkQuestion = (over = {}) => questions.create(userId, planId, {
    prompt: 'What does ++ do?',
    topicId: 's0t0',
    topicName: 'Algebra',
    subjectIndex: 0,
    subjectName: 'Mathematics',
    explanation: 'Pre-increment.',
    options: [
      { label: 'Pre-increment', isCorrect: true },
      { label: 'Post-increment', isCorrect: false },
      { label: 'Addition', isCorrect: false },
      { label: 'Concatenation', isCorrect: false },
    ],
    ...over,
  });

  await test('creates a multiple-choice question', () => {
    const q = mkQuestion();
    assert.ok(q.id > 0);
    assert.equal(q.options.length, 4);
    assert.equal(q.options.filter((o) => o.isCorrect).length, 1);
    assert.equal(q.review.attempts, 0);
    assert.equal(q.review.dueDate, new Date().toISOString().slice(0, 10));
    questionId = q.id;
  });

  await test('rejects a question with no prompt', () => {
    assert.throws(() => mkQuestion({ prompt: '   ' }), /Write the question/);
  });

  await test('rejects fewer than two options', () => {
    assert.throws(
      () => mkQuestion({ options: [{ label: 'only', isCorrect: true }] }),
      /at least 2/,
    );
  });

  await test('rejects more than one correct option', () => {
    assert.throws(() => mkQuestion({
      options: [
        { label: 'a', isCorrect: true },
        { label: 'b', isCorrect: true },
      ],
    }), /exactly one/);
  });

  await test('rejects zero correct options', () => {
    assert.throws(() => mkQuestion({
      options: [{ label: 'a', isCorrect: false }, { label: 'b', isCorrect: false }],
    }), /exactly one/);
  });

  await test('rejects a question with no topic', () => {
    assert.throws(() => mkQuestion({ topicName: '' }), /topic/);
  });

  await test('ignores blank options instead of storing them', () => {
    const q = mkQuestion({
      options: [
        { label: 'right', isCorrect: true },
        { label: '  ', isCorrect: false },
        { label: 'wrong', isCorrect: false },
      ],
    });
    assert.equal(q.options.length, 2);
    questions.remove(userId, q.id);
  });

  await test('a correct answer pushes the question further out', () => {
    const correctId = questions.get(userId, questionId).options.find((o) => o.isCorrect).id;
    const first = questions.answer(userId, questionId, correctId);
    assert.equal(first.correct, true);
    assert.equal(first.nextReviewInDays, questions.INTERVALS[0]);
    assert.equal(first.streak, 1);

    const second = questions.answer(userId, questionId, correctId);
    assert.equal(second.nextReviewInDays, questions.INTERVALS[1]);
    assert.equal(second.streak, 2);
  });

  await test('a wrong answer resets the streak and schedules tomorrow', () => {
    const wrongId = questions.get(userId, questionId).options.find((o) => !o.isCorrect).id;
    const result = questions.answer(userId, questionId, wrongId);
    assert.equal(result.correct, false);
    assert.equal(result.streak, 0);
    assert.equal(result.nextReviewInDays, 1);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(result.dueDate, tomorrow.toISOString().slice(0, 10));
  });

  await test('intervals cap at the longest step', () => {
    const correctId = questions.get(userId, questionId).options.find((o) => o.isCorrect).id;
    let seen = 0;
    for (let i = 0; i < questions.INTERVALS.length + 3; i += 1) {
      const r = questions.answer(userId, questionId, correctId);
      seen = r.nextReviewInDays;
    }
    assert.equal(seen, questions.INTERVALS[questions.INTERVALS.length - 1]);
  });

  await test('marks a question known after three correct in a row', () => {
    const q = mkQuestion({ prompt: 'Known check' });
    const correctId = q.options.find((o) => o.isCorrect).id;
    for (let i = 0; i < 3; i += 1) questions.answer(userId, q.id, correctId);
    assert.equal(questions.get(userId, q.id).review.known, true);
    questions.remove(userId, q.id);
  });

  await test('rejects an answer that is not one of the options', () => {
    assert.throws(() => questions.answer(userId, questionId, 999999), /Pick one of the listed/);
  });

  await test('a question not yet due is not in the due queue', () => {
    const q = mkQuestion({ prompt: 'Scheduled ahead' });
    const correctId = q.options.find((o) => o.isCorrect).id;
    questions.answer(userId, q.id, correctId); // due in 1 day
    const due = questions.dueForPlan(userId, planId);
    assert.ok(!due.some((d) => d.id === q.id), 'correctly scheduled future question must not be due');
    questions.remove(userId, q.id);
  });

  await test('a wrong question comes back tomorrow', () => {
    const q = mkQuestion({ prompt: 'Wrong today' });
    const wrongId = q.options.find((o) => !o.isCorrect).id;
    questions.answer(userId, q.id, wrongId);
    const due = questions.dueForPlan(userId, planId);
    assert.ok(!due.some((d) => d.id === q.id), 'due tomorrow, so not due today');
    questions.remove(userId, q.id);
  });

  await test('summary counts due, unseen, known and accuracy', () => {
    const summary = questions.summary(questions.listForPlan(userId, planId));
    assert.ok(summary.total >= 1);
    assert.equal(typeof summary.due, 'number');
    assert.equal(typeof summary.unseen, 'number');
    if (summary.attempts) assert.ok(summary.accuracy >= 0 && summary.accuracy <= 100);
  });

  await test('blocks reading another user\'s question', () => {
    const other = auth.login({ email: 'bob@example.com', password: 'hunter2hunter2' });
    assert.equal(questions.get(other.user.id, questionId), null);
    assert.throws(() => questions.answer(other.user.id, questionId, 1), /no longer exists/);
  });

  await test('editing options resets what the learner had mastered', () => {
    const correctId = questions.get(userId, questionId).options.find((o) => o.isCorrect).id;
    for (let i = 0; i < 3; i += 1) questions.answer(userId, questionId, correctId);
    assert.equal(questions.get(userId, questionId).review.known, true);
    questions.update(userId, questionId, {
      prompt: 'What does ++ do?',
      options: [
        { label: 'New right', isCorrect: true },
        { label: 'New wrong', isCorrect: false },
      ],
    });
    const after = questions.get(userId, questionId).review;
    assert.equal(after.streak, 0);
    assert.equal(after.known, false);
    assert.equal(after.dueDate, new Date().toISOString().slice(0, 10));
  });

  await test('deleting a question clears it', () => {
    questions.remove(userId, questionId);
    assert.equal(questions.get(userId, questionId), null);
    questionId = null;
  });

  await test('deleting a plan removes its questions', () => {
    const tmpPlan = plans.create(userId, { ...input, title: 'Q plan' });
    const q = questions.create(userId, tmpPlan.id, {
      prompt: 'temp', topicId: 's0t0', topicName: 'Algebra', subjectIndex: 0,
      options: [{ label: 'a', isCorrect: true }, { label: 'b', isCorrect: false }],
    });
    plans.remove(userId, tmpPlan.id);
    assert.equal(questions.get(userId, q.id), null);
  });

  // --- ai -----------------------------------------------------------------
  const AI_KEY = 'sk-test-abcdefghijklmnop';

  await test('ai status reports the stored key state', () => {
    assert.equal(ai.statusFor(userId).hasKey, false);
    assert.equal(ai.setApiKey(userId, AI_KEY).hasKey, true);
    const masked = ai.statusFor(userId).maskedKey;
    assert.ok(masked.includes('••••'), `masked key should hide characters: ${masked}`);
    assert.equal(ai.setApiKey(userId, '   ').hasKey, false);
    assert.equal(ai.statusFor(userId).hasKey, false);
    assert.equal(ai.setApiKey(userId, AI_KEY).hasKey, true);
  });

  await test('ai context lists the subject and its topics', () => {
    const aiPlan = plans.create(userId, { ...input, title: 'AI context plan' });
    const saved = plans.get(userId, aiPlan.id);
    const context = ai.buildContext(saved);
    assert.ok(context.includes('Mathematics'), context);
    assert.ok(context.includes('Algebra'), context);
    assert.ok(context.includes('Calculus'), context);
    assert.ok(context.includes('Study plan: AI context plan'), context);
    plans.remove(userId, aiPlan.id);
  });

  await test('ai ask refuses without an api key', async () => {
    ai.setApiKey(userId, '');
    await assert.rejects(() => ai.ask(userId, planId, 'What is a variable?'), /Add your OpenAI API key/);
    ai.setApiKey(userId, AI_KEY);
  });

  await test('ai ask sends the plan context and returns the answer', async () => {
    const realFetch = global.fetch;
    let seenUrl = null;
    let seenBody = null;
    let seenHeaders = null;
    global.fetch = async (url, options) => {
      seenUrl = url;
      seenBody = JSON.parse(options.body);
      seenHeaders = options.headers;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'A variable is a symbol that holds a value.' } }] }) };
    };
    try {
      const result = await ai.ask(userId, planId, 'What is a variable?');
      assert.equal(result.answer, 'A variable is a symbol that holds a value.');
      assert.ok(seenUrl.startsWith('https://api.openai.com/v1/chat/completions'), String(seenUrl));
      assert.equal(seenBody.model, ai.DEFAULT_MODEL);
      assert.equal(seenBody.messages[0].role, 'system');
      const userContent = seenBody.messages[1].content;
      assert.equal(seenBody.messages[1].role, 'user');
      assert.equal(seenBody.messages[1].content.includes('Mathematics'), true);
      assert.equal(seenBody.messages[1].content.includes('Algebra'), true);
      assert.equal(seenBody.messages[1].content.includes('What is a variable?'), true);
      assert.equal(seenHeaders.authorization, `Bearer ${AI_KEY}`);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('ai ask surfaces provider errors', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided' } }),
    });
    try {
      await assert.rejects(() => ai.ask(userId, planId, 'What is a variable?'), /did not answer/);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('ai ask surfaces network failures', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('boom'); };
    try {
      await assert.rejects(() => ai.ask(userId, planId, 'What is a variable?'), /Could not reach the AI provider/);
    } finally {
      global.fetch = realFetch;
    }
  });

  // --- durability --------------------------------------------------------
  await test('data survives a database close and reopen', async () => {
    database.flushNow();
    database.close();
    await database.open(tmpDir);
    assert.equal(auth.userForToken(token).id, userId, 'session survives restart');
    assert.equal(plans.list(userId).length, 2);
    assert.equal(plans.get(userId, planId).title, 'Renamed');
  });

  await test('deleting a user cascades to their plans', () => {
    database.run('DELETE FROM users WHERE id = ?', [userId]);
    assert.equal(plans.list(userId).length, 0);
    assert.equal(auth.userForToken(token), null);
  });

  database.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nHarness crashed:', err);
  process.exit(1);
});