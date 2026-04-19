import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  callLLM,
  resetLlmCircuitForTests,
  isLlmCircuitOpen,
  LLMCircuitOpenError,
} from '../src/services/llmClient.js';

const originalFetch = global.fetch;
const originalGroqKey = process.env.GROQ_API_KEY;
const originalMaxRetries = process.env.LLM_MAX_RETRIES;
const originalCircuitThresh = process.env.LLM_CIRCUIT_FAILURE_THRESHOLD;

describe('llmClient', () => {
  beforeEach(() => {
    resetLlmCircuitForTests();
    process.env.GROQ_API_KEY = 'test-key-for-jest';
    process.env.LLM_MAX_RETRIES = '2';
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '5';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
    if (originalMaxRetries === undefined) delete process.env.LLM_MAX_RETRIES;
    else process.env.LLM_MAX_RETRIES = originalMaxRetries;
    if (originalCircuitThresh === undefined) delete process.env.LLM_CIRCUIT_FAILURE_THRESHOLD;
    else process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = originalCircuitThresh;
  });

  test('retries on 502 then succeeds', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: { message: 'bad gateway' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
      };
    });

    const text = await callLLM('ping', { temperature: 0 });
    expect(text).toBe('hello');
    expect(n).toBe(2);
  });

  test('opens circuit after threshold failures', async () => {
    process.env.LLM_MAX_RETRIES = '0';
    process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '2';

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'unavailable' } }),
    }));

    await expect(callLLM('a')).rejects.toThrow();
    await expect(callLLM('b')).rejects.toThrow();
    expect(isLlmCircuitOpen()).toBe(true);
    await expect(callLLM('c')).rejects.toThrow(LLMCircuitOpenError);
  });
});
