/**
 * Scheduler test suite — plain Node, no framework.
 * Run with: npm test
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { generatePlan, ValidationError, _internals } = require('../electron/services/scheduler.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// --------------------------------------------------------------------------
const baseInput = {
  title: 'Finals',
  startDate: '2026-03-02', // Monday
  examDate: '2026-03-27', // Friday, 25 days later
  studyDays: [1, 2, 3, 4, 5, 6],
  dailyHours: 3,
  sessionMinutes: 60,
  breakMinutes: 10,
  reserveDays: 2,
  reviews: true,
  subjects: [
    {
      name: 'Mathematics',
      difficulty: 'hard',
      priority: 'high',
      hoursPerWeek: null,
      topics: [
        { name: 'Algebra', importance: 'core' },
        { name: 'Calculus', importance: 'core' },
        { name: 'Probability', importance: 'high' },
      ],
    },
    {
      name: 'History',
      difficulty: 'easy',
      priority: 'normal',
      hoursPerWeek: null,
      topics: [
        { name: 'Revolutions', importance: 'medium' },
        { name: 'Industrial age', importance: 'medium' },
      ],
    },
    {
      name: 'Chemistry',
      difficulty: 'medium',
      priority: 'vital',
      hoursPerWeek: null,
      topics: [
        { name: 'Stoichiometry', importance: 'high' },
        { name: 'Organic basics', importance: 'medium' },
      ],
    },
  ],
};

// --------------------------------------------------------------------------
section('Date helpers');

test('isoWeekday maps Monday..Sunday to 1..7', () => {
  assert.equal(_internals.isoWeekday(new Date(2026, 2, 2)), 1);
  assert.equal(_internals.isoWeekday(new Date(2026, 2, 8)), 7);
});

test('isoWeekKey handles year boundaries', () => {
  assert.equal(_internals.isoWeekKey(new Date(2026, 0, 1)), '2026-W01');
  assert.equal(_internals.isoWeekKey(new Date(2024, 11, 30)), '2025-W01');
});

// --------------------------------------------------------------------------
section('Validation');

test('rejects missing subjects', () => {
  assert.throws(() => generatePlan({ ...baseInput, subjects: [] }), ValidationError);
});

test('rejects a subject with no topics', () => {
  assert.throws(
    () => generatePlan({ ...baseInput, subjects: [{ name: 'Empty', topics: [] }] }),
    ValidationError,
  );
});

test('rejects exam date before start date', () => {
  assert.throws(
    () => generatePlan({ ...baseInput, startDate: '2026-03-20', examDate: '2026-03-10' }),
    ValidationError,
  );
});

test('rejects malformed dates', () => {
  assert.throws(() => generatePlan({ ...baseInput, startDate: '02/03/2026' }), ValidationError);
});

test('rejects a plan with no study days before the exam', () => {
  assert.throws(
    () => generatePlan({ ...baseInput, startDate: '2026-03-02', examDate: '2026-03-03', reserveDays: 0 }),
    ValidationError,
  );
});

// --------------------------------------------------------------------------
section('Session splitting');

test('splits into full sessions plus one remainder', () => {
  assert.deepEqual(_internals.splitIntoSessions(150, 60, 25), [60, 60, 30]);
});

test('splits a trailing sliver into two balanced sessions', () => {
  // 130 minutes at 60/25 would leave a 10m stub; balance it instead.
  assert.deepEqual(_internals.splitIntoSessions(130, 60, 25), [60, 35, 35]);
});

test('never produces a session longer than the configured maximum', () => {
  const sessions = _internals.splitIntoSessions(185, 60, 25);
  assert.equal(sessions.reduce((a, b) => a + b, 0), 185);
  assert.ok(sessions.every((m) => m <= 60), `oversized session: ${sessions}`);
  assert.ok(sessions.every((m) => m >= 25), `undersized session: ${sessions}`);
});

test('handles zero budget without looping forever', () => {
  assert.deepEqual(_internals.splitIntoSessions(0, 60, 25), []);
});

// --------------------------------------------------------------------------
section('Plan generation');

const plan = generatePlan(baseInput);

test('produces a non-empty day breakdown', () => {
  assert.ok(plan.days.length > 0, 'expected study days');
  assert.ok(plan.stats.totalSessions > 0, 'expected sessions');
});

test('never schedules on the exam day or the day before', () => {
  for (const day of plan.days) {
    assert.notEqual(day.date, '2026-03-27');
    assert.notEqual(day.date, '2026-03-26');
  }
});

test('only schedules on configured weekdays', () => {
  for (const day of plan.days) {
    assert.ok(day.weekday >= 1 && day.weekday <= 6, `unexpected weekday ${day.weekday}`);
  }
});

test('respects the daily capacity', () => {
  for (const day of plan.days) {
    const minutes = day.sessions.reduce((a, s) => a + s.minutes + 10, 0) - 10;
    assert.ok(minutes <= 180, `${day.date} uses ${minutes} minutes`);
  }
});

test('a strictly-placed session never lands on a subject-heavy day', () => {
  // The real contract: if a session was placed without relaxing, then at the
  // moment it was placed its subject already had fewer than 2 sessions that day.
  for (const day of plan.days) {
    const running = new Map();
    for (const s of [...day.sessions].sort((a, b) => a.order - b.order)) {
      const seen = running.get(s.subjectIndex) || 0;
      if (s.kind === 'learn' && s.relaxLevel === 0) {
        assert.ok(seen < 2, `${day.date}: subject ${s.subjectIndex} unrelaxed with ${seen} already placed`);
      }
      running.set(s.subjectIndex, seen + 1);
    }
  }
});

test('subject balance holds for the vast majority of sessions', () => {
  let violations = 0;
  let total = 0;
  for (const day of plan.days) {
    const learn = day.sessions.filter((s) => s.kind === 'learn');
    total += learn.length;
    const counts = new Map();
    for (const s of learn) counts.set(s.subjectIndex, (counts.get(s.subjectIndex) || 0) + 1);
    for (const [, n] of counts) if (n > 2) violations += 1;
  }
  assert.ok(
    violations <= Math.ceil(total * 0.1),
    `balance relaxed on ${violations}/${total} learning sessions`,
  );
});

test('spaces sessions of the same topic across different days', () => {
  const seen = new Map();
  plan.days.forEach((day, dayIndex) => {
    for (const s of day.sessions) {
      if (s.kind !== 'learn') continue;
      const prev = seen.get(s.topicId);
      if (prev != null) {
        assert.ok(
          dayIndex - prev >= 1,
          `topic ${s.topicId} (${s.subjectName}/${s.topicName}) has 2 learn sessions on one day`,
        );
      }
      seen.set(s.topicId, dayIndex);
    }
  });
});

test('assigns non-overlapping start times within a day', () => {
  for (const day of plan.days) {
    for (let i = 1; i < day.sessions.length; i += 1) {
      const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      assert.ok(
        toMin(day.sessions[i].startTime) >= toMin(day.sessions[i - 1].startTime),
        'sessions out of order',
      );
    }
    assert.ok(day.sessions.every((s) => /^\d{2}:\d{2}$/.test(s.startTime)));
  }
});

test('keeps new material inside the learning window (taper before exam)', () => {
  const learnDays = plan.days.filter((d) => d.sessions.some((s) => s.kind === 'learn'));
  const lastLearnDay = learnDays[learnDays.length - 1];
  assert.ok(
    lastLearnDay.date < plan.days[plan.days.length - 1].date,
    'expected review-only days at the end',
  );
});

test('harder subjects receive more time than easier ones', () => {
  const byName = Object.fromEntries(plan.subjects.map((s) => [s.name, s.minutes]));
  assert.ok(byName.Mathematics > byName.History, 'hard subject should outweigh easy');
});

test('respects an explicit weekly hour cap', () => {
  const capped = generatePlan({
    ...baseInput,
    subjects: baseInput.subjects.map((s) => ({ ...s, hoursPerWeek: 2 })),
  });

  const weekTotals = new Map();
  for (const day of capped.days) {
    for (const s of day.sessions) {
      const key = `${day.week}|${s.subjectIndex}`;
      weekTotals.set(key, (weekTotals.get(key) || 0) + s.minutes);
    }
  }

  // Per-week caps scale with the number of study days in that week, and the
  // engine may relax them (relaxLevel 3) when a week genuinely overflows.
  let checked = 0;
  for (const [key, minutes] of weekTotals) {
    const [week, subjectIndex] = key.split('|');
    const studyDaysInWeek = capped.days.filter((d) => d.week === week).length;
    const cap = (2 * 60 * studyDaysInWeek) / 7;
    if (minutes <= cap + 0.5) { checked += 1; continue; }
    // Overflow is only acceptable when the engine explicitly relaxed the cap.
    const overflowing = capped.days
      .filter((d) => d.week === week)
      .flatMap((d) => d.sessions)
      .filter((s) => String(s.subjectIndex) === subjectIndex && s.relaxLevel >= 3);
    assert.ok(
      overflowing.length > 0,
      `${key} used ${minutes} > ${cap.toFixed(0)} without relaxing the cap`,
    );
  }
  assert.ok(checked > 0, 'expected at least one week inside its cap');
});

test('never exceeds a weekly cap by a wide margin', () => {
  const capped = generatePlan({
    ...baseInput,
    subjects: baseInput.subjects.map((s) => ({ ...s, hoursPerWeek: 3 })),
  });
  const byWeek = new Map();
  for (const day of capped.days) {
    for (const s of day.sessions) {
      const key = `${day.week}|${s.subjectIndex}`;
      byWeek.set(key, (byWeek.get(key) || 0) + s.minutes);
    }
  }
  for (const [key, minutes] of byWeek) {
    const [week] = key.split('|');
    const studyDaysInWeek = capped.days.filter((d) => d.week === week).length;
    const cap = (3 * 60 * studyDaysInWeek) / 7;
    assert.ok(minutes <= cap * 1.5 + 0.5, `${key} used ${minutes} vs cap ${cap.toFixed(0)}`);
  }
});

test('is deterministic', () => {
  const a = JSON.stringify(generatePlan(baseInput).days);
  const b = JSON.stringify(generatePlan(baseInput).days);
  assert.equal(a, b);
});

test('scales down when demand exceeds the budget and warns', () => {
  const tight = generatePlan({
    ...baseInput,
    dailyHours: 1,
    subjects: [
      {
        name: 'Huge',
        difficulty: 'expert',
        topics: Array.from({ length: 20 }, (_, i) => ({ name: `Topic ${i}`, importance: 'core' })),
      },
    ],
  });
  assert.ok(tight.warnings.some((w) => /scaled/i.test(w)), 'expected a scaling warning');
  assert.equal(
    tight.days.reduce((a, d) => a + d.sessions.reduce((b, s) => b + s.minutes, 0), 0),
    tight.stats.totalMinutes,
  );
});

test('emits spaced review sessions after learning sessions', () => {
  const reviews = plan.days.flatMap((d) => d.sessions.filter((s) => s.kind === 'review'));
  assert.ok(reviews.length > 0, 'expected review sessions');
  const learnByTopic = new Map();
  plan.days.forEach((day, i) => {
    for (const s of day.sessions) {
      if (s.kind === 'learn' && !learnByTopic.has(s.topicId)) learnByTopic.set(s.topicId, i);
    }
  });
  plan.days.forEach((day, i) => {
    for (const s of day.sessions) {
      if (s.kind !== 'review') continue;
      const learned = learnByTopic.get(s.topicId);
      assert.ok(learned != null, 'review before any learning session');
      assert.ok(i > learned, 'review on or before the learning day');
    }
  });
});

test('reports totals consistent with the day breakdown', () => {
  const fromDays = plan.days.reduce((a, d) => a + d.sessions.reduce((b, s) => b + s.minutes, 0), 0);
  assert.equal(fromDays, plan.stats.totalMinutes);
  const fromSubjects = plan.subjects.reduce((a, s) => a + s.minutes, 0);
  assert.equal(fromSubjects, plan.stats.totalMinutes);
  assert.equal(
    plan.subjects.reduce((a, s) => a + s.percent, 0) >= 98,
    true,
    'subject percentages should roughly sum to 100',
  );
});

test('weekly totals are chronological', () => {
  const weeks = plan.weeklyTotals.map((w) => w.week);
  assert.deepEqual(weeks, [...weeks].sort());
});

// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}