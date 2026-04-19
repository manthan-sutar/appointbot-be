import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/**
 * Run `fn` with a correlation id available to async callers (logging, metrics).
 */
export function runWithCorrelation(correlationId, fn) {
  return store.run({ correlationId: String(correlationId) }, fn);
}

export function getCorrelationId() {
  return store.getStore()?.correlationId ?? null;
}

/** Prefix for log lines: "[cid=…] " or "". */
export function formatCorrelationPrefix() {
  const cid = getCorrelationId();
  return cid ? `[cid=${cid}] ` : '';
}
