import { h, mount, clear } from '../lib/dom.js';
import { store, handleAuthFailure } from '../app.js';

/**
 * Floating "Ask AI" tutor.
 *
 * One button on the plan page opens a chat panel. Questions go to the backend,
 * which answers using the signed-in user's plan (subject + topics) and their
 * stored OpenAI-compatible key.
 */

let backdropEl = null;
let panelEl = null;
let msgEl = null;
let ctxEl = null;
let errEl = null;
let keySec = null;
let keyInput = null;
let saveKeyBtn = null;
let promptInput = null;
let sendBtn = null;

let planId = null;
let status = { hasKey: false, maskedKey: '' };
let messages = [];
let loading = false;
let savingKey = false;
let errorText = null;
let draft = '';
let keyDraft = '';

function setError(text) {
  errorText = text || null;
  if (errEl) {
    errEl.textContent = errorText || '';
    errEl.hidden = !errorText;
  }
}

function setDraftValue(value) {
  draft = String(value || '');
  if (promptInput) promptInput.value = draft;
}

function scrollToBottom() {
  if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
}

function renderMessages() {
  if (!messages.length) {
    mount(msgEl, h('div', { class: 'ai-empty' },
      h('div', { class: 'ai-empty-title' }, 'Stuck on a topic?'),
      h('p', { class: 'ai-empty-text' },
        'Ask your AI tutor. It is anchored to the subjects and topics in your '
        + 'plan, so it can explain the doubt in context.'),
    ));
  } else {
    mount(msgEl, ...messages.map((m) => h('div', { class: `ai-msg ${m.role}` },
      h('div', { class: 'ai-bubble' }, m.text),
    )));
  }
  scrollToBottom();
}

function renderKeySection() {
  if (status.hasKey) {
    if (keySec) keySec.hidden = true;
    if (keyInput) keyInput.value = '';
    keyDraft = '';
    if (saveKeyBtn) saveKeyBtn.disabled = savingKey;
    return;
  }
  if (!keySec) return;
  keySec.hidden = false;
  if (keyInput) keyInput.value = keyDraft;
  if (saveKeyBtn) saveKeyBtn.disabled = savingKey;
}

async function saveKey() {
  const key = String(keyDraft || '').trim();
  if (!key) {
    setError('Paste your OpenAI API key first.');
    return;
  }
  savingKey = true;
  setError(null);
  if (saveKeyBtn) saveKeyBtn.disabled = true;
  try {
    const result = await window.api.ai.setKey(store.token, key);
    status = result || { hasKey: true, maskedKey: '••••' };
    keyDraft = '';
    if (keyInput) keyInput.value = '';
    keyFieldVisibleReset();
    renderKeySection();
  } catch (err) {
    if (!handleAuthFailure(err)) setError(err.message);
  } finally {
    savingKey = false;
    if (saveKeyBtn) saveKeyBtn.disabled = false;
  }
}

// The key form is only shown when no key is stored yet; flipping this keeps the
// module state honest without threading more props through the builder.
let keyFieldVisible = false;
function keyFieldVisibleReset() {
  if (keySec) keySec.hidden = keyFieldVisible;
}

async function ask() {
  const prompt = String(draft || '').trim();
  if (!prompt || loading || !planId) return;
  setDraftValue('');
  messages.push({ role: 'user', text: prompt });
  loading = true;
  setError(null);
  renderMessages();
  if (sendBtn) sendBtn.disabled = true;
  try {
    const result = await window.api.ai.ask(store.token, { planId, prompt });
    messages.push({ role: 'assistant', text: result.answer });
    if (result.context) {
      if (ctxEl) ctxEl.textContent = String(result.context);
    }
    renderMessages();
  } catch (err) {
    if (!handleAuthFailure(err)) setError(err.message);
  } finally {
    loading = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function closeAskAi() {
  if (backdropEl) backdropEl.remove();
  if (panelEl) panelEl.remove();
  backdropEl = null;
  panelEl = null;
  if (msgEl) msgEl.replaceChildren();
  if (errEl) errEl.hidden = true;
  if (keySec) keySec.hidden = true;
  if (promptInput) promptInput.value = '';
  setDraftValue('');
  draft = '';
  keyDraft = '';
  if (saveKeyBtn) saveKeyBtn.disabled = false;
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(event) {
  if (event.key === 'Escape') closeAskAi();
}

export async function openAskAi(plan) {
  planId = plan && plan.id ? plan.id : null;
  messages = [];
  loading = false;
  errorText = null;
  draft = '';
  keyDraft = '';
  keyFieldVisible = false;
  if (promptInput) promptInput.value = '';

  try {
    status = await window.api.ai.status(store.token);
  } catch (err) {
    if (!handleAuthFailure(err)) status = { hasKey: false, maskedKey: '' };
  }

  const backdrop = h('div', { class: 'ai-backdrop', onClick: closeAskAi });
  const freshMessages = h('div', { class: 'ai-messages' });
  const freshContext = h('div', { class: 'ai-context' });
  const freshError = h('div', { class: 'ai-error', hidden: true });
  const freshKey = h('div', { class: 'ai-key' },
    h('span', { class: 'ai-key-label' }, 'AI tutor API key'),
    h('div', { class: 'ai-key-row' },
      h('input', { class: 'ai-key-input', type: 'password', placeholder: 'sk-…', onInput: (e) => { keyDraft = e.target.value; } }),
      h('button', { type: 'button', class: 'btn btn-primary btn-small', onClick: () => { void saveKey(); } }, 'Save key'),
    ),
  );
  const freshPrompt = h('input', {
    class: 'ai-input', type: 'text', placeholder: 'Ask about your subject…',
    onInput: (e) => { draft = e.target.value; },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void ask();
      }
    },
  });
  const freshSend = h('button', { type: 'button', class: 'ai-send', onClick: () => { void ask(); } }, 'Send');

  const freshPanel = h('div', { class: 'ai-panel' },
    h('div', { class: 'ai-head' },
      h('div', null,
        h('div', { class: 'ai-title' }, 'Ask StudyFlow AI'),
        freshContext,
      ),
      h('button', { type: 'button', class: 'ai-close', title: 'Close', onClick: closeAskAi }, '×'),
    ),
    freshMessages,
    freshKey,
    freshError,
    h('div', { class: 'ai-foot' }, freshPrompt, freshSend),
  );

  backdropEl = backdrop;
  panelEl = freshPanel;
  msgEl = freshMessages;
  ctxEl = freshContext;
  errEl = freshError;
  keySec = freshKey;
  keyInput = freshKey.querySelector('.ai-key-input');
  saveKeyBtn = freshKey.querySelector('.ai-key-row .btn');
  promptInput = freshPrompt;
  sendBtn = freshSend;

  document.body.appendChild(backdrop);
  document.body.appendChild(freshPanel);

  renderMessages();
  renderKeySection();
  if (ctxEl) ctxEl.textContent = 'Subjects and topics from this plan will appear here.';
  setError(null);

  document.addEventListener('keydown', onKeyDown);
}

/** Floating button for the plan page. */
export function askAiFab(planId) {
  const fab = h('button', {
    type: 'button',
    class: 'ai-fab',
    title: 'Ask StudyFlow AI',
    'aria-label': 'Ask StudyFlow AI',
    onClick: () => { void openAskAi({ id: planId }); },
  }, '✦');
  return fab;
}
