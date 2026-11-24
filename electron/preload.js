'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. Every call returns the same envelope
 * shape ({ ok, data } or { ok, error }) so views can handle failures uniformly
 * instead of dealing with rejected promises.
 */

async function call(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result || result.ok !== true) {
    const err = new Error(result && result.error ? result.error : 'Unexpected error');
    err.kind = result && result.kind;
    throw err;
  }
  return result.data;
}

const api = {
  auth: {
    register: (payload) => call('auth:register', payload),
    login: (payload) => call('auth:login', payload),
    logout: (token) => call('auth:logout', { token }),
    session: (token) => call('auth:session', { token }),
  },
  plans: {
    list: (token) => call('plans:list', { token }),
    get: (token, id) => call('plans:get', { token, id }),
    create: (token, input) => call('plans:create', { token, input }),
    regenerate: (token, id, input) => call('plans:regenerate', { token, id, input }),
    rename: (token, id, title) => call('plans:rename', { token, id, title }),
    remove: (token, id) => call('plans:delete', { token, id }),
    setProgress: (token, id, sessionId, completed) =>
      call('plans:progress', { token, id, sessionId, completed }),
  },
  materials: {
    list: (token, planId) => call('materials:list', { token, id: planId }),
    attach: (token, planId, target) => call('materials:attach', { token, id: planId, ...target }),
    remove: (token, id) => call('materials:remove', { token, id }),
    openExternal: (token, id) => call('materials:openExternal', { token, id }),
  },
  questions: {
    list: (token, planId) => call('questions:list', { token, id: planId }),
    create: (token, planId, question) => call('questions:create', { token, id: planId, question }),
    update: (token, id, question) => call('questions:update', { token, id, question }),
    remove: (token, id) => call('questions:remove', { token, id }),
    answer: (token, id, optionId) => call('questions:answer', { token, id, optionId }),
    due: (token, planId, topicId, limit) => call('questions:due', { token, id: planId, topicId, limit }),
  },
  ai: {
    status: (token) => call('ai:status', { token }),
    setKey: (token, apiKey) => call('ai:setKey', { token, apiKey }),
    ask: (token, payload) => call('ai:ask', { token, ...payload }),
  },
  app: {
    info: () => call('app:info'),
    revealDatabase: () => call('app:revealDatabase'),
  },
};

contextBridge.exposeInMainWorld('api', api);