import { describe, test, expect, beforeEach } from '@jest/globals';
import { normalizePhone, STATES } from '../src/services/session.service.js';

describe('Session Service - Phone Normalization', () => {
  test('should remove whatsapp: prefix', () => {
    expect(normalizePhone('whatsapp:+15551234567')).toBe('+15551234567');
    expect(normalizePhone('WhatsApp:+15551234567')).toBe('+15551234567');
  });

  test('should trim whitespace', () => {
    expect(normalizePhone('  +15551234567  ')).toBe('+15551234567');
  });

  test('should handle plain phone numbers', () => {
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
    expect(normalizePhone('15551234567')).toBe('15551234567');
  });
});

describe('Session Service - States', () => {
  test('should have all required states defined', () => {
    expect(STATES.IDLE).toBe('IDLE');
    expect(STATES.AWAITING_SERVICE).toBe('AWAITING_SERVICE');
    expect(STATES.AWAITING_DATE).toBe('AWAITING_DATE');
    expect(STATES.AWAITING_TIME).toBe('AWAITING_TIME');
    expect(STATES.AWAITING_NAME).toBe('AWAITING_NAME');
    expect(STATES.AWAITING_CONFIRMATION).toBe('AWAITING_CONFIRMATION');
    expect(STATES.AWAITING_CANCEL_WHICH).toBe('AWAITING_CANCEL_WHICH');
    expect(STATES.AWAITING_RESCHEDULE_WHICH).toBe('AWAITING_RESCHEDULE_WHICH');
    expect(STATES.AWAITING_RESCHEDULE_DATE).toBe('AWAITING_RESCHEDULE_DATE');
    expect(STATES.AWAITING_RESCHEDULE_TIME).toBe('AWAITING_RESCHEDULE_TIME');
    expect(STATES.AWAITING_RESCHEDULE_CONFIRM).toBe('AWAITING_RESCHEDULE_CONFIRM');
    expect(STATES.AWAITING_HANDOFF).toBe('AWAITING_HANDOFF');
  });

  test('should have unique state values', () => {
    const stateValues = Object.values(STATES);
    const uniqueValues = new Set(stateValues);
    expect(uniqueValues.size).toBe(stateValues.length);
  });
});
