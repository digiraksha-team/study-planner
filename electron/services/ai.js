'use strict';

const database = require('../db/database');
const plans = require('./plans');
const { ValidationError } = require('./scheduler');

/**
 * Clarifying-tutor chat built on an OpenAI-compatible chat completions API.
 *
 * The app stays offline-first: the API key lives in the local database and is
 * only ever sent to the provider in the single chat request. The tutor is told
 * which subjects and topics the current plan covers, so answers are anchored to
 * the student's actual syllabus.
 */

const AI_ERROR = 'AiError';

class AiError extends Error {
  constructor(message) {
    super(message);
    this.name = AI_ERROR;
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 45000;

function getApiKey(userId) {
  const row = database.get('SELECT ai_api_key FROM user_settings WHERE user_id = ?', [userId]);
  return row ? String(row.ai_api_key || '') : '';
}

function hasApiKey(userId) {
  return Boolean(getApiKey(userId));
}

function maskKey(key) {
  const clean = String(key || '');
  if (!clean) return '';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

function statusFor(userId) {
  const key = getApiKey(userId);
  return { hasKey: Boolean(key), maskedKey: maskKey(key) };
}

function setApiKey(userId, rawKey) {
  const key = String(rawKey || '').trim();
  if (key && key.length > 400) throw new AiError('That API key looks too long.');
  const now = new Date().toISOString();
  const existing = database.get('SELECT user_id FROM user_settings WHERE user_id = ?', [userId]);
  if (existing) {
    database.run('UPDATE user_settings SET ai_api_key = ?, updated_at = ? WHERE user_id = ?', [
      key, now, userId,
    ]);
  } else {
    database.run(
      'INSERT INTO user_settings (user_id, ai_api_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [userId, key, now, now],
    );
  }
  return statusFor(userId);
}

/**
 * Render a plan into a compact tutor context: subject, difficulty, weekly hours
 * and every topic with its own estimate and importance.
 */
function buildContext(plan) {
  const input = (plan && plan.input) || {};
  const subjects = Array.isArray(input.subjects) ? input.subjects : [];
  const statsSubjects = Array.isArray(plan && plan.subjects) ? plan.subjects : [];
  const lines = [];

  lines.push(`Study plan: ${(plan && plan.title) || 'Untitled plan'}`);
  if (plan && plan.range && plan.range.examDate) {
    lines.push(`Exam date: ${plan.range.examDate}`);
  }
  lines.push('');

  if (!subjects.length) return 'No subjects are defined for this plan yet.';

  for (const subject of subjects) {
    const stats = statsSubjects.find((s) => s.name === subject.name) || {};
    lines.push(`Subject: ${subject.name}`);
    lines.push(
      `  Difficulty: ${subject.difficulty || 'medium'} · Priority: ${subject.priority || 'normal'}`
      + `${subject.hoursPerWeek ? ` · ${subject.hoursPerWeek}h/week` : ''}`,
    );
    if (stats.minutes) {
      lines.push(`  Study time scheduled so far: ${Math.round((stats.minutes / 60) * 10) / 10}h`);
    }
    for (const topic of Array.isArray(subject.topics) ? subject.topics : []) {
      lines.push(
        `  - Topic: ${topic.name} — estimated ${topic.hours}h, importance ${topic.importance}, difficulty ${subject.difficulty}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function requestAnswer({ apiKey, prompt, context, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content: 'You are StudyFlow, a patient and precise tutor for exam preparation. '
              + "Answer the student's question clearly and concretely, in the context of the subject and topics "
              + 'they are studying. If the answer is not knowable from the context, say so honestly.',
          },
          { role: 'user', content: `${context}\n\nStudent question: ${prompt}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `Request failed with status ${res.status}.`;
      try {
        const data = await res.json();
        if (data && data.error && data.error.message) detail = data.error.message;
      } catch {
        // Non-JSON error bodies are fine to ignore.
      }
      throw new AiError(`The AI provider did not answer: ${detail}`);
    }

    const data = await res.json();
    const answer = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new AiError('The AI returned an empty answer.');
    }
    return answer;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new AiError('The AI took too long to answer.');
    if (err instanceof AiError) throw err;
    throw new AiError('Could not reach the AI provider. Check your internet connection and API key.');
  } finally {
    clearTimeout(timer);
  }
}

/** Answer a doubt, anchored to the subjects and topics of a plan. */
async function ask(userId, planId, prompt) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new ValidationError('Write the question before asking the AI.');
  if (cleanPrompt.length > 4000) throw new ValidationError('That question is too long.');

  const apiKey = getApiKey(userId);
  if (!apiKey) throw new AiError('Add your OpenAI API key first, then come back to ask.');

  const plan = plans.get(userId, planId);
  if (!plan) throw new AiError('That plan no longer exists.');

  const context = buildContext(plan);
  const answer = await requestAnswer({ apiKey, prompt: cleanPrompt, context });
  return { answer, context, model: DEFAULT_MODEL };
}

module.exports = {
  AiError,
  AI_ERROR,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS,
  statusFor,
  hasApiKey,
  getApiKey,
  setApiKey,
  buildContext,
  ask,
};
