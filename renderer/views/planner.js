import { h, field, select, button } from '../lib/dom.js';
import { store, navigate, showError, handleAuthFailure } from '../app.js';
import {
  todayIso, addDaysIso, weekdayName, weekdayShort,
  DIFFICULTY_OPTIONS, PRIORITY_OPTIONS, IMPORTANCE_OPTIONS,
} from '../lib/format.js';

const DIFFICULTY_FACTOR = { easy: 0.75, medium: 1, hard: 1.4, expert: 1.9 };
const IMPORTANCE_FACTOR = { low: 0.8, medium: 1, high: 1.3, core: 1.6 };
const BASE_TOPIC_HOURS = 1.5;

function blankSubject() {
  return {
    name: '',
    difficulty: 'medium',
    priority: 'normal',
    hoursPerWeek: '',
    topics: [{ name: '', importance: 'medium', hours: '' }],
  };
}

function blankState() {
  return {
    title: '',
    startDate: todayIso(),
    examDate: addDaysIso(todayIso(), 28),
    studyDays: [1, 2, 3, 4, 5, 6],
    dailyHours: 3,
    sessionMinutes: 60,
    breakMinutes: 10,
    windowStart: '09:00',
    reserveDays: 2,
    reviews: true,
    subjects: [blankSubject()],
  };
}

/** Mirrors the engine's demand estimate so the form can warn before submitting. */
function estimate(state) {
  let demandHours = 0;
  for (const subject of state.subjects) {
    const df = DIFFICULTY_FACTOR[subject.difficulty] || 1;
    for (const topic of subject.topics) {
      const name = topic.name.trim();
      if (!name) continue;
      const hours = topic.hours !== '' && topic.hours != null
        ? Number(topic.hours)
        : BASE_TOPIC_HOURS * df * (IMPORTANCE_FACTOR[topic.importance] || 1);
      demandHours += Number.isFinite(hours) ? hours : 0;
    }
  }

  const start = new Date(`${state.startDate}T12:00:00`);
  const exam = new Date(`${state.examDate}T12:00:00`);
  let studyDays = 0;
  for (let d = new Date(start); d <= exam; d = new Date(d.getTime() + 86400000)) {
    const weekday = ((d.getDay() + 6) % 7) + 1;
    const daysBeforeExam = Math.round((exam - d) / 86400000);
    if (state.studyDays.includes(weekday) && daysBeforeExam >= 2) studyDays += 1;
  }
  const availableHours = studyDays * state.dailyHours;

  return { demandHours, availableHours, studyDays };
}

