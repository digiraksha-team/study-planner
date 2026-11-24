/** Presentation helpers shared by the views. */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayName(isoWeekday) {
  return WEEKDAYS[(isoWeekday - 1 + 7) % 7];
}

export function weekdayShort(isoWeekday) {
  return WEEKDAYS_SHORT[(isoWeekday - 1 + 7) % 7];
}

/** "2026-03-02" -> "Mon 2 Mar" */
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  return `${weekdayShort(((date.getDay() + 6) % 7) + 1)} ${d} ${date.toLocaleString('en', { month: 'short' })}`;
}

export function formatDateLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Minutes -> "1h 30m" */
export function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatHours(minutes) {
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

export function formatClock(time) {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}

export function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days, 12);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', normal: 'Normal', high: 'High', vital: 'Must pass' };
const IMPORTANCE_LABELS = { low: 'Nice to know', medium: 'Standard', high: 'Important', core: 'Core exam' };

export const difficultyLabel = (v) => DIFFICULTY_LABELS[v] || v;
export const priorityLabel = (v) => PRIORITY_LABELS[v] || v;
export const importanceLabel = (v) => IMPORTANCE_LABELS[v] || v;

export const DIFFICULTY_OPTIONS = Object.entries(DIFFICULTY_LABELS).map(([value, label]) => ({ value, label }));
export const PRIORITY_OPTIONS = Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }));
export const IMPORTANCE_OPTIONS = Object.entries(IMPORTANCE_LABELS).map(([value, label]) => ({ value, label }));

/** Deterministic colour per subject index, used for badges and bars. */
export function subjectColor(index) {
  const palette = [
    '#6ea8fe', '#f7a072', '#7ee2b8', '#c792ea', '#ffd479',
    '#ff8fa3', '#5ad1c4', '#9aa8ff', '#e6a3ff', '#b5d99c',
  ];
  return palette[index % palette.length];
}