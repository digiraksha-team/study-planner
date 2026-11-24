import { h, button } from '../lib/dom.js';
import { store, navigate, showError, handleAuthFailure, materialUrl } from '../app.js';
import { askAiFab } from './ai.js';
import { openViewer, formatBytes, typeBadge } from '../lib/viewer.js';
import {
  formatDate, formatDateLong, formatDuration, formatHours, formatClock,
  difficultyLabel, subjectColor,
} from '../lib/format.js';

function statTile(label, value, sub) {
  return h('div', { class: 'stat-tile' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value),
    sub ? h('span', { class: 'stat-sub' }, sub) : null,
  );
}

function sessionRow(session, completed, onToggle) {
  const isReview = session.kind === 'review';
  const color = subjectColor(session.subjectIndex);

  return h('li', { class: `session ${isReview ? 'session-review' : ''} ${completed ? 'is-done' : ''}` },
    h('input', {
      type: 'checkbox',
      checked: completed,
      'aria-label': `Mark ${session.topicName} done`,
      onChange: (e) => onToggle(session.id, e.target.checked, e.target.closest('.session')),
    }),
    h('span', { class: 'session-time' }, formatClock(session.startTime)),
    h('span', { class: 'session-length' }, formatDuration(session.minutes)),
    h('span', { class: 'session-dot', style: { background: color } }),
    h('span', { class: 'session-body' },
      h('span', { class: 'session-topic' }, session.topicName),
      h('span', { class: 'session-subject' },
        session.subjectName,
        !isReview && session.partCount > 1
          ? ` · session ${session.partIndex + 1} of ${session.partCount}`
          : '',
      ),
    ),
    h('span', { class: `tag ${isReview ? 'tag-review' : 'tag-learn'}` },
      isReview ? 'review' : difficultyLabel(session.difficulty)),
  );
}

function dayBlock(day, progressSet, onToggle, today, onAttach, materialsByTopic) {
  const minutes = day.sessions.reduce((a, s) => a + s.minutes, 0);
  const isToday = day.date === today;

  const badge = h('span', { class: 'badge badge-muted' });

  function refreshBadge() {
    const done = day.sessions.filter((s) => progressSet.has(s.id)).length;
    const finished = day.sessions.length > 0 && done === day.sessions.length;
    badge.textContent = finished ? 'Done' : `${done}/${day.sessions.length}`;
    badge.className = `badge ${finished ? 'badge-ok' : 'badge-muted'}`;
  }
  refreshBadge();

  const toggle = (sessionId, completed, row) => {
    onToggle(sessionId, completed, row);
    refreshBadge();
  };

  // Group this day's files by topic so each session shows what to read.
  const seenTopics = new Map();
  for (const s of day.sessions) {
    const files = (materialsByTopic[s.topicId] || []);
    if (!files.length) continue;
    const key = `${s.subjectIndex}:${s.topicId}`;
    if (!seenTopics.has(key)) seenTopics.set(key, files);
  }

  const attachRow = h('div', { class: 'attach-row' },
    h('span', { class: 'attach-hint' }, 'Study material'),
    h('div', { class: 'attach-chips' },
      ...[...seenTopics.entries()].map(([key, files]) => {
        const [, topicId] = key.split(':');
        const first = day.sessions.find((s) => s.topicId === topicId);
        const extra = files.length - 1;
        return h('button', {
          type: 'button',
          class: `attach-chip ${files.length > 1 ? 'has-more' : ''}`,
          title: files.map((f) => f.name).join('\n'),
          onClick: () => onAttach(first, files[0]),
        }, typeBadge(files[0]), h('span', { class: 'attach-name' }, files[0].name),
          extra > 0 ? h('span', { class: 'attach-more' }, `+${extra}`) : null);
      }),
    ),
    button('Attach', () => {
      const firstSession = day.sessions.find((s) => s.kind === 'learn') || day.sessions[0];
      if (firstSession) onAttach(firstSession, null);
    }, { class: 'btn btn-ghost btn-small' }),
  );

  return h('section', { class: `day ${isToday ? 'day-today' : ''}` },
    h('header', { class: 'day-head' },
      h('div', null,
        h('h3', { class: 'day-date' }, formatDate(day.date)),
        h('span', { class: 'day-meta' },
          `${formatDuration(minutes)} planned`,
          day.isLearningDay ? '' : ' · revision only',
        ),
      ),
      badge,
    ),
    h('ul', { class: 'session-list' },
      ...day.sessions.map((s) => sessionRow(s, progressSet.has(s.id), toggle)),
    ),
    attachRow,
  );
}

function weeklyChart(weekly) {
  if (!weekly.length) return null;
  const max = Math.max(...weekly.map((w) => w.minutes));
  return h('div', { class: 'weekly' },
    ...weekly.map((w) => h('div', { class: 'weekly-col', title: `${w.week}: ${formatHours(w.minutes)}` },
      h('div', { class: 'weekly-bar-wrap' },
        h('div', { class: 'weekly-bar', style: { height: `${(w.minutes / max) * 100}%` } }),
      ),
      h('span', { class: 'weekly-label' }, w.week.replace(/^\d{4}-/, '')),
      h('span', { class: 'weekly-value' }, formatHours(w.minutes)),
    )),
  );
}

