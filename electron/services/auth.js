'use strict';

const crypto = require('crypto');
const database = require('../db/database');

/**
 * Local account handling. Passwords are hashed with scrypt and a per-user salt;
 * no password or plaintext token is ever written to disk. "Accounts" here are
 * local to this machine - they separate study plans and progress, they are not
 * an online identity.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return { hash: derived.toString('hex'), salt };
}

function verifyPassword(password, salt, expectedHash) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  const a = Buffer.from(derived.toString('hex'));
  const b = Buffer.from(expectedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateCredentials(email, password) {
  const clean = normaliseEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new AuthError('Enter a valid email address.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new AuthError('Password must be at least 8 characters.');
  }
  if (password.length > 200) {
    throw new AuthError('Password is too long.');
  }
  return clean;
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
}

function register({ email, name, password }) {
  const clean = validateCredentials(email, password);
  const displayName = String(name || '').trim() || clean.split('@')[0];

  const existing = database.get('SELECT id FROM users WHERE email = ?', [clean]);
  if (existing) throw new AuthError('An account with that email already exists.');

  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO users (email, name, password_hash, salt, iterations, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [clean, displayName, hash, salt, SCRYPT.N, now],
  );

  const user = database.get('SELECT * FROM users WHERE email = ?', [clean]);
  return { user: publicUser(user), token: createSession(user.id) };
}

function login({ email, password }) {
  const clean = normaliseEmail(email);
  const user = database.get('SELECT * FROM users WHERE email = ?', [clean]);
  // Always run a hash comparison so a missing account and a wrong password
  // take a similar amount of time.
  const salt = user ? user.salt : 'decoy-salt-value';
  const hash = user ? user.password_hash : crypto.scryptSync('decoy', salt, 64).toString('hex');
  const ok = verifyPassword(String(password || ''), salt, hash);

  if (!user || !ok) throw new AuthError('Incorrect email or password.');
  return { user: publicUser(user), token: createSession(user.id) };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  database.run(
    `INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    [token, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString()],
  );
  return token;
}

function logout(token) {
  if (token) database.run('DELETE FROM auth_sessions WHERE token = ?', [token]);
}

function userForToken(token) {
  if (!token) return null;
  const row = database.get(
    `SELECT u.* FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    [token, new Date().toISOString()],
  );
  if (!row) return null;
  // Opportunistically clean up expired rows.
  database.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [new Date().toISOString()]);
  return publicUser(row);
}

function purgeExpiredSessions() {
  database.run('DELETE FROM auth_sessions WHERE expires_at <= ?', [new Date().toISOString()]);
}

module.exports = {
  register,
  login,
  logout,
  userForToken,
  purgeExpiredSessions,
  publicUser,
  AuthError,
  hashPassword,
  verifyPassword,
};