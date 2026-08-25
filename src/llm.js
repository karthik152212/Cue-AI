// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const crypto = require('crypto');
const { createCompatibleClientOptions } = require('./openai-compatible');

const CUSTOM_PROVIDER = 'custom';
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-2.5-flash is the model
// Google's own SDK examples standardize on and is documented as free-tier
// available, so it is the single default used everywhere in this file.
const CURRENT_GEMINI_DEFAULT = 'gemini-2.5-flash';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  azure: 'gpt-4o-mini'
};

// Gemini model ids that Google has since deprecated/retired. A settings file
// saved before this fix can still have one of these persisted on disk, so
// createLLM migrates them at read time rather than only fixing the default —
// otherwise an existing user would keep re-hitting the same 404 forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0)(?:-|$)/i;

const PROVIDER_LABELS = { azure: 'Azure AI Foundry', openai: 'OpenAI', minimax: 'MiniMax' };

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a rate-limit/quota failure instead of drifting independently.
function isQuotaError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 429 || code === 429 || code === 'insufficient_quota' || code === 'rate_limit_exceeded' ||
    code === 'RESOURCE_EXHAUSTED' || /quota|billing|rate limit|exceeded your current quota|resource_exhausted|too many requests/i.test(text);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function formatProviderErrorMessage(error, provider, model) {
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, endpoint }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const stream = await ai.models.generateContentStream({
    model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) {
        messages.push({ role: 'user', content: t.text, images: [img.b64] });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (e) {
        // ignore
      }
    }
  }
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (e) { }
  }
  return full;
}

// ---------------------------------------------------------------------------
// Multi-key rotation state.
//
// Tracks, in memory, which keys are currently rate-limited (temporarily cooled
// down) or were rejected (authentication failure) for a provider. Keys are stored
// only as short SHA-256 fingerprints so the actual secret never lives here and
// can never end up in a log, error string, or the rotation map itself. It is not
// persisted and resets whenever Cue restarts; a cooldown simply elapses, and the
// state is dropped when a key stops being configured (settings change).
// ---------------------------------------------------------------------------

const KEY_COOLDOWN_MS = 60 * 1000;          // a rate-limited key rests this long
const KEY_MAX_COOLDOWN_MS = 5 * 60 * 1000;  // provider-suggested retry delay caps here
const keyRotationState = new Map();         // `${provider}:${fp}` -> { permanent, until }

function fingerprintKey(key) {
  return crypto.createHash('sha256').update(String(key || '').trim()).digest('hex').slice(0, 24);
}

function isKeyPermanent(provider, key) {
  const rec = keyRotationState.get(provider + ':' + fingerprintKey(key));
  return !!(rec && rec.permanent);
}

function isKeyAvailable(provider, key) {
  const rec = keyRotationState.get(provider + ':' + fingerprintKey(key));
  if (!rec) return true;
  if (rec.permanent) return false;
  return rec.until <= Date.now();
}

function markKeyCooldown(provider, key, error) {
  const retrySeconds = extractRetryDelaySeconds(error && error.message);
  const delayMs = Math.max(KEY_COOLDOWN_MS, (retrySeconds || 0) * 1000);
  keyRotationState.set(provider + ':' + fingerprintKey(key), {
    permanent: false,
    until: Date.now() + Math.min(delayMs, KEY_MAX_COOLDOWN_MS)
  });
}

function markKeyUnavailable(provider, key) {
  // Rejected keys (401/403) stay out of rotation for the session. They are never
  // written out and vanish from the map as soon as settings stop listing the key.
  keyRotationState.set(provider + ':' + fingerprintKey(key), { permanent: true, until: 0 });
}

function resetKeyRotationState() {
  keyRotationState.clear();
}

