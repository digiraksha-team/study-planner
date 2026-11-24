'use strict';

/**
 * StudyFlow scheduling engine.
 *
 * Deterministic, dependency-free plan generator. Given subjects/topics and a
 * time budget it produces a day-by-day breakdown. The pipeline is:
 *
 *   1. normalise + validate input
 *   2. build a calendar of study days and compute daily capacity
 *   3. estimate how long each topic deserves (difficulty x importance x priority)
 *   4. water-fill that demand into the available budget (respecting weekly caps)
 *   5. split each topic's budget into discrete sessions
 *   6. place sessions into days, round-robin across subjects, front-loading the
 *      heaviest topics and enforcing spacing / cap / balance constraints
 *   7. drop spaced-review passes into leftover capacity
 *
 * No randomness, no network, no AI. Same input always yields the same plan.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DIFFICULTY_FACTOR = { easy: 0.75, medium: 1, hard: 1.4, expert: 1.9 };
const IMPORTANCE_FACTOR = { low: 0.8, medium: 1, high: 1.3, core: 1.6 };
const PRIORITY_FACTOR = { low: 0.7, medium: 0.85, normal: 1, high: 1.2, vital: 1.45 };

const DEFAULTS = {
  sessionMinutes: 60,
  breakMinutes: 10,
  minSessionMinutes: 25,
  dailyHours: 3,
  windowStart: '09:00',
  studyDays: [1, 2, 3, 4, 5, 6],
  reserveDays: 2,
  reviews: true,
  reviewOffsets: [1, 3, 7, 14],
  reviewMinutes: 25,
  baseTopicHours: 1.5,
  roundTo: 5,
};

const MIN_DAY_GAP = 1; // sessions on the same topic land on different days
const MAX_SUBJECT_SESSIONS_PER_DAY = 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function roundTo(value, step) {
  return Math.max(step, Math.round(value / step) * step);
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) throw new ValidationError(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + n);
  return next;
}

/** Whole days between two local-noon anchors; DST safe. */
function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

