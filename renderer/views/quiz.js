import { h, mount, field, select, button, clear } from '../lib/dom.js';
import { store, navigate, showError, handleAuthFailure } from '../app.js';

/**
 * Self-testing flashcards.
 *
 * Two modes: a library where questions are written and managed, and a quiz
 * where they are answered. Answering is handled by the scheduler service, so
 * the next review date is always decided in one place.
 */

const OPTION_COUNT = 4;

function blankOption(isCorrect = false) {
  return { label: '', isCorrect };
}

function optionLetter(i) {
  return String.fromCharCode(65 + i);
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

function questionForm(plan, topics, existing, onSave, onCancel) {
  let options = existing
    ? existing.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect }))
    : Array.from({ length: OPTION_COUNT }, (_, i) => blankOption(i === 0));

  const optionSlot = h('div', { class: 'option-list' });
  const errorSlot = h('div', { class: 'form-error', hidden: true });
  const saveButton = button(existing ? 'Save changes' : 'Add question', () => submit(),
    { class: 'btn btn-primary' });

  function showError(message) {
    errorSlot.textContent = message || '';
    errorSlot.hidden = !message;
  }

  function renderOptions() {
    clear(optionSlot);
    options.forEach((option, i) => {
      optionSlot.appendChild(h('div', { class: 'option-row' },
        h('span', { class: 'option-letter' }, optionLetter(i)),
        h('input', {
          type: 'text',
          placeholder: `Option ${optionLetter(i)}`,
          value: option.label,
          'aria-label': `Option ${optionLetter(i)}`,
          onInput: (e) => { option.label = e.target.value; },
        }),
        h('label', { class: 'option-correct' },
          h('input', {
            type: 'radio',
            name: 'correct-option',
            checked: option.isCorrect,
            title: 'Mark as the correct answer',
            onChange: () => {
              options = options.map((o, j) => ({ ...o, isCorrect: j === i }));
              renderOptions();
            },
          }),
          h('span', null, 'Correct'),
        ),
        options.length > 2
          ? button('Remove', () => {
            options.splice(i, 1);
            if (!options.some((o) => o.isCorrect)) options[0].isCorrect = true;
            renderOptions();
          }, { class: 'btn btn-ghost btn-small btn-danger' })
          : null,
      ));
    });

    optionSlot.appendChild(h('div', { class: 'option-actions' },
      options.length < 6
        ? button('+ Add option', () => {
          options.push(blankOption(false));
          renderOptions();
        }, { class: 'btn btn-ghost btn-small' })
        : null,
      h('span', { class: 'hint' }, 'Select the dot next to the correct answer.'),
    ));
  }

  function submit() {
    showError('');
    const prompt = promptInput.value.trim();
    const filled = options.filter((o) => o.label.trim());

    if (!prompt) { showError('Write the question first.'); return; }
    if (filled.length < 2) { showError('Add at least two options.'); return; }
    if (filled.filter((o) => o.isCorrect).length !== 1) {
      showError('Mark exactly one option as the correct answer.');
      return;
    }

    saveButton.disabled = true;
    onSave({
      prompt,
      explanation: explainInput.value.trim(),
      topicId: topicSelect.value || null,
      topicName: topicOptions.find((t) => t.value === topicSelect.value)?.label,
      subjectIndex: topicOptions.find((t) => t.value === topicSelect.value)?.subjectIndex ?? null,
      subjectName: topicOptions.find((t) => t.value === topicSelect.value)?.subject ?? null,
      options: filled.map((o) => ({ label: o.label.trim(), isCorrect: o.isCorrect })),
    });
  }

  const topicOptions = topics.map((t, i) => ({ value: t.topicId, label: t.label, subjectIndex: t.subjectIndex, subject: t.subject }));
  const topicSelect = select(
    topicOptions.length ? topicOptions : [{ value: '', label: 'No topics yet' }],
    existing ? existing.topicId : (topicOptions[0] && topicOptions[0].value),
    () => {},
  );

  const promptInput = h('input', {
    type: 'text', value: existing ? existing.prompt : '',
    placeholder: 'e.g. Which operator is used for the modulo operation?',
    onInput: () => {},
  });

  const explainInput = h('textarea', {
    rows: '2', placeholder: 'Optional: why the answer is correct',
  }, existing ? existing.explanation : '');
  explainInput.value = existing ? existing.explanation : '';

  renderOptions();

  return h('form', {
    class: 'card question-form',
    onSubmit: (e) => { e.preventDefault(); submit(); },
  },
  h('h2', { class: 'card-title' }, existing ? 'Edit question' : 'New question'),
  field('Topic', topicSelect),
  field('Question', promptInput),
  h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Options'),
    optionSlot,
  ),
  field('Explanation', explainInput, 'Shown after you answer'),
  errorSlot,
  h('div', { class: 'form-actions' },
    button('Cancel', onCancel, { class: 'btn btn-ghost' }),
    saveButton,
  ),
  );
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