function toMarkdown(plan, saved) {
  const lines = [];
  lines.push(`# ${saved.title}`);
  lines.push('');
  lines.push(`Exam: ${formatDateLong(plan.range.examDate)} · ${plan.range.daysUntilExam} days`);
  lines.push('');
  lines.push(`Total: ${formatHours(plan.stats.totalMinutes)} across ${plan.stats.totalSessions} sessions`);
  lines.push('');
  lines.push('## Subject split');
  for (const s of plan.subjects) {
    lines.push(`- **${s.name}** — ${formatHours(s.minutes)} (${s.percent}%), ${s.sessionCount} sessions`);
  }
  lines.push('');
  lines.push('## Schedule');
  for (const day of plan.days) {
    if (!day.sessions.length) continue;
    lines.push('');
    lines.push(`### ${formatDateLong(day.date)}${day.isLearningDay ? '' : ' (revision only)'}`);
    for (const s of day.sessions) {
      const kind = s.kind === 'review' ? 'review' : 'learn';
      lines.push(`- ${s.startTime} — ${formatDuration(s.minutes)} — ${s.subjectName}: ${s.topicName} _(${kind})_`);
    }
  }
  return lines.join('\n');
}

function materialRow(material, onOpen, onRemove) {
  const open = () => onOpen(material);

  return h('li', { class: `material ${material.view ? 'is-viewable' : ''}` },
    h('button', {
      type: 'button', class: 'material-main', onClick: open, title: 'Open',
    },
    typeBadge(material),
    h('span', { class: 'material-text' },
      h('span', { class: 'material-name' }, material.name),
      h('span', { class: 'material-meta' },
        `${formatBytes(material.sizeBytes)} · ${material.topicName}`
        + (material.subjectName ? ` · ${material.subjectName}` : '')),
    ),
    ),
    h('button', {
      type: 'button',
      class: 'material-remove',
      title: 'Remove material',
      // Wrap it: passing onRemove directly would hand it the click event.
      onClick: () => onRemove(material),
    }, '×'),
  );
}

function libraryCard(materials, onOpen, onRemove) {
  return h('section', { class: 'card' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'card-title' }, 'Study material'),
      h('span', { class: 'chip-inline' }, `${materials.length} file${materials.length === 1 ? '' : 's'}`),
    ),
    materials.length
      ? h('ul', { class: 'material-list' },
        ...materials.map((m) => materialRow(m, onOpen, onRemove)))
      : h('p', { class: 'hint' },
        'No material attached yet. Use the Attach button on a session '
        + 'to add notes, slides or past papers.'),
  );
}