/** ISO-8601 week identifier, used for per-subject weekly caps. */
function isoWeekKey(date) {
  // ISO weeks run Monday..Sunday and are numbered by the year of their Thursday.
  // Thursday sits 4 - isoWeekday days ahead of any day in the same week.
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  target.setDate(target.getDate() + (4 - isoWeekday(target)));
  const year = target.getFullYear();
  // Jan 4th is always in ISO week 1; walk back to that week's Thursday.
  const firstThursday = new Date(year, 0, 4, 12);
  firstThursday.setDate(firstThursday.getDate() + (4 - isoWeekday(firstThursday)));
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function addMinutesToClock(clock, minutes) {
  const [h, m] = String(clock).split(':').map(Number);
  const total = clamp((h || 0) * 60 + (m || 0) + minutes, 0, 24 * 60 - 1);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function normaliseInput(raw) {
  const input = { ...DEFAULTS, ...(raw || {}) };

  input.sessionMinutes = clamp(Number(input.sessionMinutes) || DEFAULTS.sessionMinutes, 15, 240);
  input.breakMinutes = clamp(Number(input.breakMinutes) || 0, 0, 60);
  input.minSessionMinutes = clamp(Number(input.minSessionMinutes) || DEFAULTS.minSessionMinutes, 10, input.sessionMinutes);
  input.reviewMinutes = clamp(Number(input.reviewMinutes) || DEFAULTS.reviewMinutes, 10, 180);
  input.baseTopicHours = clamp(Number(input.baseTopicHours) || DEFAULTS.baseTopicHours, 0.25, 12);
  input.dailyHours = clamp(Number(input.dailyHours) || DEFAULTS.dailyHours, 0.5, 16);
  input.windowStart = /^\d{2}:\d{2}$/.test(input.windowStart) ? input.windowStart : DEFAULTS.windowStart;
  input.reserveDays = clamp(Number(input.reserveDays) || 0, 0, 21);
  input.reviewOffsets = Array.isArray(input.reviewOffsets) && input.reviewOffsets.length
    ? input.reviewOffsets.map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
    : DEFAULTS.reviewOffsets;

  const days = Array.isArray(input.studyDays)
    ? [...new Set(input.studyDays.map(Number).filter((n) => n >= 1 && n <= 7))].sort()
    : DEFAULTS.studyDays;
  if (!days.length) throw new ValidationError('Select at least one study day.');
  input.studyDays = days;

  const subjects = Array.isArray(raw && raw.subjects) ? raw.subjects : [];
  if (!subjects.length) throw new ValidationError('Add at least one subject.');

  input.subjects = subjects.map((s, i) => {
    const name = String(s.name || '').trim() || `Subject ${i + 1}`;
    const topics = (Array.isArray(s.topics) ? s.topics : [])
      .map((t) => ({
        name: String(t.name || '').trim(),
        hours: t.hours === '' || t.hours == null ? null : Number(t.hours),
        importance: IMPORTANCE_FACTOR[t.importance] ? t.importance : 'medium',
      }))
      .filter((t) => t.name);
    if (!topics.length) throw new ValidationError(`Subject "${name}" needs at least one topic.`);
    for (const t of topics) {
      if (t.hours != null && (!Number.isFinite(t.hours) || t.hours <= 0)) {
        throw new ValidationError(`Topic "${t.name}" has an invalid hour estimate.`);
      }
    }
    return {
      name,
      difficulty: DIFFICULTY_FACTOR[s.difficulty] ? s.difficulty : 'medium',
      priority: PRIORITY_FACTOR[s.priority] ? s.priority : 'normal',
      hoursPerWeek: s.hoursPerWeek === '' || s.hoursPerWeek == null ? null : Number(s.hoursPerWeek),
      topics,
    };
  });
  for (const s of input.subjects) {
    if (s.hoursPerWeek != null && (!Number.isFinite(s.hoursPerWeek) || s.hoursPerWeek <= 0)) {
      throw new ValidationError(`Subject "${s.name}" has an invalid weekly hour limit.`);
    }
  }

  return input;
}

// ---------------------------------------------------------------------------
// Stage 3-4: demand estimation + budget water-filling
// ---------------------------------------------------------------------------

function buildSubjects(input) {
  return input.subjects.map((s, subjectIndex) => {
    const difficultyFactor = DIFFICULTY_FACTOR[s.difficulty];
    const priorityFactor = PRIORITY_FACTOR[s.priority];

    const topics = s.topics.map((t, topicIndex) => {
      const importanceFactor = IMPORTANCE_FACTOR[t.importance];
      const estimatedHours = t.hours != null
        ? t.hours
        : input.baseTopicHours * difficultyFactor * importanceFactor;
      return {
        id: `s${subjectIndex}t${topicIndex}`,
        subjectIndex,
        subjectName: s.name,
        name: t.name,
        difficulty: s.difficulty,
        importance: t.importance,
        estimatedHours: round2(estimatedHours),
        weight: estimatedHours * difficultyFactor * importanceFactor * priorityFactor,
        minutes: 0,
      };
    });

    return {
      subjectIndex,
      name: s.name,
      difficulty: s.difficulty,
      priority: s.priority,
      hoursPerWeek: s.hoursPerWeek,
      topics,
      weightSum: sum(topics.map((t) => t.weight)),
      naturalMinutes: sum(topics.map((t) => t.estimatedHours * 60)),
      allocatedMinutes: 0,
    };
  });
}

/**
 * Spread the learning budget across subjects.
 *
 * Pass 1 scales every subject down proportionally if total demand exceeds the
 * learning budget. Pass 2..n enforce per-subject weekly caps, pushing any
 * overflow onto subjects that still have headroom.
 */
function allocateBudget(subjects, learningBudgetMinutes, caps, roundStep, reserves) {
  const naturalTotal = sum(subjects.map((s) => s.naturalMinutes));
  const scale = naturalTotal > learningBudgetMinutes && naturalTotal > 0
    ? learningBudgetMinutes / naturalTotal
    : 1;

  const scaled = subjects.map((s) => s.naturalMinutes * scale);
  let allocated = scaled.slice();

  // A weekly cap covers everything the student does for that subject, including
  // spaced reviews, so reviews are reserved before learning time is handed out.
  const learningCaps = subjects.map((s, i) => (
    caps[i] == null ? null : Math.max(0, caps[i] - (reserves[i] || 0))
  ));

  const capped = subjects.some((s, i) => learningCaps[i] != null && scaled[i] > learningCaps[i] + 0.5);

  for (let pass = 0; pass < 6; pass += 1) {
    let excess = 0;
    subjects.forEach((s, i) => {
      const cap = learningCaps[i];
      if (cap != null && allocated[i] > cap) {
        excess += allocated[i] - cap;
        allocated[i] = cap;
      }
    });
    if (excess <= 0.5) break;

    // Subjects that still have headroom, either uncapped or under their cap.
    const open = subjects
      .map((s, i) => i)
      .filter((i) => learningCaps[i] == null || allocated[i] < learningCaps[i]);
    if (!open.length) break;

    const openWeight = sum(open.map((i) => subjects[i].weightSum));
    let remaining = excess;
    for (const i of open) {
      const share = openWeight > 0
        ? excess * (subjects[i].weightSum / openWeight)
        : excess / open.length;
      const grant = Math.min(remaining, share);
      allocated[i] += grant;
      remaining -= grant;
    }
  }

  subjects.forEach((s, i) => {
    s.allocatedMinutes = allocated[i];
    if (s.weightSum <= 0 || s.allocatedMinutes <= 0) {
      s.topics.forEach((t) => { t.minutes = 0; });
      return;
    }
    let assigned = 0;
    s.topics.forEach((t, ti) => {
      const share = ti === s.topics.length - 1
        ? s.allocatedMinutes - assigned
        : (s.allocatedMinutes * t.weight) / s.weightSum;
      const minutes = Math.max(roundTo(share, roundStep), 0);
      t.minutes = minutes;
      assigned += minutes;
    });
  });

  return { scale, capped };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Stage 5: split topic budgets into sessions
// ---------------------------------------------------------------------------

function splitIntoSessions(totalMinutes, sessionMinutes, minSessionMinutes) {
  const sessions = [];
  let remaining = Math.max(totalMinutes, 0);
  let guard = 0;

  while (remaining > 0 && guard < 500) {
    guard += 1;

    if (remaining <= sessionMinutes) {
      sessions.push(remaining);
      break;
    }

    const leftover = remaining - sessionMinutes;
    if (leftover >= minSessionMinutes) {
      sessions.push(sessionMinutes);
      remaining = leftover;
      continue;
    }

    // A full session would leave an unusably short tail. Split the remainder
    // into two balanced sessions instead of one oversized one.
    const half = Math.ceil(remaining / 2);
    sessions.push(half, remaining - half);
    remaining = 0;
  }

  return sessions;
}

function buildLearnUnits(subjects, input) {
  const perSubject = subjects.map((subject) => {
    const units = [];
    // Heaviest topic first so that front-loading falls out of the placement.
    const orderedTopics = [...subject.topics].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    for (const topic of orderedTopics) {
      const durations = splitIntoSessions(topic.minutes, input.sessionMinutes, input.minSessionMinutes);
      durations.forEach((minutes, partIndex) => {
        units.push({
          kind: 'learn',
          subjectIndex: subject.subjectIndex,
          subjectName: subject.name,
          topicId: topic.id,
          topicName: topic.name,
          difficulty: topic.difficulty,
          minutes,
          partIndex,
          partCount: durations.length,
          weight: topic.weight,
        });
      });
    }
    return units;
  });

  // Round-robin merge: alternate subjects so no single subject dominates a day.
  const pointers = subjects.map(() => 0);
  const ordered = [];
  const total = sum(perSubject.map((u) => u.length));
  let offset = 0;
  while (ordered.length < total) {
    let progressed = false;
    for (let i = 0; i < subjects.length; i += 1) {
      const idx = (offset + i) % subjects.length;
      if (pointers[idx] < perSubject[idx].length) {
        ordered.push(perSubject[idx][pointers[idx]]);
        pointers[idx] += 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    offset = (offset + 1) % Math.max(subjects.length, 1);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Stage 6: placement
// ---------------------------------------------------------------------------

function createPlacement(studyDays, subjects, dailyCapacity, breakMinutes, learningDayCount, weekCap) {
  const days = studyDays.map((date) => ({
    date: formatDate(date),
    dateObj: date,
    weekday: isoWeekday(date),
    week: isoWeekKey(date),
    capacityMinutes: dailyCapacity,
    usedMinutes: 0,
    sessions: [],
    isLearningDay: false,
  }));
  for (let i = 0; i < learningDayCount; i += 1) days[i].isLearningDay = true;

  const weekUsage = new Map(); // `${week}|${subjectIndex}` -> minutes
  const subjectDayCount = new Map(); // `${dayIndex}|${subjectIndex}` -> sessions
  const topicLastDay = new Map();
  const topicFirstDay = new Map();
  const unplaced = [];

  const bump = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount);

  function constraintsMet(dayIndex, unit, relax) {
    const day = days[dayIndex];

    // Hard: never exceed the day's time window.
    if (day.usedMinutes + unit.minutes + breakMinutes > day.capacityMinutes + 0.5) return false;

    // Hard: new material only during the learning window (keeps the taper).
    if (unit.kind === 'learn' && !day.isLearningDay) return false;

    // Hard: never put two learning sessions of the same topic in one day.
    // Interleaving matters more than any preference, so relaxation skips this.
    // This must scan the day rather than compare against the topic's last
    // placement: parts of a topic are placed in order, so the most recent
    // placement may sit on an earlier day while an older one still occupies
    // this one.
    if (unit.kind === 'learn' && day.sessions.some((s) => s.topicId === unit.topicId)) {
      return false;
    }

    // Relax 3+: skip the per-week subject cap.
    if (relax < 3) {
      const cap = weekCap(unit.subjectIndex, day.week);
      if (cap != null) {
        const used = weekUsage.get(`${day.week}|${unit.subjectIndex}`) || 0;
        if (used + unit.minutes > cap + 0.5) return false;
      }
    }

    // Relax 2+: ignore spacing between sessions of the same topic.
    if (relax < 2) {
      const last = topicLastDay.get(unit.topicId);
      if (last != null && dayIndex - last < MIN_DAY_GAP) return false;
    }

    // Relax 1+: stop limiting how much of a day one subject may take.
    if (relax < 1) {
      const count = subjectDayCount.get(`${dayIndex}|${unit.subjectIndex}`) || 0;
      if (count >= MAX_SUBJECT_SESSIONS_PER_DAY) return false;
    }

    return true;
  }

  function commit(dayIndex, unit, relax) {
    const day = days[dayIndex];
    day.sessions.push({ ...unit, order: day.sessions.length, relaxLevel: relax });
    day.usedMinutes += unit.minutes + breakMinutes;
    bump(weekUsage, `${day.week}|${unit.subjectIndex}`, unit.minutes);
    bump(subjectDayCount, `${dayIndex}|${unit.subjectIndex}`, 1);
    if (unit.kind === 'learn') {
      topicLastDay.set(unit.topicId, dayIndex);
      if (!topicFirstDay.has(unit.topicId)) topicFirstDay.set(unit.topicId, dayIndex);
    }
  }

  /**
   * Visit days by increasing distance from a target day, preferring the earlier
   * day on ties. Anchoring each session near its proportional slot spreads the
   * workload evenly across the window instead of cramming everything into the
   * first week and leaving the student idle afterwards.
   */
  function searchOrder(center, length) {
    const start = clamp(center, 0, length - 1);
    const order = [];
    for (let d = 0; d < length; d += 1) {
      const left = start - d;
      const right = start + d;
      if (left >= 0) order.push(left);
      if (right < length && right !== left) order.push(right);
    }
    return order;
  }

  function place(unit, targetDayIndex) {
    const order = searchOrder(targetDayIndex == null ? 0 : targetDayIndex, days.length);
    for (let relax = 0; relax < 4; relax += 1) {
      for (const dayIndex of order) {
        if (!constraintsMet(dayIndex, unit, relax)) continue;
        commit(dayIndex, unit, relax);
        return dayIndex;
      }
    }
    return -1;
  }

  const weekMinutes = (week, subjectIndex) => weekUsage.get(`${week}|${subjectIndex}`) || 0;

  /** Reviews bypass the learning ladder but must still consume real time. */
  function addReview(dayIndex, unit) {
    const day = days[dayIndex];
    day.sessions.push({ ...unit, order: day.sessions.length, relaxLevel: null });
    day.usedMinutes += unit.minutes + breakMinutes;
    bump(weekUsage, `${day.week}|${unit.subjectIndex}`, unit.minutes);
    topicLastDay.set(unit.topicId, dayIndex);
  }

  return { days, place, addReview, topicFirstDay, topicLastDay, weekMinutes, unplaced };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function generatePlan(rawInput) {
  const input = normaliseInput(rawInput);
  const startDate = parseDate(input.startDate);
  const examDate = parseDate(input.examDate);

  if (daysBetween(startDate, examDate) < 1) {
    throw new ValidationError('The exam date must be at least one day after the start date.');
  }

  // --- Stage 2: calendar + capacity -----------------------------------------
  const calendarDays = [];
  for (let d = new Date(startDate.getTime()); d <= examDate; d = addDays(d, 1)) {
    if (input.studyDays.includes(isoWeekday(d))) calendarDays.push(d);
  }
  // Never schedule on the exam day itself, nor the day before it.
  const usableDays = calendarDays.filter((d) => daysBetween(d, examDate) >= 2);
  if (usableDays.length < 1) {
    throw new ValidationError('Not enough study days before the exam. Add study days or move the exam date.');
  }

  const reserve = Math.min(input.reserveDays, Math.max(0, usableDays.length - 2));
  const studyDays = usableDays.slice(0, usableDays.length - reserve);
  const learningDayCount = Math.max(1, studyDays.length - reserve);

  const dailyCapacity = input.dailyHours * 60;
  const totalCapacityMinutes = studyDays.length * dailyCapacity;

  // --- Stage 3-4: subjects, demand, budget ----------------------------------
  const subjects = buildSubjects(input);
  const totalTopics = sum(subjects.map((s) => s.topics.length));

  // Caps must be measured in *study* weeks, not calendar weeks: the first and
  // last week are usually partial. Counting actual study days per ISO week keeps
  // the allocation stage and the placement stage agreeing on the same budget.
  const weekDayCounts = new Map();
  for (const d of studyDays) {
    const key = isoWeekKey(d);
    weekDayCounts.set(key, (weekDayCounts.get(key) || 0) + 1);
  }
  const studyWeekFraction = sum([...weekDayCounts.values()]) / 7;
  const makeWeekCap = (subject, weekKey) => {
    if (subject.hoursPerWeek == null) return null;
    const days = weekDayCounts.get(weekKey) || 0;
    return (subject.hoursPerWeek * 60 * days) / 7;
  };
  const subjectCaps = subjects.map((s) => (
    s.hoursPerWeek != null ? s.hoursPerWeek * 60 * studyWeekFraction : null
  ));
  const weekCapFor = (subjectIndex, weekKey) => makeWeekCap(subjects[subjectIndex], weekKey);

  const reviewReserveMinutes = input.reviews
    ? input.reviewOffsets.length * input.reviewMinutes * totalTopics
    : 0;
  const reviewShare = totalCapacityMinutes > 0
    ? Math.min(0.45, reviewReserveMinutes / totalCapacityMinutes)
    : 0;
  const learningBudgetMinutes = totalCapacityMinutes * (1 - reviewShare);

  // Reviews draw from the same weekly allowance the student set for a subject.
  const subjectReviewReserve = subjects.map((s) => (
    input.reviews ? s.topics.length * input.reviewOffsets.length * input.reviewMinutes : 0
  ));

  const { scale, capped } = allocateBudget(
    subjects,
    learningBudgetMinutes,
    subjectCaps,
    input.roundTo,
    subjectReviewReserve,
  );

  // --- Stage 5-6: sessions + placement --------------------------------------
  const units = buildLearnUnits(subjects, input);
  const totalUnits = units.length;
  let scheduledMinutes = 0;
  const placement = createPlacement(
    studyDays,
    subjects,
    dailyCapacity,
    input.breakMinutes,
    learningDayCount,
    weekCapFor,
  );

  // Spread sessions across the learning window at an even pace. The first unit
  // anchors to day 0 and the last to the final learning day, so a light plan
  // starts immediately instead of leaving a dead zone at the beginning.
  const lastIndex = Math.max(totalUnits - 1, 1);
  const lastLearningDay = Math.max(learningDayCount - 1, 0);
  units.forEach((unit, i) => {
    const target = clamp(Math.round((i / lastIndex) * lastLearningDay), 0, lastLearningDay);
    const dayIndex = placement.place(unit, target);
    if (dayIndex === -1) placement.unplaced.push(unit);
    else scheduledMinutes += unit.minutes;
  });

  // --- Stage 7: spaced review -----------------------------------------------
  const reviews = input.reviews
    ? placeReviews(placement, studyDays, subjects, input, weekCapFor, dailyCapacity)
    : { placed: 0, dropped: 0, droppedPastExam: 0, droppedNoRoom: 0 };

  // --- Start times ----------------------------------------------------------
  placement.days.forEach((day, dayIndex) => {
    let cursor = input.windowStart;
    day.sessions.sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0) || a.order - b.order);
    day.sessions.forEach((session, slot) => {
      session.startTime = cursor;
      // Stable id so progress can be tracked across regenerations.
      session.id = `d${dayIndex}s${slot}`;
      cursor = addMinutesToClock(cursor, session.minutes + input.breakMinutes);
    });
    day.sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
    delete day.dateObj;
  });

  // --- Stats ----------------------------------------------------------------
  const totalMinutes = placement.days.reduce((acc, d) => acc + d.sessions.reduce((a, s) => a + s.minutes, 0), 0);
  const subjectStats = subjects.map((s) => {
    const minutes = placement.days.reduce(
      (acc, d) => acc + d.sessions.filter((sess) => sess.subjectIndex === s.subjectIndex).reduce((a, s2) => a + s2.minutes, 0),
      0,
    );
    return {
      subjectIndex: s.subjectIndex,
      name: s.name,
      difficulty: s.difficulty,
      priority: s.priority,
      hoursPerWeek: s.hoursPerWeek,
      minutes,
      percent: totalMinutes ? Math.round((minutes / totalMinutes) * 100) : 0,
      topicCount: s.topics.length,
      sessionCount: placement.days.reduce(
        (acc, d) => acc + d.sessions.filter((sess) => sess.subjectIndex === s.subjectIndex).length,
        0,
      ),
    };
  });

  const weeklyTotals = [];
  for (const day of placement.days) {
    const minutes = day.sessions.reduce((a, s) => a + s.minutes, 0);
    if (!minutes) continue;
    const last = weeklyTotals[weeklyTotals.length - 1];
    if (last && last.week === day.week) {
      last.minutes += minutes;
      last.sessions += day.sessions.length;
    } else {
      weeklyTotals.push({ week: day.week, startDate: day.date, minutes, sessions: day.sessions.length });
    }
  }

  const warnings = [];
  if (scale < 0.995) {
    warnings.push(
      `Your topics needed about ${Math.round(sum(subjects.map((s) => s.naturalMinutes)) / 60)}h but only `
      + `${Math.round(totalCapacityMinutes / 60)}h are available before the exam. `
      + `Estimates were scaled to ${Math.round(scale * 100)}% to fit.`,
    );
  }
  if (capped) {
    warnings.push('One or more subjects hit their weekly hour limit, so time was reallocated to other subjects.');
  }
  if (placement.unplaced.length) {
    const lost = placement.unplaced.reduce((a, u) => a + u.minutes, 0);
    warnings.push(
      `${placement.unplaced.length} session(s) (~${Math.round(lost / 60)}h) could not fit before the exam. `
      + 'Add study hours, remove topics, or move the exam date.',
    );
  }
  if (reviews.droppedPastExam > 0) {
    warnings.push(
      `${reviews.droppedPastExam} later review pass(es) land after your exam date and were left out. `
      + 'Topics covered close to the exam get fewer revision rounds.',
    );
  }
  if (reviews.droppedNoRoom > 0) {
    warnings.push(`${reviews.droppedNoRoom} review session(s) did not fit and were skipped.`);
  }
  if (scale >= 0.995) {
    const used = totalCapacityMinutes > 0 ? totalMinutes / totalCapacityMinutes : 0;
    if (used < 0.7) {
      const spare = Math.round(((totalCapacityMinutes - totalMinutes) / 60) * 10) / 10;
      warnings.push(
        `You have about ${spare}h of unused capacity before the exam. `
        + 'Add more topics, or study fewer days to give each session more depth.',
      );
    }
  }
  if (!warnings.length) {
    warnings.push('Everything fits comfortably inside your available time.');
  }

  return {
    input,
    range: {
      startDate: formatDate(startDate),
      examDate: formatDate(examDate),
      daysUntilExam: daysBetween(startDate, examDate),
      studyDays: studyDays.length,
      learningDays: learningDayCount,
      reserveDays: reserve,
    },
    days: placement.days,
    subjects: subjectStats,
    weeklyTotals,
    stats: {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      totalSessions: placement.days.reduce((a, d) => a + d.sessions.length, 0),
      learnSessions: placement.days.reduce((a, d) => a + d.sessions.filter((s) => s.kind === 'learn').length, 0),
      reviewSessions: placement.days.reduce((a, d) => a + d.sessions.filter((s) => s.kind === 'review').length, 0),
      topicCount: totalTopics,
      capacityMinutes: totalCapacityMinutes,
      capacityUsedPercent: totalCapacityMinutes
        ? Math.round((totalMinutes / totalCapacityMinutes) * 100)
        : 0,
      avgSessionMinutes: Math.round(
        totalMinutes / Math.max(1, placement.days.reduce((a, d) => a + d.sessions.length, 0)),
      ),
    },
    warnings,
  };
}

/** Drop review passes into whatever capacity is left, earliest deadline first. */
function placeReviews(placement, studyDays, subjects, input, weekCapFor, dailyCapacity) {
  let placed = 0;
  let droppedPastExam = 0;
  let droppedNoRoom = 0;

  const anchors = [];
  subjects.forEach((subject) => {
    subject.topics.forEach((topic) => {
      const first = placement.topicFirstDay.get(topic.id);
      if (first == null) return;
      anchors.push({ topic, subject, anchorDate: studyDays[first] });
    });
  });
  anchors.sort((a, b) => a.anchorDate - b.anchorDate);

  for (const anchor of anchors) {
    for (const offset of input.reviewOffsets) {
      const target = addDays(anchor.anchorDate, offset);
      if (target > studyDays[studyDays.length - 1]) {
        droppedPastExam += 1;
        continue;
      }
      const unit = {
        kind: 'review',
        subjectIndex: anchor.subject.subjectIndex,
        subjectName: anchor.subject.name,
        topicId: anchor.topic.id,
        topicName: anchor.topic.name,
        difficulty: anchor.topic.difficulty,
        minutes: input.reviewMinutes,
        partIndex: offset,
        partCount: input.reviewOffsets.length,
        weight: 0,
      };

      let placedAt = -1;
      for (let dayIndex = 0; dayIndex < placement.days.length; dayIndex += 1) {
        const day = placement.days[dayIndex];
        if (day.dateObj < target) continue;
        if (day.usedMinutes + unit.minutes + input.breakMinutes > dailyCapacity + 0.5) continue;
        const cap = weekCapFor(unit.subjectIndex, day.week);
        if (cap != null
          && placement.weekMinutes(day.week, unit.subjectIndex) + unit.minutes > cap + 0.5) continue;
        placedAt = dayIndex;
        break;
      }

      if (placedAt === -1) {
        droppedNoRoom += 1;
        continue;
      }
      placement.addReview(placedAt, unit);
      placed += 1;
    }
  }

  return {
    placed,
    dropped: droppedPastExam + droppedNoRoom,
    droppedPastExam,
    droppedNoRoom,
  };
}

module.exports = {
  generatePlan,
  ValidationError,
  DEFAULTS,
  // exported for tests
  _internals: { normaliseInput, splitIntoSessions, buildLearnUnits, allocateBudget, isoWeekKey, isoWeekday },
};