export function renderPlanner({ id, navigate: go }) {
  const state = blankState();
  const editingId = id || null;

  const estimateSlot = h('div', { class: 'estimate' });
  const subjectSlot = h('div', { class: 'subject-list' });
  const errorSlot = h('div', { class: 'form-error', hidden: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Generate plan');
  const heading = h('h1', { class: 'page-title' }, 'New study plan');

  function showError(message) {
    errorSlot.textContent = message || '';
    errorSlot.hidden = !message;
  }

  function refreshEstimate() {
    const { demandHours, availableHours, studyDays } = estimate(state);
    estimateSlot.replaceChildren();
    if (!studyDays) {
      estimateSlot.appendChild(h('p', { class: 'estimate-line estimate-warn' },
        'No study days fall between the start date and the exam. Pick more weekdays.'));
      return;
    }
    const ratio = demandHours > 0 ? availableHours / demandHours : Infinity;
    const verdict = ratio >= 1.6 ? ['plenty of slack', 'ok']
      : ratio >= 1 ? ['comfortable fit', 'ok']
        : ratio >= 0.8 ? ['tight - topics will be scaled down', 'warn']
          : ['not enough time - topics will be scaled down a lot', 'bad'];

    // appendChild() only takes one node; append() is the multi-argument one.
    estimateSlot.append(
      h('div', { class: 'estimate-line' },
        h('strong', null, `${Math.round(demandHours * 10) / 10}h of topics`),
        ' vs ',
        h('strong', null, `${Math.round(availableHours * 10) / 10}h available`),
        ` over ${studyDays} study day${studyDays === 1 ? '' : 's'}`,
      ),
      h('p', { class: `estimate-verdict estimate-${verdict[1]}` }, verdict[0]),
    );
  }

  // --- subjects -----------------------------------------------------------
  function renderSubjects() {
    subjectSlot.replaceChildren();
    state.subjects.forEach((subject, si) => {
      subjectSlot.appendChild(subjectCard(subject, si));
    });
    refreshEstimate();
  }

  function subjectCard(subject, si) {
    const topicSlot = h('div', { class: 'topic-list' });

    const renderTopics = () => {
      topicSlot.replaceChildren();
      if (!subject.topics.length) {
        topicSlot.appendChild(h('p', { class: 'hint' }, 'No topics yet.'));
      }
      subject.topics.forEach((topic, ti) => {
        topicSlot.appendChild(topicRow(subject, topic, ti, renderTopics));
      });
    };
    renderTopics();

    return h('section', { class: 'card subject-card' },
      h('header', { class: 'subject-head' },
        h('input', {
          class: 'subject-name',
          type: 'text',
          placeholder: `Subject ${si + 1} name`,
          value: subject.name,
          'aria-label': `Subject ${si + 1} name`,
          onInput: (e) => { subject.name = e.target.value; },
        }),
        button('Remove subject', () => {
          state.subjects.splice(si, 1);
          if (!state.subjects.length) state.subjects.push(blankSubject());
          renderSubjects();
        }, { class: 'btn btn-ghost btn-small btn-danger' }),
      ),
      h('div', { class: 'subject-controls' },
        field('Difficulty', select(DIFFICULTY_OPTIONS, subject.difficulty,
          (v) => { subject.difficulty = v; refreshEstimate(); }, { class: 'select-small' })),
        field('Priority', select(PRIORITY_OPTIONS, subject.priority,
          (v) => { subject.priority = v; }, { class: 'select-small' })),
        field('Hours / week cap', h('input', {
          type: 'number', min: '0', step: '0.5', placeholder: 'Any',
          value: subject.hoursPerWeek,
          onInput: (e) => { subject.hoursPerWeek = e.target.value; },
        }), 'Optional limit for this subject'),
      ),
      h('div', { class: 'topics-head' },
        h('h3', null, 'Topics'),
        button('Add topic', () => {
          subject.topics.push({ name: '', importance: 'medium', hours: '' });
          renderTopics();
          refreshEstimate();
        }, { class: 'btn btn-ghost btn-small' }),
      ),
      topicSlot,
    );
  }

  function topicRow(subject, topic, ti, rerender) {
    return h('div', { class: 'topic-row' },
      h('input', {
        type: 'text', placeholder: 'Topic name', value: topic.name,
        'aria-label': 'Topic name',
        onInput: (e) => { topic.name = e.target.value; refreshEstimate(); },
      }),
      select(IMPORTANCE_OPTIONS, topic.importance,
        (v) => { topic.importance = v; refreshEstimate(); }, { class: 'select-small', 'aria-label': 'Importance' }),
      h('input', {
        type: 'number', min: '0', step: '0.25', placeholder: 'auto', value: topic.hours,
        'aria-label': 'Hours for this topic',
        onInput: (e) => { topic.hours = e.target.value; refreshEstimate(); },
      }),
      button('Remove', () => {
        subject.topics.splice(ti, 1);
        if (!subject.topics.length) subject.topics.push({ name: '', importance: 'medium', hours: '' });
        rerender();
        refreshEstimate();
      }, { class: 'btn btn-ghost btn-small btn-danger', title: 'Remove topic' }),
    );
  }

  // --- top-level fields ---------------------------------------------------
  const titleInput = h('input', {
    type: 'text', placeholder: 'e.g. Spring midterms',
    onInput: (e) => { state.title = e.target.value; },
  });

  const startInput = h('input', {
    type: 'date', value: state.startDate,
    onInput: (e) => { state.startDate = e.target.value; refreshEstimate(); },
  });

  const examInput = h('input', {
    type: 'date', value: state.examDate,
    onInput: (e) => { state.examDate = e.target.value; refreshEstimate(); },
  });

  const dailyInput = h('input', {
    type: 'number', min: '0.5', max: '16', step: '0.5', value: state.dailyHours,
    onInput: (e) => { state.dailyHours = Number(e.target.value) || 0; refreshEstimate(); },
  });

  const sessionInput = h('input', {
    type: 'number', min: '15', max: '240', step: '5', value: state.sessionMinutes,
    onInput: (e) => { state.sessionMinutes = Number(e.target.value) || 60; },
  });

  const breakInput = h('input', {
    type: 'number', min: '0', max: '60', step: '5', value: state.breakMinutes,
    onInput: (e) => { state.breakMinutes = Number(e.target.value) || 0; },
  });

  const startTimeInput = h('input', {
    type: 'time', value: state.windowStart,
    onInput: (e) => { state.windowStart = e.target.value; },
  });

  const reserveInput = h('input', {
    type: 'number', min: '0', max: '21', step: '1', value: state.reserveDays,
    onInput: (e) => { state.reserveDays = Number(e.target.value) || 0; },
  });

  const reviewToggle = h('input', {
    type: 'checkbox', checked: state.reviews,
    onChange: (e) => { state.reviews = e.target.checked; },
  });

  const dayButtons = [1, 2, 3, 4, 5, 6, 7].map((day) => h('button', {
    type: 'button',
    class: `day-toggle ${state.studyDays.includes(day) ? 'is-on' : ''}`,
    title: weekdayName(day),
    onClick: () => {
      const at = state.studyDays.indexOf(day);
      if (at === -1) state.studyDays.push(day);
      else state.studyDays.splice(at, 1);
      state.studyDays.sort();
      button.classList.toggle('is-on');
      refreshEstimate();
    },
  }, weekdayShort(day)));

  const form = h('form', { class: 'planner-form', onSubmit: onSubmit },
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Basics'),
      h('div', { class: 'grid grid-3' },
        field('Plan name', titleInput),
        field('Start date', startInput),
        field('Exam date', examInput),
      ),
    ),

    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Available time'),
      h('div', { class: 'grid grid-3' },
        field('Hours per study day', dailyInput),
        field('Daily start time', startTimeInput),
        field('Review-only days before exam', reserveInput, 'Keeps the last days light for revision'),
      ),
      h('div', { class: 'grid grid-3' },
        field('Session length (minutes)', sessionInput),
        field('Break between sessions', breakInput),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Spaced reviews'),
          h('label', { class: 'switch' }, reviewToggle,
            h('span', null, 'Add 1/3/7/14-day review passes')),
          h('span', { class: 'field-hint' },
            'Review time counts towards each subject weekly cap'),
        ),
      ),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Study days'),
        h('div', { class: 'day-toggles' }, ...dayButtons),
      ),
      estimateSlot,
    ),

    h('section', { class: 'card' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'card-title' }, 'Subjects and topics'),
        button('Add subject', () => {
          state.subjects.push(blankSubject());
          renderSubjects();
        }, { class: 'btn btn-ghost btn-small' }),
      ),
      subjectSlot,
    ),

    errorSlot,
    h('div', { class: 'form-actions' },
      button('Cancel', () => go('dashboard'), { class: 'btn btn-ghost' }),
      submit,
    ),
  );

  async function onSubmit(event) {
    event.preventDefault();
    showError('');
    submit.disabled = true;
    submit.textContent = 'Building plan...';

    try {
      const payload = {
        ...state,
        title: state.title.trim(),
        subjects: state.subjects
          .filter((s) => s.name.trim())
          .map((s) => ({
            ...s,
            topics: s.topics.filter((t) => t.name.trim()),
          }))
          .filter((s) => s.topics.length),
      };
      if (!payload.title) payload.title = `Plan for ${payload.examDate}`;

      const saved = editingId
        ? await window.api.plans.regenerate(store.token, editingId, payload)
        : await window.api.plans.create(store.token, payload);

      go('plan', { id: saved.id });
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
      submit.disabled = false;
      submit.textContent = editingId ? 'Regenerate plan' : 'Generate plan';
    }
  }

  // --- hydrate an existing plan ------------------------------------------
  async function hydrate() {
    if (!editingId) {
      renderSubjects();
      refreshEstimate();
      return;
    }
    try {
      const saved = await window.api.plans.get(store.token, editingId);
      if (!saved) {
        go('dashboard');
        return;
      }
      const input = saved.input;
      Object.assign(state, {
        title: saved.title,
        startDate: input.startDate,
        examDate: input.examDate,
        studyDays: input.studyDays || state.studyDays,
        dailyHours: input.dailyHours,
        sessionMinutes: input.sessionMinutes,
        breakMinutes: input.breakMinutes,
        windowStart: input.windowStart || state.windowStart,
        reserveDays: input.reserveDays,
        reviews: input.reviews !== false,
        subjects: input.subjects.map((s) => ({ ...s, topics: s.topics.map((t) => ({ ...t })) })),
      });

      titleInput.value = state.title;
      startInput.value = state.startDate;
      examInput.value = state.examDate;
      dailyInput.value = state.dailyHours;
      sessionInput.value = state.sessionMinutes;
      breakInput.value = state.breakMinutes;
      startTimeInput.value = state.windowStart;
      reserveInput.value = state.reserveDays;
      reviewToggle.checked = state.reviews;
      state.studyDays.forEach((day) => {
        const index = day - 1;
        if (dayButtons[index]) dayButtons[index].classList.add('is-on');
      });

      heading.textContent = 'Edit plan';
      submit.textContent = 'Regenerate plan';
      renderSubjects();
      refreshEstimate();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
      renderSubjects();
    }
  }

  const page = h('div', { class: 'page page-narrow' },
    h('div', { class: 'page-head' },
      h('div', null,
        heading,
        h('p', { class: 'page-sub' },
          'StudyFlow estimates how long each topic needs, then works backwards from your exam date.'),
      ),
    ),
    form,
  );

  hydrate();
  return page;
}