function quizCard(question, onAnswer, state) {
  const feedback = h('div', { class: 'quiz-feedback', hidden: true });
  const nextButton = h('button', { class: 'btn btn-primary', type: 'button', hidden: true }, 'Next question');

  const optionButtons = question.options.map((option, i) => h('button', {
    type: 'button',
    class: 'quiz-option',
    disabled: state.answered,
    onClick: () => onAnswer(question, option.id),
  },
  h('span', { class: 'option-letter' }, optionLetter(i)),
  h('span', { class: 'quiz-option-label' }, option.label),
  ));

  const card = h('section', { class: 'card quiz-card' },
    h('div', { class: 'quiz-top' },
      h('span', { class: 'chip-inline' }, question.topicName),
      h('span', { class: 'chip-inline' },
        question.review.streak > 0 ? `${question.review.streak} in a row` : 'new'),
    ),
    h('h2', { class: 'quiz-prompt' }, question.prompt),
    h('div', { class: 'quiz-options' }, ...optionButtons),
    feedback,
    h('div', { class: 'quiz-actions' }, nextButton),
  );

  function reveal(result) {
    state.answered = true;
    optionButtons.forEach((btn, i) => {
      const option = question.options[i];
      btn.disabled = true;
      if (option.id === result.correctOptionId) btn.classList.add('is-correct');
      else if (option.id === result.chosenOptionId) btn.classList.add('is-wrong');
    });

    mount(feedback,
      h('div', { class: `quiz-result ${result.correct ? 'is-correct' : 'is-wrong'}` },
        h('strong', null, result.correct ? 'Correct' : 'Not quite'),
        h('span', null,
          `Back again in ${result.nextReviewInDays} day${result.nextReviewInDays === 1 ? '' : 's'}.`),
      ),
      result.explanation
        ? h('p', { class: 'quiz-explanation' }, result.explanation)
        : null,
    );
    feedback.hidden = false;
    nextButton.hidden = false;
  }

  nextButton.addEventListener('click', () => onAnswer.next());
  card.reveal = reveal;
  return card;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderQuiz({ id, navigate: go }) {
  const slot = h('div', { class: 'page' });

  let plan = null;
  let all = [];
  let summary = null;
  let mode = 'library';
  // Lives outside the render functions: as a per-render local it would be
  // reset to false every time the view re-drew, so the form would never show.
  let adding = false;
  let quizQueue = [];
  let quizIndex = 0;
  let sessionResults = { correct: 0, wrong: 0 };

  async function load() {
    try {
      const [saved, result] = await Promise.all([
        window.api.plans.get(store.token, id),
        window.api.questions.list(store.token, id),
      ]);
      if (!saved) { go('dashboard'); return; }
      plan = saved.plan;
      all = result.questions;
      summary = result.summary;
      draw();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
    }
  }

  /** Distinct topics available for questions, in schedule order. */
  function topics() {
    const seen = new Map();
    for (const day of plan.days) {
      for (const session of day.sessions) {
        if (seen.has(session.topicId)) continue;
        seen.set(session.topicId, {
          topicId: session.topicId,
          label: session.subjectName ? `${session.topicName} (${session.subjectName})` : session.topicName,
          subjectIndex: session.subjectIndex,
          subject: session.subjectName,
        });
      }
    }
    return [...seen.values()];
  }

  async function startQuiz(topicId) {
    try {
      quizQueue = await window.api.questions.due(store.token, id, topicId || null, 100);
      quizIndex = 0;
      sessionResults = { correct: 0, wrong: 0 };
      if (!quizQueue.length) {
        mode = 'library';
        draw();
        showError('Nothing is due right now. Try again later or add more questions.');
        return;
      }
      mode = 'quiz';
      draw();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showError(err.message);
    }
  }

  function onAnswer(question, optionId) {
    window.api.questions.answer(store.token, question.id, optionId)
      .then((result) => {
        result.chosenOptionId = optionId;
        if (result.correct) sessionResults.correct += 1;
        else sessionResults.wrong += 1;
        const card = slot.querySelector('.quiz-card');
        if (card && card.reveal) card.reveal(result);
        refreshSummary();
      })
      .catch((err) => {
        if (!handleAuthFailure(err)) showError(err.message);
      });
  }

  onAnswer.next = () => {
    quizIndex += 1;
    if (quizIndex >= quizQueue.length) {
      mode = 'library';
      draw();
      const { correct, wrong } = sessionResults;
      const total = correct + wrong;
      showError(total
        ? `Session finished: ${correct} of ${total} correct.`
        : 'Session finished.');
      return;
    }
    draw();
  };

  async function refreshSummary() {
    try {
      const result = await window.api.questions.list(store.token, id);
      all = result.questions;
      summary = result.summary;
      const stats = slot.querySelector('.quiz-stats');
      if (stats) mount(stats, ...statTiles());
    } catch {
      // A stale summary is harmless; the next load will correct it.
    }
  }

  function statTiles() {
    return [
      ['Questions', String(summary.total)],
      ['Due now', String(summary.due)],
      ['Not yet seen', String(summary.unseen)],
      ['Known', String(summary.known)],
      ['Accuracy', summary.accuracy == null ? '—' : `${summary.accuracy}%`],
    ].map(([label, value]) => h('div', { class: 'stat-tile' },
      h('span', { class: 'stat-label' }, label),
      h('span', { class: 'stat-value' }, value)));
  }

  function draw() {
    if (mode === 'quiz') return drawQuiz();
    return drawLibrary();
  }

  function drawQuiz() {
    const question = quizQueue[quizIndex];
    const state = { answered: false };
    const card = quizCard(question, onAnswer, state);

    slot.replaceChildren(h('div', { class: 'page-head' },
      h('div', null,
        button('← Back to questions', () => { mode = 'library'; draw(); },
          { class: 'btn btn-ghost btn-small' }),
        h('h1', { class: 'page-title' }, 'Practice'),
        h('p', { class: 'page-sub' },
          `Question ${quizIndex + 1} of ${quizQueue.length} · `
          + `${sessionResults.correct} correct so far`),
      ),
    ),
    card);
  }

  function drawLibrary() {
    const errorSlot = h('div', { class: 'form-error', hidden: true });
    const host = h('div');
    const listSlot = h('div', { class: 'question-groups' });

    // Build the grouped list directly into listSlot; no nested wrapper needed.
    if (all.length) {
      const grouped = new Map();
      for (const q of all) {
        if (!grouped.has(q.topicName)) grouped.set(q.topicName, []);
        grouped.get(q.topicName).push(q);
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const [topic, list] of grouped) {
        const due = list.filter((q) => q.review.dueDate <= today).length;
        listSlot.appendChild(h('section', { class: 'card question-group' },
          h('div', { class: 'section-head' },
            h('h3', { class: 'card-title' }, topic),
            h('span', { class: 'chip-inline' },
              `${list.length} question${list.length === 1 ? '' : 's'}${due ? ` · ${due} due` : ''}`),
          ),
          h('ul', { class: 'question-list' },
            ...list.map((q) => questionRow(q, () => load(), startQuiz)),
          ),
        ));
      }
    } else {
      listSlot.appendChild(h('div', { class: 'empty' },
        h('h2', null, 'No questions yet'),
        h('p', null, 'Write a few multiple-choice questions for your topics, '
          + 'then use Practice to test yourself. Questions you get wrong come back later.'),
      ));
    }

    // replaceChildren() stringifies null, so drop the empty slots.
    host.replaceChildren(...[
      all.length ? h('section', { class: 'card quiz-stats' }, ...statTiles()) : null,
      h('div', { class: 'quiz-controls' },
        button(`Practise ${summary.due} due question${summary.due === 1 ? '' : 's'}`,
          () => startQuiz(null),
          { class: 'btn btn-primary', disabled: !summary.due }),
        button(adding ? 'Cancel' : 'Add question',
          () => { adding = !adding; draw(); },
          { class: 'btn btn-ghost' }),
      ),
      errorSlot,
      adding ? questionForm(plan, topics(), null, saveQuestion, () => { adding = false; draw(); }) : null,
      listSlot,
    ].filter(Boolean));

    slot.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', null,
          button('← Back to plan', () => go('plan', { id }), { class: 'btn btn-ghost btn-small' }),
          h('h1', { class: 'page-title' }, 'Questions & practice'),
          h('p', { class: 'page-sub' },
            'Test yourself on each topic. Wrong answers come back after a day, then spread out.'),
        ),
      ),
      host,
    );

    function showError(message) {
      errorSlot.textContent = message || '';
      errorSlot.hidden = !message;
    }

    async function saveQuestion(question) {
      try {
        await window.api.questions.create(store.token, id, question);
        const result = await window.api.questions.list(store.token, id);
        all = result.questions;
        summary = result.summary;
        adding = false;
        draw();
      } catch (err) {
        if (!handleAuthFailure(err)) showError(err.message);
      }
    }
  }

  function questionRow(question, onChanged, onPractise) {
    return h('li', { class: `question-row ${question.review.known ? 'is-known' : ''}` },
      h('div', { class: 'question-main' },
        h('span', { class: 'question-prompt' }, question.prompt),
        h('span', { class: 'question-meta' },
          `${question.options.length} options`
          + (question.review.attempts
            ? ` · ${question.review.attempts} attempt${question.review.attempts === 1 ? '' : 's'}`
            : ' · not attempted')
          + ` · due ${question.review.dueDate}`),
      ),
      h('div', { class: 'question-actions' },
        button('Practise', () => onPractise(question.topicId), { class: 'btn btn-ghost btn-small' }),
        button('Remove', async () => {
          if (!window.confirm('Delete this question?')) return;
          try {
            await window.api.questions.remove(store.token, question.id);
            onChanged();
          } catch (err) {
            if (!handleAuthFailure(err)) showError(err.message);
          }
        }, { class: 'btn btn-ghost btn-small btn-danger' }),
      ),
    );
  }

  load();
  return slot;
}