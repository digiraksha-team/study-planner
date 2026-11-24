import { h, button } from '../lib/dom.js';
import { store, navigate, showError, handleAuthFailure } from '../app.js';
import { formatDate, formatHours, formatDuration } from '../lib/format.js';

function progressOf(plan) {
  const total = plan.stats.totalSessions || 0;
  const done = plan.progress.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

function countdown(examDate) {
  const now = new Date();
  const [y, m, d] = examDate.split('-').map(Number);
  const exam = new Date(y, m - 1, d, 12);
  return Math.round((exam - now) / 86400000);
}

function planCard(plan, onOpen) {
  const progress = progressOf(plan);
  const daysLeft = countdown(plan.examDate);

  const bar = h('div', { class: 'progress-track' },
    h('div', {
      class: 'progress-fill',
      style: { width: `${progress.percent}%` },
    }),
  );

  return h('article', {
    class: 'card plan-card',
    onClick: () => onOpen(plan),
    tabindex: '0',
    onKeydown: (e) => { if (e.key === 'Enter') onOpen(plan); },
  },
  h('header', { class: 'plan-card-head' },
    h('h3', { class: 'plan-card-title' }, plan.title),
    h('span', {
      class: `badge ${daysLeft < 0 ? 'badge-muted' : daysLeft <= 7 ? 'badge-warn' : 'badge-ok'}`,
    }, daysLeft < 0 ? 'Exam passed' : daysLeft === 0 ? 'Exam today' : `${daysLeft}d left`),
  ),
  h('p', { class: 'plan-card-meta' }, `Exam ${formatDate(plan.examDate)} · ${plan.subjectCount} subjects`),
  h('dl', { class: 'stat-row' },
    h('div', null, h('dt', null, 'Planned'), h('dd', null, formatHours(plan.stats.totalMinutes))),
    h('div', null, h('dt', null, 'Sessions'), h('dd', null, String(plan.stats.totalSessions))),
    h('div', null, h('dt', null, 'Study days'), h('dd', null, String(plan.range.studyDays))),
  ),
  h('div', { class: 'progress-block' },
    h('div', { class: 'progress-label' },
      h('span', null, 'Progress'),
      h('span', null, `${progress.done}/${progress.total} · ${progress.percent}%`),
    ),
    bar,
  ),
  );
}

export function renderDashboard({ navigate: go }) {
  const listSlot = h('div', { class: 'plan-list' });
  const greeting = h('h1', { class: 'page-title' }, 'Your study plans');
  const subtitle = h('p', { class: 'page-sub' }, '');

  const open = (plan) => go('plan', { id: plan.id });

  const load = async () => {
    try {
      const plans = await window.api.plans.list(store.token);
      subtitle.textContent = store.user
        ? `Signed in as ${store.user.name}. ${plans.length} plan${plans.length === 1 ? '' : 's'}.`
        : '';

      listSlot.replaceChildren();
      if (!plans.length) {
        listSlot.appendChild(h('div', { class: 'empty' },
          h('h2', null, 'No plans yet'),
          h('p', null, 'Create your first plan and StudyFlow will work backwards from your exam date, '
            + 'splitting every subject into sessions that fit the time you actually have.'),
          button('Create a study plan', () => go('planner'), { class: 'btn btn-primary' }),
        ));
        return;
      }
      for (const plan of plans) listSlot.appendChild(planCard(plan, open));
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
    }
  };

  load();

  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null, greeting, subtitle),
      button('New plan', () => go('planner'), { class: 'btn btn-primary' }),
    ),
    listSlot,
  );
}