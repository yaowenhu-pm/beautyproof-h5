import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionLease } from './session-lease.mjs';

const START = 1_800_000_000_000;
const SECRET = 'FAKE_ONLY_NEVER_REAL_ACCOUNT_DATA';
const roots = { xiaohongshu: 'xiaohongshu.com', douyin: 'douyin.com' };
const cookie = (platform = 'xiaohongshu', overrides = {}) => ({
  name: 'test_session', value: SECRET, domain: `.${roots[platform]}`, path: '/',
  expires: -1, httpOnly: false, secure: true, sameSite: 'Lax', ...overrides,
});
const storage = (platform = 'xiaohongshu') => ({
  cookies: [cookie(platform)],
  origins: [{ origin: `https://www.${roots[platform]}`, localStorage: [{ name: 'test-token', value: SECRET }] }],
});
const options = (overrides = {}) => ({
  platform: 'xiaohongshu', storageState: storage(), accountType: 'dedicated',
  purpose: 'internal-fixed-20-test', now: () => START, ...overrides,
});
function rejects(fn, code = 'invalid_session_state') {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(String(error.stack).includes(SECRET), false);
    assert.deepEqual(Object.keys(error), ['code']);
    return true;
  });
}

test('accepts both dedicated platform states; status is only lease readiness', () => {
  for (const platform of Object.keys(roots)) {
    const state = storage(platform);
    const lease = createSessionLease(options({ platform, storageState: state }));
    assert.deepEqual(lease.status(), { state: 'ready', platform, expiresAt: START + 15 * 60 * 1000 });
    assert.deepEqual(lease.getState(platform), state);
    assert.deepEqual(Object.keys(lease).sort(), ['getState', 'revoke', 'status']);
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(JSON.stringify(lease.status()).includes(SECRET), false);
  }
  const empty = createSessionLease(options({ storageState: { cookies: [], origins: [] } }));
  assert.equal(empty.status().state, 'ready'); // No claim that any account is logged in.
});

test('requires explicit dedicated-account and fixed-test authorization', () => {
  for (const key of ['accountType', 'purpose', 'platform', 'storageState']) {
    const input = options(); delete input[key]; rejects(() => createSessionLease(input));
  }
  for (const accountType of ['personal', '', null, true]) rejects(() => createSessionLease(options({ accountType })));
  for (const purpose of ['production', '', null, true]) rejects(() => createSessionLease(options({ purpose })));
  for (const platform of ['other', '__proto__', '', null, true]) rejects(() => createSessionLease(options({ platform })));
  let coerced = false;
  rejects(() => createSessionLease(options({ platform: { toString() { coerced = true; return 'xiaohongshu'; } } })));
  assert.equal(coerced, false);
});

test('enforces default, maximum, invalid TTL values and exact expiry boundary', () => {
  let current = START;
  const lease = createSessionLease(options({ ttlMs: 1000, now: () => current }));
  current += 999; assert.equal(lease.status().state, 'ready');
  current++; rejects(() => lease.getState('xiaohongshu'), 'session_expired');
  assert.deepEqual(lease.status(), { state: 'expired', platform: 'xiaohongshu', expiresAt: START + 1000 });
  current = START; rejects(() => lease.getState('xiaohongshu'), 'session_expired');
  assert.equal(createSessionLease(options({ ttlMs: 30 * 60 * 1000 })).status().expiresAt, START + 30 * 60 * 1000);
  for (const ttlMs of [0, -1, 1.5, '1000', null, NaN, Infinity, 30 * 60 * 1000 + 1]) rejects(() => createSessionLease(options({ ttlMs })));
  for (const now of [null, 123, () => NaN, () => Infinity, () => -1, () => 1.5, () => { throw Error(SECRET); }]) rejects(() => createSessionLease(options({ now })));
  rejects(() => createSessionLease(options({ now: async () => { throw Error(SECRET); } })));
  rejects(() => createSessionLease(options({ now: () => Number.MAX_SAFE_INTEGER })));
});

test('wrong-platform reads leave the correct lease usable; revocation is terminal and idempotent', () => {
  const lease = createSessionLease(options());
  for (const platform of ['douyin', undefined, null, '__proto__']) rejects(() => lease.getState(platform), 'session_platform_mismatch');
  assert.equal(lease.getState('xiaohongshu').cookies[0].value, SECRET);
  const first = lease.revoke();
  assert.deepEqual(first, { state: 'revoked', platform: 'xiaohongshu', expiresAt: START + 15 * 60 * 1000 });
  assert.deepEqual(lease.revoke(), first);
  rejects(() => lease.getState('xiaohongshu'), 'session_revoked');
  assert.deepEqual(lease.status(), first);
});

