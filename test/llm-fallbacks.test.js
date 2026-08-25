// Unit tests for the multi-key fallback/rotation logic in src/llm.js.
// The OpenAI SDK is stubbed so no network access is required.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const originalModuleLoad = Module._load;

// behavior per API-key literal (key string -> behavior name).
// A key with no entry in `behaviors` always succeeds (returns a token).
const active = { behaviors: {}, calledKeys: [] };

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

class FakeOpenAI {
  constructor(opts) {
    active.calledKeys.push(opts && opts.apiKey);
    this.apiKey = (opts && opts.apiKey) || '';
  }
  get chat() {
    const self = this;
    return {
      completions: {
        create: async () => {
          const behavior = active.behaviors[self.apiKey] || 'ok';
          if (behavior === '429') throw httpError('429 Too Many Requests', 429);
          if (behavior === '401') throw httpError('Incorrect API key provided', 401);
          if (behavior === '400') throw httpError('Bad request: malformed', 400);
          if (behavior === '500') throw httpError('internal server error', 500);
          if (behavior === 'partial-429') {
            const leakedKey = self.apiKey;
            return (async function* gen() {
              yield { choices: [{ delta: { content: 'partial-' + leakedKey } }] };
              throw httpError('429 Too Many Requests', 429);
            })();
          }
          return [{ choices: [{ delta: { content: 'ok' } }] }];
        }
      }
    };
  }
}

Module._load = function loadWithStub(request) {
  if (request === 'openai') {
    const proxy = new Proxy(FakeOpenAI, {
      construct(target, args) { return new target(args[0]); }
    });
    return proxy;
  }
  return originalModuleLoad.apply(this, arguments);
};

const {
  createLLM, getKeyPool, buildKeyAttempts, resetKeyRotationState,
  isKeyAvailable, markKeyCooldown, refreshKeyRotationState
} = require('../src/llm');

test.after(() => { Module._load = originalModuleLoad; });

function openaiSettings(primary, extras) {
  return {
    provider: 'openai', smart: false, baseUrl: '',
    apiKeys: { openai: primary, anthropic: '', gemini: '', custom: '', groq: '', minimax: '', azure: '', ollama: '', deepgram: '' },
    apiKeysExtra: { openai: extras || [], anthropic: [], gemini: [], custom: [], groq: [], minimax: [], ollama: [], azure: [], deepgram: [] },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  };
}

async function stream(primary, extras) {
  const s = openaiSettings(primary, extras);
  active.calledKeys = [];
  const onToken = [];
  const res = await createLLM(s).stream({
    system: '', turns: [{ role: 'user', text: 'hi' }],
    onToken: (t) => onToken.push(t)
  });
  return { res, keys: active.calledKeys.slice(), tokens: onToken.slice() };
}

test.beforeEach(() => {
  active.behaviors = {};
  active.calledKeys = [];
  resetKeyRotationState();
});

test('1. single-key backward compatibility', () => {
  const s = openaiSettings('sk-1');
  assert.equal(getKeyPool(s, 'openai').length, 1);
  assert.equal(getKeyPool(s, 'openai')[0], 'sk-1');
  const llmInstance = createLLM(s);
  assert.equal(llmInstance.keyCount, 1);
  assert.equal(llmInstance.apiKey, 'sk-1');
});

test('2. multiple keys normalize correctly (dedupe + blank drop)', () => {
  const s = openaiSettings('k1', ['k1', '', '  ', 'k2', 'k1', 'k3']);
  const pool = getKeyPool(s, 'openai');
  assert.deepEqual(pool, ['k1', 'k2', 'k3']);
});

test('3. first key succeeds - no unnecessary retries', async () => {
  active.behaviors = { 'sk-main': 'ok', 'sk-fallback': 'ok' };
  const { res, keys } = await stream('sk-main', ['sk-fallback']);
  assert.deepEqual(keys, ['sk-main']);
  assert.equal(res, 'ok');
  assert.equal(keys.length, 1);
});

test('4. first key returns 429 -> second key succeeds', async () => {
  active.behaviors = { 'sk-a': '429', 'sk-b': 'ok' };
  const { res, keys } = await stream('sk-a', ['sk-b']);
  assert.deepEqual(keys, ['sk-a', 'sk-b']);
  assert.equal(res, 'ok');
});