// Drop rotation entries for keys that are no longer configured, so a settings
// change refreshes the available key pool on the very next request.
function refreshKeyRotationState(provider, poolKeys) {
  const prefix = provider + ':';
  const fingerprints = new Set((poolKeys || []).map(fingerprintKey));
  for (const entry of keyRotationState.keys()) {
    if (entry.startsWith(prefix) && !fingerprints.has(entry.slice(prefix.length))) {
      keyRotationState.delete(entry);
    }
  }
}

// Normalize the configured keys for a provider into a single ordered pool.
// Backward compatible: a legacy `apiKeys[provider]` string is the first key, and
// any `apiKeysExtra[provider]` entries are appended as fallbacks. Duplicate and
// blank values are dropped.
function getKeyPool(settings, provider) {
  const keys = settings.apiKeys || {};
  const extras = settings.apiKeysExtra || {};
  const pool = [];
  const add = (value) => {
    if (!value || typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || pool.includes(trimmed)) return;
    pool.push(trimmed);
  };
  add(keys[provider]);
  const extraList = Array.isArray(extras[provider]) ? extras[provider] : [];
  for (const value of extraList) add(value);
  return pool;
}

// Decide the order keys are tried this request. Rate-limited keys are skipped
// while an eligible key exists; if every configured key is currently cooled down
// they are still tried once each (a finite number of attempts) so the user gets
// a real provider error instead of a silent skip. If every key was previously
// rejected, no attempt is made — hammering known-bad keys is pointless.
function buildKeyAttempts(provider, attemptPool) {
  if (attemptPool.length <= 1) return attemptPool;
  if (attemptPool.every((a) => isKeyPermanent(provider, a.key))) return [];
  const available = attemptPool.filter((a) => isKeyAvailable(provider, a.key));
  return available.length ? available : attemptPool;
}

// The provider rejected the credential itself (as opposed to being out of quota).
function isAuthKeyError(error) {
  const status = error && (error.status || error.statusCode || error.response && error.response.status);
  const code = error && (error.code || error.error && error.error.code);
  const text = `${error && (error.message || String(error)) || ''} ${code || ''}`.toLowerCase();
  return status === 401 || status === 403 ||
    /invalid api key|api key not valid|invalid_api_key|authentication failed|incorrect api key|unauthorized/i.test(text);
}

// A provider-side outage (not the user's key): a 5xx, or an explicit capacity/
// over-capacity message. Worth falling back to another configured key.
function isTransientServerError(error) {
  const status = error && (error.status || error.statusCode || error.response && error.response.status);
  const text = String(error && (error.message || error) || '').toLowerCase();
  return status === 500 || status === 502 || status === 503 || status === 504 ||
    /server error|overloaded|temporarily unavailable|temporarily blocked|capacity|try again later/i.test(text);
}

function isRetryableKeyError(error) {
  return isQuotaError(error) || isTransientServerError(error);
}

