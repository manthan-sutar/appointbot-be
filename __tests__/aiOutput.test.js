import { describe, test, expect } from '@jest/globals';
import {
  parseBookingIntent,
  parseClassifyMessage,
  parseRescheduleIntent,
  parseAvailabilityQuery,
  normalizeDateOrNull,
  normalizeTimeOrNull,
} from '../src/validation/aiOutput.js';

describe('aiOutput validation', () => {
  test('parseBookingIntent rejects past dates vs today', () => {
    const out = parseBookingIntent(
      { service: 'x', date: '2020-01-01', time: '10:00', staffName: null },
      { today: '2026-04-18' },
    );
    expect(out.date).toBeNull();
    expect(out.time).toBe('10:00');
  });

  test('parseBookingIntent normalizes time padding', () => {
    const out = parseBookingIntent(
      { service: null, date: '2026-04-20', time: '9:5', staffName: null },
      { today: '2026-04-18' },
    );
    expect(out.time).toBeNull(); // invalid minute
  });

  test('normalizeTimeOrNull accepts HH:MM', () => {
    expect(normalizeTimeOrNull('09:30')).toBe('09:30');
    expect(normalizeTimeOrNull('25:00')).toBeNull();
  });

  test('parseClassifyMessage coerces intent', () => {
    expect(parseClassifyMessage({ handoff: false, intent: 'BOOK' }).intent).toBe('book');
    expect(parseClassifyMessage({ handoff: true, intent: 'nope' }).intent).toBe('none');
  });

  test('parseAvailabilityQuery week defaults', () => {
    const q = parseAvailabilityQuery({ type: 'week' }, { today: '2026-04-18', weekEnd: '2026-04-24' });
    expect(q.type).toBe('week');
    expect(q.weekStart).toBe('2026-04-18');
  });
});
