import { describe, test, expect, beforeEach } from '@jest/globals';
import { resetMetricsForTests } from '../src/utils/metrics.js';
import {
  classifyMessageDegraded,
  extractBookingIntentDegraded,
  extractGlobalIntentDegraded,
} from '../src/services/aiDegraded.js';

describe('aiDegraded', () => {
  beforeEach(() => resetMetricsForTests());

  test('classifyMessageDegraded: book and cancel', () => {
    expect(classifyMessageDegraded('I want to book a haircut', []).intent).toBe('book');
    expect(classifyMessageDegraded('cancel my appointment', []).intent).toBe('cancel');
    expect(classifyMessageDegraded('please cancel it', []).intent).toBe('cancel');
    expect(classifyMessageDegraded('could u please cancel my booking', []).intent).toBe('cancel');
    expect(classifyMessageDegraded('reschedule to Friday', []).intent).toBe('reschedule');
    expect(classifyMessageDegraded('remind me at 7pm', []).intent).toBe('reminder');
    expect(classifyMessageDegraded('show my bookings', []).intent).toBe('my_appointments');
  });

  test('classifyMessageDegraded: service name substring', () => {
    expect(classifyMessageDegraded('Can I get a Facial tomorrow?', ['Facial', 'Haircut']).intent).toBe('book');
  });

  test('extractBookingIntentDegraded: tomorrow + time', () => {
    const out = extractBookingIntentDegraded('haircut tomorrow at 3pm', ['Haircut'], 'Asia/Kolkata');
    expect(out.service).toBe('Haircut');
    expect(out.time).toBe('15:00');
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('extractBookingIntentDegraded: typo tomorrow + haricut', () => {
    const out = extractBookingIntentDegraded('tommotow haricut appointment 10 am morning please', ['Haircut'], 'Asia/Kolkata');
    expect(out.service).toBe('Haircut');
    expect(out.time).toBe('10:00');
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('extractGlobalIntentDegraded matches classify intent', () => {
    expect(extractGlobalIntentDegraded('help', [])).toBe('help');
  });
});
