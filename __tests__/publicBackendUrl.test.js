import { describe, test, expect } from '@jest/globals';
import { internalWebhookBaseUrl } from '../src/utils/publicBackendUrl.js';

describe('internalWebhookBaseUrl', () => {
  test('uses loopback when Host is Vite dev server (5173)', () => {
    const req = {
      get: (h) => (h === 'host' ? 'localhost:5173' : undefined),
      protocol: 'http',
    };
    process.env.PORT = '3000';
    expect(internalWebhookBaseUrl(req)).toBe('http://127.0.0.1:3000');
  });

  test('uses loopback for Vite 5175', () => {
    const req = {
      get: (h) => (h === 'host' ? '127.0.0.1:5175' : undefined),
      protocol: 'http',
    };
    process.env.PORT = '3000';
    expect(internalWebhookBaseUrl(req)).toBe('http://127.0.0.1:3000');
  });

  test('preserves public host when not Vite dev port', () => {
    const req = {
      get: (h) => (h === 'host' ? 'localhost:3000' : undefined),
      protocol: 'http',
    };
    expect(internalWebhookBaseUrl(req)).toBe('http://localhost:3000');
  });
});