test('5. first two keys return 429 -> third key succeeds', async () => {
  active.behaviors = { 'sk-a': '429', 'sk-b': '429', 'sk-c': 'ok' };
  const { res, keys } = await stream('sk-a', ['sk-b', 'sk-c']);
  assert.deepEqual(keys, ['sk-a', 'sk-b', 'sk-c']);
  assert.equal(res, 'ok');
});

test('6. all keys fail with 429 -> final error (no infinite loop)', async () => {
  active.behaviors = { 'sk-a': '429', 'sk-b': '429' };
  let caught = null;
  let res = null;
  try {
    res = await stream('sk-a', ['sk-b']).then((r) => r.res);
  } catch (e) { caught = e; }
  assert.notEqual(caught, null);
  assert.deepEqual(active.calledKeys, ['sk-a', 'sk-b']);
  assert.equal(res, null);
});

test('7. invalid/auth errors do not cause infinite retries', async () => {
  active.behaviors = { 'sk-a': '401', 'sk-b': '401' };
  let caught = null;
  try {
    await stream('sk-a', ['sk-b']);
  } catch (e) { caught = e; }
  assert.notEqual(caught, null);
  assert.deepEqual(active.calledKeys, ['sk-a', 'sk-b']);
});

test('7b. auth-rejected key is skipped on subsequent requests', async () => {
  active.behaviors = { 'sk-a': '401', 'sk-b': 'ok' };
  active.calledKeys = [];
  const s = openaiSettings('sk-a', ['sk-b']);
  await createLLM(s).stream({ system: '', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  // Fresh request must not retry the permanently-rejected key.
  active.calledKeys = [];
  const res = await createLLM(s).stream({ system: '', turns: [{ role: 'user', text: 'x' }], onToken: () => {} });
  assert.deepEqual(active.calledKeys, ['sk-b']);
  assert.equal(res, 'ok');
});

test('8. key cooldown / temporary unavailable state', async () => {
  active.behaviors = { 'sk-a': '429', 'sk-b': 'ok' };
  await stream('sk-a', ['sk-b']);
  assert.equal(isKeyAvailable('openai', 'sk-a'), false);
  assert.equal(isKeyAvailable('openai', 'sk-b'), true);
  const pool = getKeyPool(openaiSettings('sk-a', ['sk-b']), 'openai');
  const attempts = buildKeyAttempts('openai', pool.map((k) => ({ key: k, opts: { apiKey: k } })));
  assert.deepEqual(attempts.map((a) => a.key), ['sk-b']);
});

test('9. settings change refreshes the available key pool', () => {
  markKeyCooldown('openai', 'sk-gone', httpError('429 Too Many Requests', 429));
  assert.equal(isKeyAvailable('openai', 'sk-gone'), false);
  refreshKeyRotationState('openai', ['sk-stays']);
  assert.equal(isKeyAvailable('openai', 'sk-gone'), true);
  assert.equal(isKeyAvailable('openai', 'sk-stays'), true);
});

test('10. API key values never appear in error messages', async () => {
  active.behaviors = { 'super-secret-key-123': '429' };
  const s = openaiSettings('super-secret-key-123', []);
  let caught = null;
  try {
    await createLLM(s).stream({ system: '', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  } catch (e) { caught = e; }
  assert.notEqual(caught, null);
  assert.equal(caught.message.includes('super-secret-key-123'), false);
});

test('streaming partial content is not concatenated across keys', async () => {
  // First key emits one token then 429 — must NOT continue onto a second key,
  // which would splice two unrelated contexts into a single answer.
  active.behaviors = { 'sk-a': 'partial-429', 'sk-b': 'ok' };
  active.calledKeys = [];
  const onToken = [];
  const s = openaiSettings('sk-a', ['sk-b']);
  let caught = null;
  try {
    await createLLM(s).stream({ system: '', turns: [{ role: 'user', text: 'hi' }], onToken: (t) => onToken.push(t) });
  } catch (e) { caught = e; }
  assert.deepEqual(active.calledKeys, ['sk-a']);
  assert.equal(onToken.length, 1);
  assert.equal(onToken[0], 'partial-sk-a');
});
