const path = require('path');
const { generatePlan } = require(path.join(__dirname, '..', 'electron', 'services', 'scheduler.js'));

const input = {
  title: 'Spring Midterms',
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
      { name: 'Calculus', importance: 'core' },
      { name: 'Probability', importance: 'high' } ] },
    { name: 'Physics', difficulty: 'hard', priority: 'vital', topics: [
      { name: 'Kinematics', importance: 'core' },
      { name: 'Thermodynamics', importance: 'high' } ] },
    { name: 'History', difficulty: 'easy', topics: [
      { name: 'Revolutions', importance: 'medium' },
      { name: 'Industrial age', importance: 'low' } ] },
  ],
};

const plan = generatePlan(input);
const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

console.log(`\n${plan.stats.totalHours}h across ${plan.stats.totalSessions} sessions`);
console.log(`  learn ${plan.stats.learnSessions} | review ${plan.stats.reviewSessions}`);
console.log(`  capacity used ${plan.stats.capacityUsedPercent}%\n`);
for (const s of plan.subjects) {
  console.log(`  ${s.name.padEnd(12)} ${String(Math.round(s.minutes / 6) / 10).padStart(5)}h  ${String(s.percent).padStart(2)}%  ${s.sessionCount} sessions`);
}
console.log('\nWEEKLY LOAD');
for (const w of plan.weeklyTotals) {
  console.log(`  ${w.week}  ${String(Math.round(w.minutes / 6) / 10).padStart(5)}h  ${w.sessions} sessions`);
}

console.log('\nFIRST 8 DAYS');
for (const day of plan.days.slice(0, 8)) {
  const label = `${day.date} ${dows[day.weekday - 1]}`;
  console.log(`\n${label}${day.isLearningDay ? '' : '  (review-only)'}`);
  for (const s of day.sessions) {
    const tag = s.kind === 'review' ? 'REVIEW' : `L${s.partIndex + 1}/${s.partCount}  `;
    console.log(`   ${s.startTime}  ${String(s.minutes).padStart(3)}m  ${tag} ${s.subjectName} - ${s.topicName}`);
  }
}

console.log('\nLAST 3 DAYS');
for (const day of plan.days.slice(-3)) {
  console.log(`\n${day.date} ${dows[day.weekday - 1]}${day.isLearningDay ? '' : '  (review-only)'}`);
  for (const s of day.sessions) {
    console.log(`   ${s.startTime}  ${String(s.minutes).padStart(3)}m  ${s.kind === 'review' ? 'REVIEW' : 'LEARN '} ${s.subjectName} - ${s.topicName}`);
  }
}

console.log('\nWARNINGS');
for (const w of plan.warnings) console.log(`  - ${w}`);