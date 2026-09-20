import { types } from 'node:util';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 128 * 1024;
const ROOTS = Object.freeze({ xiaohongshu: 'xiaohongshu.com', douyin: 'douyin.com' });
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

function error(code = 'invalid_session_state') {
  const result = new Error(code);
  result.code = code;
  return result;
}

function reject() { throw error(); }

// Inspect descriptors before reading data. Accessors, proxies, custom prototypes,
// symbols and non-enumerable schema additions never reach the clean snapshot.
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) reject();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) reject();
  return result;
}

function array(value, limit) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) reject();
  if (value.length > limit) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) reject();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
    result.push(descriptor.value);
  }
  return result;
}

function inDomain(host, root) {
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return host === root || host.endsWith(`.${root}`);
}

function readNow(clock) {
  let value;
  try { value = clock(); } catch { reject(); }
  if (!Number.isSafeInteger(value) || value < 0) reject();
  return value;
}

function cleanState(value, platform, currentTime) {
  const input = fields(value, ['cookies', 'origins']);
  const root = ROOTS[platform];
  let stringBytes = 0;
  const string = value => {
    if (typeof value !== 'string') reject();
    stringBytes += Buffer.byteLength(value, 'utf8');
    if (stringBytes > MAX_BYTES) reject();
    return value;
  };
  const cookieKeys = new Set();
  const cookies = array(input.cookies, 100).map(value => {
    // partitionKey and all other extensions are intentionally unsupported.
    const item = fields(value, COOKIE_FIELDS);
    const name = string(item.name), cookieValue = string(item.value);
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(name) || /[\u0000-\u001f\u007f;]/.test(cookieValue)) reject();
    const domain = string(item.domain).toLowerCase();
    const host = domain.startsWith('.') ? domain.slice(1) : domain;
    if (!inDomain(host, root)) reject();
    const path = string(item.path);
    if (!path.startsWith('/') || /[\u0000-\u001f\u007f;]/.test(path)) reject();
    if (!Number.isFinite(item.expires) || (item.expires !== -1 && (item.expires <= currentTime / 1000 || item.expires > Number.MAX_SAFE_INTEGER))) reject();
    if (typeof item.httpOnly !== 'boolean' || typeof item.secure !== 'boolean' || !SAME_SITE.has(item.sameSite)) reject();
    const key = JSON.stringify([name, domain, path]);
    if (cookieKeys.has(key)) reject();
    cookieKeys.add(key);
    return { name, value: cookieValue, domain, path, expires: item.expires, httpOnly: item.httpOnly, secure: item.secure, sameSite: item.sameSite };
  });
  const originsSeen = new Set();
  let localStorageCount = 0;
  // Each origin needs more than one serialized byte; this coarse bound avoids
  // unbounded traversal before the exact serialized-byte check below.
  const origins = array(input.origins, MAX_BYTES).map(value => {
    const item = fields(value, ['origin', 'localStorage']);
    const origin = string(item.origin);
    let url;
    try { url = new URL(origin); } catch { reject(); }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.origin !== origin || !inDomain(url.hostname, root)) reject();
    if (originsSeen.has(origin)) reject();
    originsSeen.add(origin);
    const entries = array(item.localStorage, 50);
    localStorageCount += entries.length;
    if (localStorageCount > 50) reject();
    const names = new Set();
    const localStorage = entries.map(value => {
      const entry = fields(value, ['name', 'value']);
      const name = string(entry.name), valueString = string(entry.value);
      if (names.has(name)) reject();
      names.add(name);
      return { name, value: valueString };
    });
    return { origin, localStorage };
  });
  const result = { cookies, origins };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) reject();
  return result;
}

/**
 * An opt-in, memory-only lease for a dedicated account's internal fixed-20 test.
 * It never reads files, environment variables, personal profiles, or the network.
 * ready means valid lease data, NOT authentication confirmed by the platform.
 * expiresAt is an absolute Unix timestamp in milliseconds, bounded by both the
 * requested TTL and the earliest persistent cookie expiry. Any cookie expiry
 * conservatively ends the entire experiment; session cookies (-1) use the TTL.
 * This can stop a test when an unrelated short-lived cookie expires, but never
 * silently downgrades the experiment to an anonymous browser session.
 * Expiry/revocation
 * is checked on every access, prevents future reads and discards our snapshot;
 * copies already returned to a
 * caller must be cleared by that caller when its browser context is closed.
 */
export function createSessionLease(options) {
  let platform, ttlMs, clock, snapshot, expiresAt, lastObservedAt;
  try {
    const input = fields(options, ['platform', 'storageState', 'accountType', 'purpose', 'ttlMs', 'now'], ['platform', 'storageState', 'accountType', 'purpose']);
    if (input.accountType !== 'dedicated' || input.purpose !== 'internal-fixed-20-test' || typeof input.platform !== 'string' || !Object.hasOwn(ROOTS, input.platform)) reject();
    platform = input.platform;
    ttlMs = input.ttlMs === undefined ? DEFAULT_TTL_MS : input.ttlMs;
    clock = input.now === undefined ? Date.now : input.now;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS || typeof clock !== 'function' || types.isProxy(clock) || types.isAsyncFunction(clock) || types.isGeneratorFunction(clock)) reject();
    lastObservedAt = readNow(clock);
    expiresAt = lastObservedAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) reject();
    snapshot = cleanState(input.storageState, platform, lastObservedAt);
    for (const cookie of snapshot.cookies) {
      if (cookie.expires !== -1) expiresAt = Math.min(expiresAt, cookie.expires * 1000);
    }
  } catch { throw error(); }

  let state = 'ready';
  const observe = () => {
    if (state !== 'ready') return;
    lastObservedAt = Math.max(lastObservedAt, readNow(clock));
    if (lastObservedAt >= expiresAt) {
      state = 'expired';
      snapshot = null;
    }
  };
  const status = () => {
    observe();
    return structuredClone({ state, platform, expiresAt });
  };
  const revoke = () => {
    snapshot = null;
    state = 'revoked';
    return status();
  };
  const getState = requestedPlatform => {
    if (requestedPlatform !== platform) throw error('session_platform_mismatch');
    observe();
    if (state === 'expired') throw error('session_expired');
    if (state === 'revoked') throw error('session_revoked');
    return structuredClone(snapshot);
  };
  return Object.freeze({ getState, revoke, status });
}