export function renderPlan({ id, navigate: go }) {
  const slot = h('div', { class: 'page' });

  const load = async () => {
    try {
      const saved = await window.api.plans.get(store.token, id);
      if (!saved) {
        go('dashboard');
        return;
      }
      let materials = [];
      try {
        const result = await window.api.materials.list(store.token, id);
        materials = Object.values(result.byTopic).flat();
      } catch (err) {
        // Older databases may not have the table yet; material is optional.
        if (!handleAuthFailure(err)) console.warn('material list failed', err);
      }
      renderPlanPage(saved, materials);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
    }
  };

  function renderPlanPage(saved, materials) {
    const plan = saved.plan;
    const materialsByTopic = new Map();
    for (const material of materials) {
      if (!materialsByTopic.has(material.topicId)) materialsByTopic.set(material.topicId, []);
      materialsByTopic.get(material.topicId).push(material);
    }
    const byTopic = Object.fromEntries(materialsByTopic);
    const progressSet = new Set(saved.progress.map((p) => p.sessionId));
    const total = plan.stats.totalSessions || 1;
    const done = saved.progress.length;
    const percent = Math.min(100, Math.round((done / total) * 100));
    const today = new Date().toISOString().slice(0, 10);

    const onToggle = async (sessionId, completed, row) => {
      if (completed) progressSet.add(sessionId);
      else progressSet.delete(sessionId);
      if (row) row.classList.toggle('is-done', completed);
      try {
        const updated = await window.api.plans.setProgress(store.token, saved.id, sessionId, completed);
        const nowDone = updated.length;
        const nowPercent = Math.min(100, Math.round((nowDone / total) * 100));
        progressFill.style.width = `${nowPercent}%`;
        progressLabel.textContent = `${nowDone}/${total} · ${nowPercent}%`;
      } catch (err) {
        if (!handleAuthFailure(err)) showError(err.message);
      }
    };

    const progressFill = h('div', { class: 'progress-fill', style: { width: `${percent}%` } });
    const progressLabel = h('span', null, `${done}/${total} · ${percent}%`);

    const header = h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'title-row' },
          button('← All plans', () => go('dashboard'), { class: 'btn btn-ghost btn-small' }),
          h('h1', { class: 'page-title' }, saved.title),
        ),
        h('p', { class: 'page-sub' },
          `Exam ${formatDateLong(plan.range.examDate)} · ${plan.range.daysUntilExam} days · `
          + `${plan.range.studyDays} study days`
          + (plan.range.reserveDays ? ` · ${plan.range.reserveDays} reserved for revision` : '')),
      ),
      h('div', { class: 'head-actions' },
        button('Questions', () => go('quiz', { id: saved.id }), { class: 'btn btn-ghost' }),
        button('Edit & regenerate', () => go('planner', { id: saved.id }), { class: 'btn btn-ghost' }),
        button('Export .md', () => exportMarkdown(plan, saved), { class: 'btn btn-ghost' }),
        button('Delete', async () => {
          const ok = window.confirm(`Delete "${saved.title}"? This cannot be undone.`);
          if (!ok) return;
          try {
            await window.api.plans.remove(store.token, saved.id);
            go('dashboard');
          } catch (err) {
            if (!handleAuthFailure(err)) showError(err.message);
          }
        }, { class: 'btn btn-ghost btn-danger' }),
      ),
    );

    const stats = h('section', { class: 'card stats' },
      statTile('Total study time', formatHours(plan.stats.totalMinutes),
        `${plan.stats.learnSessions} learning + ${plan.stats.reviewSessions} review`),
      statTile('Sessions', String(plan.stats.totalSessions),
        `avg ${formatDuration(plan.stats.avgSessionMinutes)}`),
      statTile('Capacity used', `${plan.stats.capacityUsedPercent}%`,
        `${formatHours(plan.stats.capacityMinutes)} available`),
      statTile('Topics covered', String(plan.stats.topicCount),
        `${plan.subjects.length} subjects`),
    );

    const progress = h('section', { class: 'card progress-card' },
      h('div', { class: 'progress-label' },
        h('span', null, 'Your progress'),
        progressLabel,
      ),
      h('div', { class: 'progress-track' }, progressFill),
    );

    const warnings = h('section', { class: 'card warnings' },
      h('h2', { class: 'card-title' }, 'How this plan fits your time'),
      h('ul', { class: 'warning-list' },
        ...plan.warnings.map((w) => h('li', null, w)),
      ),
    );

    const subjects = h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Where the time goes'),
      ...plan.subjects.map((s) => h('div', { class: 'subject-bar-row' },
        h('span', { class: 'subject-bar-name' },
          h('span', { class: 'subject-dot', style: { background: subjectColor(s.subjectIndex) } }),
          s.name,
        ),
        h('div', { class: 'subject-bar-track' },
          h('div', {
            class: 'subject-bar-fill',
            style: { width: `${s.percent}%`, background: subjectColor(s.subjectIndex) },
          }),
        ),
        h('span', { class: 'subject-bar-value' },
          `${formatHours(s.minutes)} · ${s.percent}% · ${s.sessionCount} sessions`),
      )),
    );

    const chart = weeklyChart(plan.weeklyTotals);
    const weekly = chart ? h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Weekly load'),
      chart,
    ) : null;

    const openMaterial = (material) => {
      if (!material) return;
      openViewer(material, materialUrl(material.id));
    };

    const removeMaterial = async (material) => {
      const ok = window.confirm(`Remove "${material.name}"? The file will be deleted from StudyFlow.`);
      if (!ok) return;
      try {
        await window.api.materials.remove(store.token, material.id);
        await load();
      } catch (err) {
        if (!handleAuthFailure(err)) showError(err.message);
      }
    };

    const attachTo = async (session) => {
      if (!session) return;
      try {
        const result = await window.api.materials.attach(store.token, saved.id, {
          topicId: session.topicId,
          topicName: session.topicName,
          subjectIndex: session.subjectIndex,
          subjectName: session.subjectName,
        });
        if (!result.added.length) {
          if (result.rejected.length) showError(result.rejected[0].reason);
          return;
        }
        if (result.rejected.length) {
          showError(`Attached ${result.added.length} file(s). Skipped: ${
            result.rejected.map((r) => `${r.name} — ${r.reason}`).join('; ')}`);
        }
        await load();
      } catch (err) {
        if (!handleAuthFailure(err)) showError(err.message);
      }
    };

    const activeDays = plan.days.filter((d) => d.sessions.length);
    const schedule = h('section', { class: 'schedule' },
      h('h2', { class: 'card-title' }, 'Day-by-day schedule'),
      ...activeDays.map((d) => dayBlock(
        d, progressSet, onToggle, today, attachTo, byTopic,
      )),
    );

    // replaceChildren() would stringify a null, so drop empty slots.
    slot.replaceChildren(...[
      header, stats, progress, warnings, subjects, weekly,
      libraryCard(materials, openMaterial, removeMaterial),
      schedule,
      // Floating tutor, always available while a plan is open.
      askAiFab(saved.id),
    ].filter(Boolean));
  }

  function exportMarkdown(plan, saved) {
    const text = toMarkdown(plan, saved);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${saved.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  load();
  return slot;
}