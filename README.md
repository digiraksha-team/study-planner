# StudyFlow

A desktop study-planning tool. Give it your subjects, topics and exam date, and
it works backwards to build a day-by-day schedule that fits the time you
actually have.

Everything runs locally. There is no AI service, no API key and no network
call — plan generation is a deterministic scheduling algorithm, so the same
input always produces the same plan.

## Features

- **Detailed input form** — subjects with difficulty, priority and an optional
  weekly hour cap; topics with importance and an optional hour estimate.
- **Daily and weekly breakdown** — every session has a date, start time,
  length, subject and topic, grouped into days and summarised by week.
- **Work backwards from the exam** — the exam date and the day before are left
  clear, and the last few days are reserved for revision.
- **Difficulty weighting** — hard and important topics automatically get more
  time than easy, optional ones.
- **Spaced reviews** — optional 1/3/7/14-day review passes after each topic.
- **Study material** — attach PDFs, images and notes to individual topics.
  Images and PDFs open in a built-in viewer (PDFs page through with
  Previous/Next); anything else offers to open in your normal program. Files are
  copied into the app, capped at 100 MB each.
- **Questions & practice** — write multiple-choice questions against any
  topic, then quiz yourself. Wrong answers come back after a day and each
  consecutive correct answer pushes the question further out (1/3/7/14/30/60
  days), so revision happens without you tracking it.
- **Live feasibility estimate** — the form shows topics-vs-available-time while
  you type, so you find out you are short on time before generating.
- **Progress tracking** — tick off sessions; the plan remembers them.
- **Local accounts** — scrypt-hashed passwords, per-user plan isolation.
- **Markdown export** — download any plan as a `.md` file.

## Requirements

- Node.js 20 or newer (developed on Node 24)
- No Rust, no native build tools, no database server

## Getting started

```bash
npm install
npm start
```

> If `npm install` warns that Electron's install script was skipped, run
> `node node_modules/electron/install.js` once to download the binary.

## Tests

```bash
npm test              # scheduler + database/auth/plan services
npm run smoke         # drives the real Electron app end to end
npm run preview       # prints a sample plan to the terminal
npm run dist          # build the Windows installer into release/
npm run check:package # verify packaged assets are readable
```

`npm test` covers the scheduling engine (28 cases) and the persistence layer
(38 cases). `npm run smoke` boots the actual app against a throwaway database,
walks through sign-up → plan creation → progress → reload → attach material →
PDF/image viewing → removal → write questions → quiz → sign-out, and writes
screenshots to `.smoke/`. It fails on any renderer console error.

## How the scheduler works

`electron/services/scheduler.js` is the core. It has no dependencies and runs in
plain Node, so it can be tested and reasoned about on its own.

1. **Normalise and validate** the input, defaulting anything omitted.
2. **Build the calendar** of study days between the start date and the exam,
   then compute daily capacity from hours/day.
3. **Estimate demand.** Each topic gets `1.5h × difficulty × importance`, unless
   you type your own estimate. Subject priority multiplies the weight.
4. **Fit demand to the budget.** If the total exceeds the time available, every
   topic is scaled down by the same factor. Per-subject weekly caps are then
   enforced by repeatedly capping the subject and pushing the overflow onto
   subjects that still have headroom.
5. **Split into sessions** of your chosen length, with short slivers balanced
   across two sessions instead of producing a useless stub.
6. **Place sessions.** Subjects are interleaved round-robin so no single subject
   dominates a day, and each session is anchored to its proportional slot in the
   window — this spreads the load evenly instead of cramming week one and
   leaving the student idle. Constraints are checked in order of importance:

   | Rule | Relaxable? |
   |---|---|
   | Never exceed the day's time window | no |
   | New material only before the reserved revision days | no |
   | Never schedule two sessions of one topic on the same day | no |
   | Respect each subject's weekly hour cap | last |
   | Leave a gap between sessions of the same topic | yes |
   | Limit a subject to two sessions per day | first |

   Relaxation only kicks in when a session genuinely has nowhere to go, and
   every session records the level at which it was placed, which the tests assert
   against.
7. **Drop reviews in** to whatever capacity is left, earliest deadline first.

The plan also reports what it had to compromise on — scaled-down estimates,
subjects that hit their cap, review passes that landed after the exam, and
unused capacity.

## Project layout

```
electron/
  main.js              app lifecycle, window, IPC, app:// and material:// protocols
  preload.js           the renderer's only bridge to Node
  db/database.js       SQLite (sql.js/WASM) schema, atomic debounced saves
  services/
    scheduler.js       the scheduling engine
    auth.js            scrypt hashing and local sessions
    plans.js           plan persistence, always scoped to the owner
    materials.js       attached files, copied under the user's data folder
    questions.js       flashcards and their spaced-repetition schedule
renderer/
  index.html           app shell
  app.js               router, session store, top bar
  views/               auth, dashboard, planner, plan detail, quiz
  lib/                 DOM helpers, formatting, material viewer
scripts/
  test-scheduler.mjs   engine tests
  test-backend.cjs     persistence, auth and plan tests
  smoke.js             end-to-end Electron test with screenshots
  check-package.cjs    verifies packaged assets are readable
  preview-plan.cjs     prints a sample plan
```

## Security notes

- The renderer runs with `contextIsolation` on, `nodeIntegration` off, and a
  strict CSP. User text is inserted via `textContent`, never `innerHTML`.
- Attached files are served over a private `material://` scheme that requires a
  per-login capability token, checks the row belongs to the signed-in user,
  sends `X-Content-Type-Options: nosniff`, and force-downloads any file type it
  cannot preview instead of rendering it.
- Files are stored under a random UUID name; the original filename is only ever
  a label, so it cannot influence where bytes land on disk.
- Every plan and material query is scoped to the authenticated user's id.

## Data and privacy

Plans, accounts and attached files live under Electron's userData folder
(`%APPDATA%\StudyFlow`), reachable from **File → Show Database File** in the
menu. Passwords are hashed with scrypt and a per-user salt; session tokens
expire after 30 days. Nothing leaves your machine.

Set `STUDYFLOW_DATA_DIR` to relocate the whole data folder — the smoke test
uses this to stay out of your real profile.

## Packaging

```bash
npm run dist
```

Requires `electron-builder` (`npm i -D electron-builder`) and produces a Windows
installer via NSIS.