test('input, returned storage and returned status cannot mutate internal lease data', () => {
  const input = options();
  const lease = createSessionLease(input);
  input.storageState.cookies[0].value = 'caller changed input';
  input.storageState.origins[0].localStorage[0].value = 'caller changed input';
  input.platform = 'douyin';
  const first = lease.getState('xiaohongshu');
  first.cookies[0].value = 'caller changed output';
  first.origins[0].localStorage.push({ name: 'injected', value: 'not internal' });
  first.origins[0].localStorage[0].value = 'caller changed output';
  lease.status().state = 'revoked';
  const second = lease.getState('xiaohongshu');
  assert.equal(second.cookies[0].value, SECRET);
  assert.deepEqual(second.origins[0].localStorage, [{ name: 'test-token', value: SECRET }]);
  assert.equal(lease.status().state, 'ready');
});

test('accepts normal Playwright flags, session cookies, subdomains and fractional future expiry', () => {
  const state = storage();
  state.cookies = ['Strict', 'Lax', 'None'].map((sameSite, i) => cookie('xiaohongshu', {
    name: `cookie_${i}`, sameSite, httpOnly: i === 0, secure: i !== 1,
    domain: i === 0 ? 'xiaohongshu.com' : i === 1 ? '.WWW.XIAOHONGSHU.COM' : 'a.b.xiaohongshu.com',
    expires: i === 2 ? START / 1000 + 0.5 : -1, value: i === 1 ? '' : SECRET,
  }));
  state.origins.push({ origin: 'https://a.b.xiaohongshu.com', localStorage: [{ name: '', value: 'Unicode 正文\n"\\' }] });
  const lease = createSessionLease(options({ storageState: state }));
  assert.equal(lease.getState('xiaohongshu').cookies[1].domain, '.www.xiaohongshu.com');
  assert.equal(lease.getState('xiaohongshu').cookies.length, 3);
});

test('rejects foreign and deceptive cookie domains and non-exact HTTPS origins', () => {
  for (const domain of ['douyin.com', '.douyin.com', 'evilxiaohongshu.com', 'xiaohongshu.com.evil.test', 'xiaohongshu.com.', '..xiaohongshu.com', 'https://xiaohongshu.com', '*.xiaohongshu.com', 'x..xiaohongshu.com', '-x.xiaohongshu.com']) {
    const state = storage(); state.cookies[0].domain = domain; rejects(() => createSessionLease(options({ storageState: state })));
  }
  for (const origin of ['http://www.xiaohongshu.com', 'https://www.xiaohongshu.com:8443', 'https://www.douyin.com', 'https://xiaohongshu.com.evil.test', 'https://www.xiaohongshu.com/', 'https://www.xiaohongshu.com/path', 'https://www.xiaohongshu.com?token=fake', 'https://www.xiaohongshu.com#hash', 'https://user:pass@www.xiaohongshu.com', 'https://*.xiaohongshu.com', 'https://WWW.XIAOHONGSHU.COM']) {
    const state = storage(); state.origins[0].origin = origin; rejects(() => createSessionLease(options({ storageState: state })));
  }
  const dyState = storage('douyin'); dyState.origins[0].origin = 'https://www.douyin.com:8443';
  rejects(() => createSessionLease(options({ platform: 'douyin', storageState: dyState })));
});

test('rejects expired cookies on input and conservatively ends the whole lease at the earliest cookie expiry', () => {
  for (const expires of [-2, 0, START / 1000 - 1, START / 1000, NaN, Infinity, '123']) {
    const state = storage(); state.cookies[0].expires = expires; rejects(() => createSessionLease(options({ storageState: state })));
  }
  let current = START;
  const state = storage();
  state.cookies.push(cookie('xiaohongshu', { name: 'longer_lived', expires: START / 1000 + 10 }));
  state.cookies.push(cookie('xiaohongshu', { name: 'short_lived', expires: START / 1000 + 1 }));
  const lease = createSessionLease(options({ storageState: state, now: () => current }));
  assert.equal(lease.status().expiresAt, START + 1000);
  assert.equal(lease.getState('xiaohongshu').cookies.length, 3);
  assert.equal(createSessionLease(options({ storageState: state, ttlMs: 500 })).status().expiresAt, START + 500);
  current += 1000;
  assert.deepEqual(lease.status(), { state: 'expired', platform: 'xiaohongshu', expiresAt: START + 1000 });
  rejects(() => lease.getState('xiaohongshu'), 'session_expired');
  current = START;
  rejects(() => lease.getState('xiaohongshu'), 'session_expired');
  assert.equal(lease.status().state, 'expired');
});

