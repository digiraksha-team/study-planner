import { h, mount, clear } from './lib/dom.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPlanner } from './views/planner.js';
import { renderPlan } from './views/plan.js';
import { renderQuiz } from './views/quiz.js';

const TOKEN_KEY = 'studyflow.token';
const ROUTE_KEY = 'studyflow.route';

export const store = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  materialKey: null,

  setSession(token, user, materialKey) {
    this.token = token;
    this.user = user;
    this.materialKey = materialKey || null;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

/** URL for an attached file, authorised by the per-login capability token. */
export function materialUrl(id) {
  return `material://f/${id}?k=${encodeURIComponent(store.materialKey || '')}`;
}

const routes = {
  dashboard: renderDashboard,
  planner: renderPlanner,
  plan: renderPlan,
  quiz: renderQuiz,
};

const root = document.getElementById('app');
const outlet = document.getElementById('view');
const banner = document.getElementById('banner');
let currentView = null;

export function navigate(name, params = {}) {
  currentView = { name, params };
  // Remember the destination so a reload or app restart lands back here.
  sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ name, params }));
  render();
}

function render() {
  clear(outlet);
  if (!store.user) {
    document.body.dataset.view = 'auth';
    mount(outlet, renderAuth({ onSignedIn: () => navigate('dashboard') }));
    return;
  }
  document.body.dataset.view = 'app';
  const route = routes[currentView.name] || renderDashboard;
  mount(outlet, route({ ...currentView.params, navigate }));
}

export function showError(message) {
  if (!message) {
    clear(banner);
    banner.hidden = true;
    return;
  }
  mount(banner,
    h('span', { class: 'banner-text' }, message),
    h('button', {
      class: 'banner-close',
      type: 'button',
      title: 'Dismiss',
      onClick: () => showError(null),
    }, '×'),
  );
  banner.hidden = false;
}

/** Any auth rejection means the stored token is no longer good. */
export function handleAuthFailure(err) {
  if (err && err.kind === 'AuthError') {
    store.setSession(null, null, null);
    render();
    return true;
  }
  return false;
}

function restoreRoute() {
  const raw = sessionStorage.getItem(ROUTE_KEY);
  if (!raw) return { name: 'dashboard', params: {} };
  try {
    const saved = JSON.parse(raw);
    if (saved && routes[saved.name]) return saved;
  } catch {
    // Corrupt route data should never block startup.
  }
  return { name: 'dashboard', params: {} };
}

async function bootstrap() {
  document.getElementById('user-chip').textContent = '';

  if (!store.token) {
    render();
    return;
  }

  try {
    const { user, materialKey } = await window.api.auth.session(store.token);
    store.setSession(store.token, user, materialKey);
    const route = restoreRoute();
    navigate(route.name, route.params);
  } catch (err) {
    if (!handleAuthFailure(err)) showError(err.message);
    render();
  }

  const info = await window.api.app.info();
  document.getElementById('user-chip').textContent = `${info.version} · local database`;
}

// Header actions ------------------------------------------------------------
document.getElementById('sign-out').addEventListener('click', async () => {
  try {
    await window.api.auth.logout(store.token);
  } catch {
    // Signing out locally matters more than the server round trip.
  }
  store.setSession(null, null, null);
  sessionStorage.removeItem(ROUTE_KEY);
  navigate('dashboard');
});

document.getElementById('new-plan').addEventListener('click', () => {
  if (store.user) navigate('planner');
});

bootstrap();