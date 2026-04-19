import { describe, test, expect } from '@jest/globals';
import {
  stripCorrectionPrefix,
  normalizeRelativeDateTypos,
  normalizeCasualServiceTypos,
  extractFallbackRelativeDate,
} from '../src/utils/conversationRepair.js';

describe('stripCorrectionPrefix', () => {
  test('returns empty for empty input', () => {
    expect(stripCorrectionPrefix('')).toEqual({ cleaned: '', hadCorrection: false });
    expect(stripCorrectionPrefix('   ')).toEqual({ cleaned: '', hadCorrection: false });
  });

  test('strips leading correction phrases', () => {
    expect(stripCorrectionPrefix('Actually Tuesday')).toEqual({
      cleaned: 'Tuesday',
      hadCorrection: true,
    });
    expect(stripCorrectionPrefix('I meant 10am')).toEqual({
      cleaned: '10am',
      hadCorrection: true,
    });
    expect(stripCorrectionPrefix('Sorry, 3pm')).toEqual({
      cleaned: '3pm',
      hadCorrection: true,
    });
    expect(stripCorrectionPrefix('Wait — haircut')).toEqual({
      cleaned: 'haircut',
      hadCorrection: true,
    });
  });

  test('strips trailing instead / rather', () => {
    expect(stripCorrectionPrefix('Tuesday instead')).toEqual({
      cleaned: 'Tuesday',
      hadCorrection: true,
    });
    expect(stripCorrectionPrefix('10am rather.')).toEqual({
      cleaned: '10am',
      hadCorrection: true,
    });
  });

  test('leaves normal messages unchanged', () => {
    expect(stripCorrectionPrefix('tomorrow at 2')).toEqual({
      cleaned: 'tomorrow at 2',
      hadCorrection: false,
    });
  });
});

describe('normalizeRelativeDateTypos', () => {
  test('fixes common tomorrow typos', () => {
    expect(normalizeRelativeDateTypos('tommorow at 10')).toBe('tomorrow at 10');
    expect(normalizeRelativeDateTypos('tomorow morning 10 am')).toBe('tomorrow morning 10 am');
    expect(normalizeRelativeDateTypos('tommorrow')).toBe('tomorrow');
    expect(normalizeRelativeDateTypos('tommotow haricut')).toBe('tomorrow haricut');
  });
});

describe('normalizeCasualServiceTypos', () => {
  test('fixes beard trip → beard trim', () => {
    expect(normalizeCasualServiceTypos('beard trip and facial')).toBe('beard trim and facial');
  });

  test('fixes haricut → haircut', () => {
    expect(normalizeCasualServiceTypos('tommotow haricut')).toBe('tommotow haircut');
  });
});

describe('extractFallbackRelativeDate', () => {
  test('returns tomorrow in TZ when word tomorrow present', () => {
    const tz = 'Asia/Kolkata';
    const d = extractFallbackRelativeDate('tomorrow at 10', tz);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const [y, m, day] = today.split('-').map(Number);
    const expected = new Date(Date.UTC(y, m - 1, day, 12, 0, 0) + 86400000).toLocaleDateString('en-CA', {
      timeZone: tz,
    });
    expect(d).toBe(expected);
  });

  test('returns null when no relative day', () => {
    expect(extractFallbackRelativeDate('Friday please', 'Asia/Kolkata')).toBeNull();
  });
});