function createLLM(settings) {
  const provider = settings.provider;
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini' && DEAD_GEMINI_MODEL_RE.test(model || '')) {
    model = CURRENT_GEMINI_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';
  let baseURL = '';

  // Multi-key pool: the legacy single `settings.apiKeys[provider]` value is the
  // first key; `apiKeysExtra[provider]` holds optional fallback keys.
  let poolKeys = getKeyPool(settings, provider);
  if (provider === CUSTOM_PROVIDER && !poolKeys.length) poolKeys = ['']; // keyless local endpoint
  if (provider === 'ollama' && !poolKeys.length) poolKeys = [((settings.apiKeys || {}).ollama) || ''];

  let configurationError = '';
  let attemptOptions = [];
  try {
    attemptOptions = poolKeys.map((key) => {
      if (provider === CUSTOM_PROVIDER) {
        const opts = createCompatibleClientOptions(key, settings.baseUrl);
        if (!baseURL) baseURL = opts.baseURL;
        return { key, opts: { apiKey: opts.apiKey, baseURL: opts.baseURL } };
      }
      return { key, opts: { apiKey: key } };
    });
  } catch (error) {
    configurationError = error.message;
  }

  if (provider === CUSTOM_PROVIDER && !model && !configurationError) {
    configurationError = 'Set a Fast or Smart model for the Custom provider.';
  } else if (provider !== CUSTOM_PROVIDER && provider !== 'ollama' && !poolKeys.length && !configurationError) {
    // Ollama holds a local-server URL and never needs a credential.
    configurationError = `Add your ${provider} API key in Settings.`;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  // A settings change drops rotation state for keys that are no longer listed.
  refreshKeyRotationState(provider, poolKeys);

  const ready = !configurationError && !!model;
  const maxTokens = settings.smart ? 1400 : 700;

  return {
    provider, model,
    baseURL,
    // First configured key; kept for the few callers that read .apiKey directly.
    get apiKey() { return poolKeys[0] || ''; },
    keyCount: poolKeys.length,
    ready,
    configurationError,
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const attempts = buildKeyAttempts(provider, attemptOptions);
      if (!attempts.length) {
        throw new Error(`${normalizeProviderName(provider)} API keys are all unavailable. Open Settings and check the configured API keys, then try again.`);
      }

      // Streaming-aware fallback: a key is only skipped when it has produced no
      // content yet. If tokens already reached the UI, switching keys mid-stream
      // would splice together output from two unrelated request contexts, so the
      // provider failure is surfaced instead of silently corrupting the answer.
      const { onToken: userOnToken, ...requestParams } = params;
      const emit = userOnToken || (() => {});
      let lastError = null;
      for (const attempt of attempts) {
        let emitted = false;
        try {
          const args = {
            apiKey: attempt.opts.apiKey,
            baseURL: attempt.opts.baseURL,
            endpoint, model, maxTokens,
            ...requestParams,
            turns: sanitizeTurns(requestParams.turns),
            onToken: (t) => { if (t) emitted = true; emit(t); }
          };
          if (provider === 'openai') return await streamOpenAI(args);
          if (provider === CUSTOM_PROVIDER) return await streamOpenAI(args);
          if (provider === 'ollama') return await streamOllama(args);
          if (provider === 'groq') return await streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
          if (provider === 'minimax') return await streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
          if (provider === 'anthropic') return await streamAnthropic(args);
          if (provider === 'gemini') return await streamGemini(args);
          if (provider === 'azure') return await streamAzure(args);
          throw new Error('unknown provider: ' + provider);
        } catch (error) {
          lastError = error;
          if (isAuthKeyError(error)) markKeyUnavailable(provider, attempt.key);
          if (isRetryableKeyError(error)) markKeyCooldown(provider, attempt.key, error);
          // A key that already started streaming must not hand off to another key —
          // joining partial text from a second context cannot produce a coherent
          // answer. Surface the provider's failure and let the UI decide.
          if (emitted) {
            throw new Error(formatProviderErrorMessage(error, provider, model));
          }
          // This was the last configured key; there is nothing left to rotate to.
          if (attempt === attempts[attempts.length - 1]) break;
          // Only provider/key-specific failures (auth rejection, rate limit /
          // quota, transient outage) justify moving to the next key. A bad model
          // or malformed request fails identically on every key, so stop rather
          // than spin through the rest.
          if (!isAuthKeyError(error) && !isRetryableKeyError(error)) break;
          continue; // finite: at most attempts.length rotations, never a loop
        }
      }
      throw new Error(formatProviderErrorMessage(lastError || new Error('Unknown LLM error.'), provider, model));
    }
  };
}

module.exports = {
  createLLM,
  formatProviderErrorMessage,
  isQuotaError,
  CURRENT_GEMINI_DEFAULT,
  // Exported for unit tests and diagnostics (not part of the public API contract).
  getKeyPool,
  buildKeyAttempts,
  isRetryableKeyError,
  isAuthKeyError,
  isTransientServerError,
  isKeyAvailable,
  isKeyPermanent,
  markKeyCooldown,
  markKeyUnavailable,
  resetKeyRotationState,
  refreshKeyRotationState
};
