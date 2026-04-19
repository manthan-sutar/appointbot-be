import { describe, test, expect } from '@jest/globals';
import { specifiesNewBookingServices } from '../src/utils/conversationRepair.js';

const demoServices = [
  { id: 1, name: 'Beard trim', duration_minutes: 20 },
  { id: 2, name: 'Facial', duration_minutes: 60 },
  { id: 3, name: 'Hair colour', duration_minutes: 90 },
  { id: 4, name: 'Haircut', duration_minutes: 30 },
];

describe('specifiesNewBookingServices', () => {
  test('true when book again is followed by for + services', () => {
    const msg =
      'I would like to book again on tuesday, 11 am, for facial, haircolor and haircut';
    expect(specifiesNewBookingServices(msg, demoServices)).toBe(true);
  });

  test('false for bare repeat phrasing', () => {
    expect(specifiesNewBookingServices('book again same as last', demoServices)).toBe(false);
  });

  test('true when catalog name appears (substring)', () => {
    expect(
      specifiesNewBookingServices('book again tomorrow for a facial please', demoServices),
    ).toBe(true);
  });
});
