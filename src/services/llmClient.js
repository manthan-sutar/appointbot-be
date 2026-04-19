import 'dotenv/config';
import { formatCorrelationPrefix } from '../context/correlation.js';
import { inc } from '../utils/metrics.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

function getTimeoutMs() {
  return Math.max(3000, parseInt(process.env.LLM_TIMEOUT_MS || '20000', 10));
}
function getMaxRetries() {
  return Math.max(0, parseInt(process.env.LLM_MAX_RETRIES || '2', 10));
}
function getCircuitFailureThreshold() {
  return Math.max(1, parseInt(process.env.LLM_CIRCUIT_FAILURE_THRESHOLD || '5', 10));
}
function getCircuitCooldownMs() {
  return Math.max(1000, parseInt(process.env.LLM_CIRCUIT_COOLDOWN_MS || '60000', 10));
}

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export class LLMCircuitOpenError extends Error {
  constructor() {
    super('LLM circuit open — too many recent failures');
    this.name = 'LLMCircuitOpenError';
  }
}

function recordCircuitSuccess() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordCircuitFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= getCircuitFailureThreshold()) {
    circuitOpenUntil = Date.now() + getCircuitCooldownMs();
  }
}

/** True while the circuit prevents outbound LLM calls. */
export function isLlmCircuitOpen() {
  if (Date.now() < circuitOpenUntil) return true;
  if (circuitOpenUntil && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
  }
  return false;
}

export function resetLlmCircuitForTests() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

/**
 * Skip LLM calls: manual `LLM_DEGRADED=1|true` or circuit open after repeated failures.
 * ai.service.js uses this for keyword/rule fallbacks (Phase 1 degraded mode).
 */
export function isLlmDegraded() {
  const v = process.env.LLM_DEGRADED;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return isLlmCircuitOpen();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(err, httpStatus) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  if (typeof httpStatus === 'number') {
    if (httpStatus === 429) return true;
    if (httpStatus >= 500 && httpStatus <= 599) return true;
  }
  if (err && typeof err.message === 'string') {
    const m = err.message.toLowerCase();
    if (m.includes('fetch failed') || m.includes('network') || m.includes('econnreset') || m.includes('etimedout')) {
      return true;
    }
  }
  return false;
}

async function fetchWithTimeout(url, options, timeoutMs = getTimeoutMs()) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callGroq(messages, temperature) {
  const res = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature }),
    },
    getTimeoutMs(),
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || 'Groq error';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data.choices?.[0]?.message?.content || '';
}

async function callOllama(fullPrompt) {
  const res = await fetchWithTimeout(
    `${OLLAMA_URL}/api/generate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: fullPrompt, stream: false }),
    },
    getTimeoutMs(),
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'Ollama error');
    err.status = res.status;
    throw err;
  }
  return data.response || '';
}

/**
 * Central LLM call: timeout, retries on transient errors, circuit breaker.
 * Signature matches previous ai.service inline helper.
 */
export async function callLLM(prompt, { temperature = 0, systemPrompt = null } = {}) {
  if (isLlmCircuitOpen()) {
    inc('llm_circuit_blocks');
    throw new LLMCircuitOpenError();
  }

  inc('llm_calls');
  let lastErr = null;
  const maxRetries = getMaxRetries();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = 300 * 2 ** (attempt - 1);
      await sleep(backoff);
    }

    try {
      let text;
      if (GROQ_API_KEY) {
        const messages = systemPrompt
          ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }];
        text = await callGroq(messages, temperature);
      } else {
        const fullPrompt = systemPrompt ? `SYSTEM:\n${systemPrompt}\n\nUSER:\n${prompt}`.trim() : prompt;
        text = await callOllama(fullPrompt);
      }
      recordCircuitSuccess();
      inc('llm_successes');
      return text;
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      if (err?.name === 'AbortError') inc('llm_timeouts');

      const retry = isRetryableError(err, status) && attempt < maxRetries;
      const p = formatCorrelationPrefix();
      if (!retry) {
        if (process.env.NODE_ENV !== 'production') {
          console.error(`${p}[LLM] call failed after ${attempt + 1} attempt(s):`, err.message || err);
        }
        break;
      }
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`${p}[LLM] retry ${attempt + 1}/${maxRetries}:`, err.message || err);
      }
    }
  }

  recordCircuitFailure();
  inc('llm_failures');
  throw lastErr || new Error('LLM call failed');
}
