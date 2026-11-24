import { h, field, button } from '../lib/dom.js';
import { store, showError } from '../app.js';

/** Sign in / sign up. Accounts are local to this machine. */
export function renderAuth({ onSignedIn }) {
  let mode = 'login';
  const errorSlot = h('div', { class: 'form-error', hidden: true });
  const nameInput = h('input', { type: 'text', name: 'name', placeholder: 'Alex', autocomplete: 'name' });
  const emailInput = h('input', {
    type: 'email', name: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true,
  });
  const passwordInput = h('input', {
    type: 'password', name: 'password', placeholder: 'At least 8 characters',
    autocomplete: 'current-password', required: true,
  });
  const submitButton = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');

  function showError(message) {
    errorSlot.textContent = message || '';
    errorSlot.hidden = !message;
  }

  function applyMode(next) {
    mode = next;
    showError('');
    const signup = mode === 'register';
    submitButton.textContent = signup ? 'Create account' : 'Sign in';
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    nameRow.hidden = !signup;
    loginTab.classList.toggle('is-active', !signup);
    registerTab.classList.toggle('is-active', signup);
    heading.textContent = signup ? 'Create your account' : 'Welcome back';
    sub.textContent = signup
      ? 'Your plans stay on this device.'
      : 'Sign in to reach your study plans.';
  }

  const heading = h('h1', { class: 'auth-heading' }, 'Welcome back');
  const sub = h('p', { class: 'auth-sub' }, 'Sign in to reach your study plans.');
  const nameRow = h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput);

  const loginTab = h('button', {
    class: 'tab is-active', type: 'button', onClick: () => applyMode('login'),
  }, 'Sign in');
  const registerTab = h('button', {
    class: 'tab', type: 'button', onClick: () => applyMode('register'),
  }, 'Create account');

  const form = h('form', {
    class: 'auth-form',
    onSubmit: async (event) => {
      event.preventDefault();
      showError('');
      submitButton.disabled = true;
      submitButton.textContent = mode === 'register' ? 'Creating...' : 'Signing in...';

      try {
        const payload = { email: emailInput.value, password: passwordInput.value };
        const result = mode === 'register'
          ? await window.api.auth.register({ ...payload, name: nameInput.value })
          : await window.api.auth.login(payload);

        store.setSession(result.token, result.user, result.materialKey);
        onSignedIn();
      } catch (err) {
        showError(err.message);
        submitButton.disabled = false;
        applyMode(mode);
      }
    },
  },
  heading,
  sub,
  nameRow,
  field('Email', emailInput),
  field('Password', passwordInput),
  errorSlot,
  submitButton,
  );

  nameRow.hidden = true;

  return h('div', { class: 'auth-shell' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'tabs' }, loginTab, registerTab),
      form,
      h('p', { class: 'auth-note' },
        'Accounts are stored locally. Nothing is uploaded, and no AI service is contacted.'),
    ),
  );
}