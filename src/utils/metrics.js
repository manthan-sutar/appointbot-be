/**
 * Lightweight in-process counters for observability (Phase 0).
 * For production, pipe these to your metrics backend or logs periodically.
 */

const counts = {
  webhook_messages: 0,
  llm_calls: 0,
  llm_successes: 0,
  llm_failures: 0,
  llm_timeouts: 0,
  llm_circuit_blocks: 0,
  llm_degraded_handling: 0,
  book_appointment_success: 0,
  slot_taken: 0,
};

export function inc(metric, delta = 1) {
  if (counts[metric] === undefined) return;
  counts[metric] += delta;
}

export function getMetricsSnapshot() {
  return { ...counts };
}

/** Reset all counters — tests only. */
export function resetMetricsForTests() {
  for (const k of Object.keys(counts)) counts[k] = 0;
}
