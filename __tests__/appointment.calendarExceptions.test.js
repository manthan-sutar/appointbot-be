import { describe, test, expect, beforeEach, beforeAll, afterAll, jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
  query: mockQuery,
  getClient: jest.fn(),
}));

const { getAvailableSlots } = await import('../src/services/appointment.service.js');

describe('getAvailableSlots + business_calendar_exceptions', () => {
  beforeAll(() => {
    jest.useFakeTimers({ advanceTimers: true });
    jest.setSystemTime(new Date('2099-01-10T12:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('closed exception returns no slots (no further queries needed)', async () => {
    mockQuery.mockImplementation((sql) => {
      if (String(sql).includes('business_calendar_exceptions')) {
        return { rows: [{ closed: true, open_start: null, open_end: null }] };
      }
      return { rows: [] };
    });

    const slots = await getAvailableSlots(1, '2099-02-01', 99, 30, 'Asia/Kolkata');
    expect(slots).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('business_calendar_exceptions');
  });

  test('custom hours intersect staff window', async () => {
    mockQuery.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('business_calendar_exceptions')) {
        return {
          rows: [{ closed: false, open_start: '10:00:00', open_end: '14:00:00' }],
        };
      }
      if (s.includes('FROM availability')) {
        return { rows: [{ start_time: '10:00', end_time: '19:00' }] };
      }
      if (s.includes('FROM appointments')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const slots = await getAvailableSlots(1, '2099-02-01', 1, 30, 'Asia/Kolkata');
    expect(slots[0]).toBe('10:00');
    expect(slots[slots.length - 1]).toBe('13:30');
    expect(slots.length).toBe(8);
  });

  test('no exception row uses staff availability only', async () => {
    mockQuery.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('business_calendar_exceptions')) {
        return { rows: [] };
      }
      if (s.includes('FROM availability')) {
        return { rows: [{ start_time: '10:00', end_time: '12:00' }] };
      }
      if (s.includes('FROM appointments')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const slots = await getAvailableSlots(1, '2099-02-01', 1, 30, 'Asia/Kolkata');
    expect(slots).toEqual(['10:00', '10:30', '11:00', '11:30']);
  });
});