test('rejects partitioned cookies, unknown/missing fields and illegal scalar values', () => {
  const changes = [
    c => { c.partitionKey = 'https://xiaohongshu.com'; }, c => { c.extra = SECRET; },
    c => { delete c.sameSite; }, c => { c.sameSite = 'lax'; }, c => { c.httpOnly = 'false'; },
    c => { c.secure = 1; }, c => { c.name = ''; }, c => { c.name = 'bad;name'; },
    c => { c.value = 'bad\nvalue'; }, c => { c.path = 'no-leading-slash'; }, c => { c.value = null; },
  ];
  for (const change of changes) {
    const state = storage(); change(state.cookies[0]); rejects(() => createSessionLease(options({ storageState: state })));
  }
  for (const change of [
    s => { s.unexpected = true; }, s => { delete s.origins; }, s => { s.origins[0].indexedDB = []; },
    s => { s.origins[0].localStorage[0].extra = SECRET; }, s => { s.origins[0].localStorage[0].value = 1; },
    s => { s.cookies.push({ ...s.cookies[0] }); }, s => { s.origins.push({ ...s.origins[0] }); },
    s => { s.origins[0].localStorage.push({ ...s.origins[0].localStorage[0] }); },
  ]) {
    const state = storage(); change(state); rejects(() => createSessionLease(options({ storageState: state })));
  }
});

test('rejects unusual prototypes, symbols, sparse arrays, accessors and proxies without executing them', () => {
  let touched = 0;
  const unusual = options(); Object.setPrototypeOf(unusual, { inherited: true });
  rejects(() => createSessionLease(unusual));
  const property = options(); Object.defineProperty(property, 'storageState', { get() { touched++; throw Error(SECRET); }, enumerable: true });
  rejects(() => createSessionLease(property));
  const proxy = new Proxy(options(), { get() { touched++; throw Error(SECRET); }, ownKeys() { touched++; throw Error(SECRET); } });
  rejects(() => createSessionLease(proxy));
  for (const change of [
    s => { Object.setPrototypeOf(s.cookies[0], { injected: SECRET }); },
    s => { Object.defineProperty(s.cookies[0], 'value', { get() { touched++; throw Error(SECRET); }, enumerable: true }); },
    s => { s[Symbol('private')] = SECRET; },
    s => { Object.defineProperty(s, 'secret', { value: SECRET }); },
    s => { s.cookies.length = 2; },
    s => { s.cookies.extra = SECRET; },
    s => { Object.setPrototypeOf(s.cookies, {}); },
    s => { s.cookies[0] = new Proxy(s.cookies[0], { get() { touched++; throw Error(SECRET); } }); },
    s => { s.origins[0].localStorage[0] = new Date(); },
    s => { s.origins[0].localStorage = new Proxy([], {}); },
  ]) {
    const state = storage(); change(state); rejects(() => createSessionLease(options({ storageState: state })));
  }
  assert.equal(touched, 0);
  const nullPrototype = Object.assign(Object.create(null), storage());
  assert.equal(createSessionLease(options({ storageState: nullPrototype })).status().state, 'ready');
});

test('enforces 100 cookies, 50 total localStorage entries and exact 128 KiB serialized limit', () => {
  const state = storage();
  state.cookies = Array.from({ length: 100 }, (_, i) => cookie('xiaohongshu', { name: `c${i}` }));
  state.origins = [
    { origin: 'https://xiaohongshu.com', localStorage: Array.from({ length: 25 }, (_, i) => ({ name: `a${i}`, value: 'v' })) },
    { origin: 'https://www.xiaohongshu.com', localStorage: Array.from({ length: 25 }, (_, i) => ({ name: `b${i}`, value: 'v' })) },
  ];
  assert.equal(createSessionLease(options({ storageState: state })).getState('xiaohongshu').cookies.length, 100);
  state.cookies.push(cookie('xiaohongshu', { name: 'c100' })); rejects(() => createSessionLease(options({ storageState: state })));
  state.cookies.pop(); state.origins[1].localStorage.push({ name: 'b25', value: 'v' }); rejects(() => createSessionLease(options({ storageState: state })));
  const boundary = { cookies: [], origins: [{ origin: 'https://xiaohongshu.com', localStorage: [{ name: 'blob', value: '' }] }] };
  const baseBytes = Buffer.byteLength(JSON.stringify(boundary), 'utf8');
  boundary.origins[0].localStorage[0].value = 'x'.repeat(128 * 1024 - baseBytes);
  assert.equal(createSessionLease(options({ storageState: boundary })).status().state, 'ready');
  boundary.origins[0].localStorage[0].value += 'x'; rejects(() => createSessionLease(options({ storageState: boundary })));
  boundary.origins[0].localStorage[0].value = '\u0000'.repeat(30_000); rejects(() => createSessionLease(options({ storageState: boundary })));
  boundary.origins[0].localStorage[0].value = '中'.repeat(45_000); rejects(() => createSessionLease(options({ storageState: boundary })));
});

test('unexpected clocks fail with fixed codes and expired/revoked status never calls clock again', () => {
  let broken = false;
  const lease = createSessionLease(options({ now: () => { if (broken) throw Error(SECRET); return START; } }));
  broken = true; rejects(() => lease.status()); rejects(() => lease.getState('xiaohongshu'));
  assert.equal(lease.revoke().state, 'revoked');
  assert.equal(lease.status().state, 'revoked');
  rejects(() => lease.getState('xiaohongshu'), 'session_revoked');
});
