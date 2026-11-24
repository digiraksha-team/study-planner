/**
 * End-to-end smoke test.
 *
 * Boots the real Electron app against a throwaway database, drives the UI the
 * way a user would (sign up -> build a plan -> read the schedule), captures
 * screenshots, and fails on any renderer error or unhandled rejection.
 *
 * Run with: npm run smoke
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '.smoke');
const USER_DATA = path.join(os.tmpdir(), `studyflow-smoke-${Date.now()}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
// main.js pins userData itself; redirect it so the test never touches the
// real user's accounts and plans.
process.env.STUDYFLOW_DATA_DIR = USER_DATA;

require('../electron/main.js');

const problems = [];
const consoleErrors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function watchWindow(win) {
  win.webContents.on('console-message', (...args) => {
    // Signature changed across Electron versions; the message is always last
    // before the source location, so find the first string argument.
    const message = args.map((a) => (typeof a === 'string' ? a : '')).filter(Boolean)[0] || '';
    const level = typeof args[1] === 'number' ? args[1] : 0;
    // Chromium noise and PDF.js's own recovery diagnostics are not app errors.
    // The PDF fixture is hand-built without an xref table, so PDF.js logs that
    // it is rebuilding the index; a real exported PDF never does.
    const IGNORED = /Autofill|DevTools|Indexing all PDF objects/;
    if (level >= 2 && !IGNORED.test(message)) {
      consoleErrors.push(message);
    }
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    problems.push(`preload error in ${file}: ${err.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`renderer gone: ${details.reason}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    problems.push(`did-fail-load ${code}: ${desc}`);
  });
}

async function waitFor(getWindow, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const win = getWindow();
    if (win && !win.webContents.isLoading()) return win;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for window: ${label}`);
}

/** Poll an expression in the renderer until it returns truthy. */
async function waitUntil(win, expression, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await win.webContents.executeJavaScript(`(() => { ${expression} })()`);
      if (last) return last;
    } catch (err) {
      last = `error: ${err.message}`;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

async function shot(win, name, scrollTo) {
  if (scrollTo) {
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({ block: 'start' }); true;`,
    );
    await sleep(250);
  }
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`  captured ${path.relative(process.cwd(), file)}`);
}

/** Reload and genuinely wait for the new document, not just for a lull. */
function reloadAndWait(win) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reload timed out')), 15000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    win.reload();
  });
}

/** Each helper is its own scope so several can share one executeJavaScript block. */
const setValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})();`;

app.whenReady().then(async () => {
  const main = require('../electron/main.js');
  let exitCode = 0;

  try {
    console.log('\nStudyFlow smoke test\n');

    // --- boot -------------------------------------------------------------
    const win = await waitFor(main.getWindow, 'main window');
    watchWindow(win);
    await waitUntil(win, 'return !!document.querySelector(".auth-card")', 'auth screen');
    console.log('  PASS  app boots to the sign-in screen');
    await shot(win, '1-auth');

    // --- sign up ---------------------------------------------------------
    await win.webContents.executeJavaScript(`
      ${setValue('input[name="name"]', 'Smoke Tester')}
      ${setValue('input[name="email"]', 'smoke@example.com')}
      ${setValue('input[name="password"]', 'testing12345')}
      document.querySelector('.tab:nth-child(2)').click();
    `);
    await sleep(200);
    await win.webContents.executeJavaScript(`
      ${setValue('input[name="name"]', 'Smoke Tester')}
      ${setValue('input[name="email"]', 'smoke@example.com')}
      ${setValue('input[name="password"]', 'testing12345')}
      document.querySelector('.auth-form').requestSubmit();
    `);
    await waitUntil(win, 'return !!document.querySelector(".plan-list")', 'dashboard');
    console.log('  PASS  sign up creates an account and reaches the dashboard');
    await shot(win, '2-dashboard-empty');

    // --- open the planner ------------------------------------------------
    await win.webContents.executeJavaScript(
      `document.querySelector('.empty .btn').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".planner-form")', 'planner form');
    console.log('  PASS  planner form opens');

    // --- fill the form ---------------------------------------------------
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const exam = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    await win.webContents.executeJavaScript(`
      ${setValue('.page-narrow input[type="text"]', 'Smoke semester')}
      ${setValue('input[type="date"]', start)}
      const dates = document.querySelectorAll('input[type="date"]');
      dates[1].value = ${JSON.stringify(exam)};
      dates[1].dispatchEvent(new Event('input', { bubbles: true }));

      const subject = document.querySelector('.subject-card');
      subject.querySelector('.subject-name').value = 'Mathematics';
      subject.querySelector('.subject-name').dispatchEvent(new Event('input', { bubbles: true }));

      const topic = subject.querySelector('.topic-row input[type="text"]');
      topic.value = 'Algebra';
      topic.dispatchEvent(new Event('input', { bubbles: true }));

      subject.querySelector('.topics-head .btn').click();
      const rows = document.querySelectorAll('.subject-card .topic-row');
      rows[1].querySelector('input[type="text"]').value = 'Calculus';
      rows[1].querySelector('input[type="text"]').dispatchEvent(new Event('input', { bubbles: true }));

      document.querySelectorAll('.section-head .btn')[0].click();
      const s2 = document.querySelectorAll('.subject-card')[1];
      s2.querySelector('.subject-name').value = 'History';
      s2.querySelector('.subject-name').dispatchEvent(new Event('input', { bubbles: true }));
      const t2 = s2.querySelector('.topic-row input[type="text"]');
      t2.value = 'Revolutions';
      t2.dispatchEvent(new Event('input', { bubbles: true }));
      true;
    `);

    const estimate = await waitUntil(
      win,
      'const e = document.querySelector(".estimate-line"); return e ? e.textContent : null;',
      'live estimate',
    );
    console.log(`  PASS  live estimate renders: ${estimate.replace(/\s+/g, ' ').trim()}`);

    const verdict = await win.webContents.executeJavaScript(
      `(() => { const v = document.querySelector(".estimate-verdict");
        return v && v.textContent.trim() ? v.textContent.trim() : null; })()`,
    );
    if (!verdict) throw new Error('estimate verdict line is missing');
    console.log(`  PASS  estimate verdict renders: ${verdict}`);
    await shot(win, '3-planner');

    // --- generate --------------------------------------------------------
    await win.webContents.executeJavaScript(
      `document.querySelector('.planner-form').requestSubmit(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".schedule")', 'plan detail');
    console.log('  PASS  plan generated and day-by-day schedule rendered');

    const summary = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('.page-title').textContent,
      stats: [...document.querySelectorAll('.stat-tile')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()),
      days: document.querySelectorAll('.day').length,
      sessions: document.querySelectorAll('.session').length,
      warnings: [...document.querySelectorAll('.warning-list li')].map(li => li.textContent),
    }))()`);
    console.log(`  PASS  plan "${summary.title}" has ${summary.days} days / ${summary.sessions} sessions`);
    await shot(win, '4-plan');
    await shot(win, '4b-schedule', '.schedule');
    await shot(win, '4c-weekly', '.weekly');

    // --- progress toggle -------------------------------------------------
    const before = await win.webContents.executeJavaScript(
      `(() => document.querySelectorAll(".session.is-done").length)()`,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.session input[type="checkbox"]').click(); true;`,
    );
    await waitUntil(
      win,
      `return document.querySelectorAll(".session.is-done").length > ${before};`,
      'progress tick',
    );
    console.log('  PASS  ticking a session updates progress');

    // --- reload persistence ----------------------------------------------
    await reloadAndWait(win);
    await waitUntil(win, 'return !!document.querySelector(".schedule")', 'plan after reload');
    const persisted = await win.webContents.executeJavaScript(
      `(() => document.querySelectorAll(".session.is-done").length)()`,
    );
    if (persisted < 1) throw new Error('progress did not survive a reload');
    console.log('  PASS  progress survives a reload, and the plan view is restored');
    await shot(win, '5-plan-progress');

    // --- study material ----------------------------------------------------
    const fixtures = path.join(OUT_DIR, 'fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const pngPath = path.join(fixtures, 'diagram.png');
    // Known-good 1x1 PNG.
    fs.writeFileSync(pngPath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    const txtPath = path.join(fixtures, 'notes.txt');
    fs.writeFileSync(txtPath, 'revision notes for branching');

    // Minimal two-page PDF, built by hand so the fixture has no binary blob.
    const pdfPath = path.join(fixtures, 'formulae.pdf');
    const page = (n) => `BT /F1 16 Tf 24 100 Td (Page ${n}) Tj ET\n`;
    const objects = [
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
      '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]'
        + '/Resources<</Font<</F1 5 0 R>>>>/Contents 6 0 R>>endobj\n',
      '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]'
        + '/Resources<</Font<</F1 5 0 R>>>>/Contents 7 0 R>>endobj\n',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
      `6 0 obj<</Length ${page(1).length}>>stream\n${page(1)}endstream endobj\n`,
      `7 0 obj<</Length ${page(2).length}>>stream\n${page(2)}endstream endobj\n`,
    ].join('');
    fs.writeFileSync(pdfPath, Buffer.from(
      '%PDF-1.4\n' + objects + 'trailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    ));

    // The attach flow opens a native dialog, so stub it at the main-process
    // level for the duration of the test.
    const dialog = require('electron').dialog;
    let nextFiles = [];
    dialog.showOpenDialog = async () => ({ canceled: nextFiles.length === 0, filePaths: nextFiles });

    nextFiles = [pngPath];
    await win.webContents.executeJavaScript(
      `document.querySelector('.attach-row .btn').click(); true;`,
    );
    await waitUntil(win, 'return document.querySelectorAll(".material").length === 1', 'material listed');
    console.log('  PASS  attaching a file adds it to the plan');

    nextFiles = [txtPath, pdfPath];
    await win.webContents.executeJavaScript(
      `document.querySelector('.attach-row .btn').click(); true;`,
    );
    await waitUntil(win, 'return document.querySelectorAll(".material").length === 3', 'third material');
    console.log('  PASS  more files attach alongside the first (multi-select)');

    await shot(win, '7-material', '.schedule');

    // Built-in PDF viewer.
    await win.webContents.executeJavaScript(
      `(() => { const rows = [...document.querySelectorAll('.material')];
        const pdf = rows.find(r => r.querySelector('.filetype-pdf'));
        pdf.querySelector('.material-main').click(); return true; })()`,
    );
    await waitUntil(
      win,
      'const l = document.querySelector(".viewer-page"); return /^Page \\d+ of \\d+$/.test(l.textContent);',
      'pdf rendered',
      25000,
    ).catch(async () => {
      const why = await win.webContents.executeJavaScript(`(() => ({
        status: document.querySelector('.viewer-status')?.textContent,
        page: document.querySelector('.viewer-page')?.textContent,
        canvas: (() => { const c = document.querySelector('.viewer-canvas');
          return c ? c.width + 'x' + c.height : null; })(),
      }))()`);
      throw new Error(`PDF viewer never finished: ${JSON.stringify(why)}`);
    });
    const pdfState = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.viewer-canvas');
      const bar = document.querySelectorAll('.viewer-pdf-bar .btn');
      return { w: c.width, h: c.height, page: document.querySelector('.viewer-page').textContent,
               prev: bar[0].disabled, next: bar[1].disabled };
    })()`);
    if (pdfState.page !== 'Page 1 of 2') {
      throw new Error(`expected page 1 of 2, got "${pdfState.page}"`);
    }
    if (!pdfState.prev || pdfState.next) {
      throw new Error(`on page 1 of 2 prev should be disabled and next enabled `
        + `(prev=${pdfState.prev}, next=${pdfState.next})`);
    }
    console.log(`  PASS  PDF renders in the built-in viewer (${pdfState.w}x${pdfState.h}, ${pdfState.page})`);

    // Page navigation.
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.viewer-pdf-bar .btn')[1].click(); true;`,
    );
    await waitUntil(
      win,
      'return document.querySelector(".viewer-page").textContent === "Page 2 of 2";',
      'pdf page 2',
      15000,
    );
    const lastPage = await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelectorAll('.viewer-pdf-bar .btn');
      return { prev: bar[0].disabled, next: bar[1].disabled,
               page: document.querySelector('.viewer-page').textContent };
    })()`);
    if (lastPage.prev || !lastPage.next) throw new Error('navigation buttons wrong on the last page');
    console.log('  PASS  PDF page navigation works and disables at both ends');
    await shot(win, '8b-viewer-pdf');

    await win.webContents.executeJavaScript(
      `document.querySelector(".viewer-close").click(); true;`,
    );
    await waitUntil(win, 'return !document.querySelector(".viewer-overlay")', 'viewer closed');

    // Non-previewable file: the viewer should offer to open it externally.
    await win.webContents.executeJavaScript(
      `(() => { const rows = [...document.querySelectorAll('.material')];
        const txt = rows.find(r => !r.classList.contains('is-viewable'));
        txt.querySelector('.material-main').click(); return true; })()`,
    );
    await waitUntil(win, 'return !!document.querySelector(".viewer-empty")', 'unsupported viewer');
    console.log('  PASS  a .txt file shows the "open externally" fallback');
    await win.webContents.executeJavaScript(`document.querySelector(".viewer-close").click(); true;`);
    await waitUntil(win, 'return !document.querySelector(".viewer-overlay")', 'viewer closed');

    // Built-in image viewer.
    await win.webContents.executeJavaScript(
      `document.querySelector('.material.is-viewable .material-main').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".viewer-overlay .viewer-image")', 'image viewer');
    const imgState = await win.webContents.executeJavaScript(`
      (async () => {
        const i = document.querySelector('.viewer-image');
        const src = i ? i.src : '(no img)';
        let status = 'n/a';
        if (src !== '(no img)') {
          try { status = (await fetch(src)).status; } catch (e) { status = 'fetch-failed:' + e.message; }
        }
        return { src, status, complete: i ? i.complete : null, w: i ? i.naturalWidth : null, h: i ? i.naturalHeight : null };
      })()
    `);
    if (imgState.w !== 1) {
      throw new Error(
        `image viewer did not load: naturalWidth=${imgState.w} fetch=${imgState.status} src=${imgState.src}`,
      );
    }
    console.log(`  PASS  image opens in the built-in viewer (fetch ${imgState.status})`);
    await shot(win, '8-viewer-image');

    await win.webContents.executeJavaScript(
      `document.querySelector(".viewer-close").click(); true;`,
    );
    await waitUntil(win, 'return !document.querySelector(".viewer-overlay")', 'viewer closed');

    // The material URL must refuse an access without the capability token.
    const forbidden = await win.webContents.executeJavaScript(`
      (async () => {
        try { return (await fetch('material://f/1')).status; }
        catch (e) { return 'network-error:' + e.message; }
      })()
    `);
    if (forbidden !== 403) throw new Error(`expected material:// to refuse unauthorised reads, got ${forbidden}`);
    console.log('  PASS  material:// refuses reads without the session key');

    // Removing a file. Auto-confirm the delete first, then click.
    await win.webContents.executeJavaScript('window.confirm = () => true; true;');
    await win.webContents.executeJavaScript(
      `document.querySelector('.material-remove').click(); true;`,
    );
    await sleep(600);
    const removeState = await win.webContents.executeJavaScript(`(() => ({
      count: document.querySelectorAll('.material').length,
      banner: document.getElementById('banner').hidden
        ? null
        : document.getElementById('banner').textContent.trim(),
      confirmStubbed: window.confirm.toString().includes('true'),
    }))()`);
    if (removeState.count !== 2) {
      throw new Error(
        `remove did not take effect: count=${removeState.count} `
        + `banner=${JSON.stringify(removeState.banner)} confirmStubbed=${removeState.confirmStubbed}`,
      );
    }
    console.log(`  PASS  removing material clears it from the plan (count ${removeState.count})`);

    // Remove the rest.
    for (let i = 0; i < 2; i += 1) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.material-remove').click(); true;`,
      );
      // eslint-disable-next-line no-await-in-loop
      await waitUntil(
        win,
        `return document.querySelectorAll('.material').length === ${2 - i - 1};`,
        `materials reduced to ${2 - i - 1}`,
      );
    }
    console.log('  PASS  every attached file can be removed');
    console.log('  PASS  second removal empties the list');
    await waitUntil(win, 'return document.querySelectorAll(".material").length === 0', 'materials removed');

    // --- questions & practice --------------------------------------------
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.head-actions .btn')]
         .find(b => b.textContent.trim() === 'Questions').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".quiz-controls")', 'question library');
    console.log('  PASS  questions page opens from the plan');

    // Create a question through the form.
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.quiz-controls .btn')]
         .find(b => b.textContent.trim() === 'Add question').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".question-form")', 'question form');

    await win.webContents.executeJavaScript(`
      (() => {
        const set = (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const form = document.querySelector('.question-form');
        const inputs = form.querySelectorAll('.option-row input[type="text"]');
        set(form.querySelector('input[type="text"]'), 'Which operator is the modulo?');
        set(inputs[0], 'The % operator');
        set(inputs[1], 'The / operator');
        set(inputs[2], 'The ^ operator');
        set(inputs[3], 'The * operator');
        return true;
      })()
    `);
    await shot(win, '9-question-form');
    await win.webContents.executeJavaScript(
      `document.querySelector('.question-form .btn-primary').click(); true;`,
    );
    await waitUntil(win, 'return document.querySelectorAll(".question-row").length === 1', 'question saved');
    console.log('  PASS  a multiple-choice question can be written and saved');

    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.quiz-controls .btn')]
         .find(b => b.textContent.trim() === 'Add question').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".question-form")', 'question form 2');
    await win.webContents.executeJavaScript(`
      (() => {
        const set = (el, v) => {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const form = document.querySelector('.question-form');
        const inputs = form.querySelectorAll('.option-row input[type="text"]');
        set(form.querySelector('input[type="text"]'), 'Which is a primitive type?');
        set(inputs[0], 'A wrong answer');
        set(inputs[1], 'int');
        set(inputs[2], 'Another wrong answer');
        set(inputs[3], 'A third wrong answer');
        // Mark the second option correct.
        const radios = form.querySelectorAll('.option-row input[type="radio"]');
        radios[1].click();
        return true;
      })()
    `);
    await win.webContents.executeJavaScript(
      `document.querySelector('.question-form .btn-primary').click(); true;`,
    );
    await waitUntil(win, 'return document.querySelectorAll(".question-row").length === 2', 'second question saved');
    console.log('  PASS  the correct answer can be chosen freely');

    const stats = await win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('.quiz-stats .stat-tile')]
        .map(t => t.textContent.replace(/\\s+/g, ' ').trim()).join(' | '))()`,
    );
    console.log(`  PASS  library stats render: ${stats}`);

    // --- take the quiz -------------------------------------------------
    await win.webContents.executeJavaScript(
      `document.querySelector('.quiz-controls .btn-primary').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".quiz-option")', 'quiz card');
    await shot(win, '10-quiz-question');

    // Answer the first question.
    await win.webContents.executeJavaScript(
      `document.querySelector('.quiz-option').click(); true;`,
    );

    await waitUntil(win, 'return !!document.querySelector(".quiz-feedback:not([hidden])")', 'quiz feedback');
    const quizVerdict = await win.webContents.executeJavaScript(`(() => ({
      text: document.querySelector('.quiz-result').textContent.replace(/\\s+/g, ' ').trim(),
      marked: document.querySelectorAll('.quiz-option.is-correct').length,
      wrong: document.querySelectorAll('.quiz-option.is-wrong').length,
      disabled: [...document.querySelectorAll('.quiz-option')].every(b => b.disabled),
    }))()`);
    if (quizVerdict.marked !== 1) throw new Error('exactly one option must be marked correct');
    if (!quizVerdict.disabled) throw new Error('options must lock after answering');
    if (quizVerdict.marked + quizVerdict.wrong > 1) {
      throw new Error('a wrong pick and the right pick should both be highlighted');
    }
    console.log(`  PASS  answering shows feedback: "${quizVerdict.text}"`);
    await shot(win, '11-quiz-answered');

    // Next question, then finish the session.
    await win.webContents.executeJavaScript(
      `document.querySelector('.quiz-actions .btn-primary').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".quiz-option")', 'second quiz card');
    console.log('  PASS  next question advances the session');

    await win.webContents.executeJavaScript(
      `document.querySelector('.quiz-option').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".quiz-feedback:not([hidden])")', 'second feedback');
    await win.webContents.executeJavaScript(
      `document.querySelector('.quiz-actions .btn-primary').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".quiz-controls")', 'back to library after session');
    console.log('  PASS  finishing the session returns to the library');

    // --- ask ai ----------------------------------------------------------
    // The floating tutor lives on the plan page, so step back from the quiz.
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.btn')]\n         .find(b => b.textContent.includes('Back to plan')).click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".schedule")', 'back on the plan for ai');
    console.log('  PASS  back on the plan before asking the ai');

    await win.webContents.executeJavaScript(`document.querySelector('.ai-fab').click(); true;`);
    await waitUntil(win, 'return !!document.querySelector(".ai-panel")', 'ai panel');
    console.log('  PASS  the floating ask-ai button opens the tutor panel');
    await shot(win, '12-ai-panel');

    const aiContext = await win.webContents.executeJavaScript(
      `document.querySelector('.ai-context').textContent`,
    );
    if (!aiContext || !aiContext.trim()) throw new Error('the ai panel should show the plan context');

    await waitUntil(win, 'return !document.querySelector(".ai-key").hidden', 'ai key field');
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.ai-key-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'sk-smoke-test-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('.ai-key-row .btn').click(); true;`);
    await waitUntil(win, 'return document.querySelector(".ai-key").hidden', 'ai key saved');
    console.log('  PASS  the ai api key can be saved from the panel');

    await win.webContents.executeJavaScript(`document.querySelector('.ai-close').click(); true;`);
    await waitUntil(win, 'return !document.querySelector(".ai-panel")', 'ai panel closed');
    console.log('  PASS  the ai panel closes');

    // --- navigation ------------------------------------------------------
    await win.webContents.executeJavaScript(
      `document.querySelector('.title-row .btn').click(); true;`,
    );
    await waitUntil(win, 'return document.querySelectorAll(".plan-card").length === 1', 'dashboard card');
    console.log('  PASS  saved plan appears on the dashboard');

    await win.webContents.executeJavaScript(
      `document.querySelector('.plan-card').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".schedule")', 'reopen plan');
    console.log('  PASS  plan reopens from the dashboard');

    await win.webContents.executeJavaScript(
      `document.querySelector('.title-row .btn').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".plan-list")', 'dashboard again');
    await win.webContents.executeJavaScript(
      `document.getElementById('sign-out').click(); true;`,
    );
    await waitUntil(win, 'return !!document.querySelector(".auth-card")', 'sign out');
    console.log('  PASS  sign out returns to the auth screen');
    await shot(win, '6-signed-out');
  } catch (err) {
    problems.push(err.message);
    exitCode = 1;
  }

  if (consoleErrors.length) {
    exitCode = 1;
    console.log(`\n  Renderer console errors (${consoleErrors.length}):`);
    for (const message of [...new Set(consoleErrors)]) console.log(`    - ${message}`);
  }

  if (problems.length) {
    exitCode = 1;
    console.log(`\n  Problems (${problems.length}):`);
    for (const p of problems) console.log(`    - ${p}`);
  }

  console.log(exitCode === 0 ? '\n  Smoke test passed\n' : '\n  Smoke test FAILED\n');

  // Electron still holds GPU cache handles in userData, so clean up after exit
  // and never let a locked file mask the test result.
  app.once('will-quit', () => {
    setTimeout(() => {
      try {
        fs.rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* the OS will reclaim the temp directory */
      }
    }, 500);
  });

  app.exit(exitCode);
});