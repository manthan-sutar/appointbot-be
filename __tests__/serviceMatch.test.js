import { describe, test, expect } from '@jest/globals';
import {
  levenshtein,
  matchServiceFromMessage,
  matchServicesFromMessage,
  aggregateMatchedServices,
  segmentServiceMessage,
  stripBookingPrefix,
} from '../src/utils/serviceMatch.js';

const demoServices = [
  { id: 1, name: 'Beard trim', duration_minutes: 20, price: 199 },
  { id: 2, name: 'Facial', duration_minutes: 60, price: 1299 },
  { id: 3, name: 'Hair colour', duration_minutes: 90, price: 2499 },
  { id: 4, name: 'Haircut', duration_minutes: 30, price: 399 },
];

describe('levenshtein', () => {
  test('identical strings', () => {
    expect(levenshtein('beard', 'beard')).toBe(0);
  });
  test('one edit', () => {
    expect(levenshtein('beared', 'beard')).toBe(1);
  });
});

describe('matchServiceFromMessage', () => {
  test('matches numeric index 1-based', () => {
    expect(matchServiceFromMessage('1', demoServices)?.name).toBe('Beard trim');
    expect(matchServiceFromMessage('4', demoServices)?.name).toBe('Haircut');
  });

  test('matches typo beared trim → Beard trim', () => {
    expect(matchServiceFromMessage('beared trim', demoServices)?.name).toBe('Beard trim');
  });

  test('matches normal phrase beard trim', () => {
    expect(matchServiceFromMessage('beard trim', demoServices)?.name).toBe('Beard trim');
  });

  test('returns null for unrelated text', () => {
    expect(matchServiceFromMessage('pizza party', demoServices)).toBeNull();
  });
});

describe('matchServicesFromMessage', () => {
  test('parses please book, typos, commas, and', () => {
    const msg = 'please book, beard trup , facial and haircut.';
    const m = matchServicesFromMessage(msg, demoServices);
    expect(m?.map((s) => s.name)).toEqual(['Beard trim', 'Facial', 'Haircut']);
  });

  test('numeric 1 2 4', () => {
    const m = matchServicesFromMessage('1 2 4', demoServices);
    expect(m?.map((s) => s.name)).toEqual(['Beard trim', 'Facial', 'Haircut']);
  });

  test('deduplicates same service twice', () => {
    const m = matchServicesFromMessage('1, 1', demoServices);
    expect(m?.length).toBe(1);
    expect(m?.[0].name).toBe('Beard trim');
  });

  test('returns null if any segment unknown', () => {
    expect(matchServicesFromMessage('facial and xyzservice', demoServices)).toBeNull();
  });
});

describe('aggregateMatchedServices', () => {
  test('sums duration and price for multi', () => {
    const m = matchServicesFromMessage('beard trim and haircut', demoServices);
    expect(m).not.toBeNull();
    const agg = aggregateMatchedServices(m);
    expect(agg.durationMinutes).toBe(20 + 30);
    expect(agg.price).toBe(199 + 399);
    expect(agg.notes).toMatch(/Combined booking:/);
    expect(agg.serviceName).toBe('Beard trim, Haircut');
  });

  test('single service has no combined notes', () => {
    const one = [demoServices[0]];
    const agg = aggregateMatchedServices(one);
    expect(agg.notes).toBeNull();
  });
});

describe('segmentServiceMessage', () => {
  test('stripBookingPrefix removes leading please book', () => {
    expect(stripBookingPrefix('please book, facial')).toBe('facial');
  });

  test('splits on comma and and', () => {
    expect(segmentServiceMessage('please book, beard trim and facial')).toEqual(['beard trim', 'facial']);
  });
});
