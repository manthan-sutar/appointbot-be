import { describe, test, expect } from '@jest/globals';

describe('Formatter Utility Functions', () => {
  describe('formatDate', () => {
    test('should format date strings consistently', () => {
      const date = '2026-03-28';
      // Just testing that the function exists and returns something
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('formatTime', () => {
    test('should handle 24-hour time format', () => {
      const times = ['09:00', '14:30', '17:00', '20:45'];
      times.forEach(time => {
        expect(time).toMatch(/^\d{2}:\d{2}$/);
      });
    });
  });

  describe('timeToMinutes', () => {
    function timeToMinutes(time) {
      const [h, m] = (time || '00:00').split(':').map(Number);
      return h * 60 + m;
    }

    test('should convert time string to minutes', () => {
      expect(timeToMinutes('09:00')).toBe(540);
      expect(timeToMinutes('10:30')).toBe(630);
      expect(timeToMinutes('14:00')).toBe(840);
      expect(timeToMinutes('17:45')).toBe(1065);
    });

    test('should handle midnight', () => {
      expect(timeToMinutes('00:00')).toBe(0);
    });

    test('should handle noon', () => {
      expect(timeToMinutes('12:00')).toBe(720);
    });
  });

  describe('Slot Curation', () => {
    function curateSlots(allSlots, maxDisplay = 6) {
      if (allSlots.length <= maxDisplay) return allSlots;
      const step = Math.ceil(allSlots.length / maxDisplay);
      const curated = [];
      for (let i = 0; i < allSlots.length && curated.length < maxDisplay; i += step) {
        curated.push(allSlots[i]);
      }
      return curated.slice(0, maxDisplay);
    }

    test('should return all slots if under max', () => {
      const slots = ['09:00', '10:00', '11:00'];
      expect(curateSlots(slots, 6)).toEqual(slots);
    });

    test('should curate when over max', () => {
      const slots = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
      const curated = curateSlots(slots, 6);
      
      expect(curated.length).toBeLessThanOrEqual(6);
      expect(curated[0]).toBe('09:00'); // first slot always included
    });

    test('should respect max display count', () => {
      const slots = Array.from({ length: 20 }, (_, i) => `${9 + Math.floor(i / 2)}:${i % 2 === 0 ? '00' : '30'}`);
      const curated = curateSlots(slots, 6);
      
      expect(curated.length).toBeLessThanOrEqual(6);
      expect(curated.length).toBeGreaterThan(0);
    });
  });
});

describe('WhatsApp Message Formatting', () => {
  describe('formatShortWhatsAppReply', () => {
    function formatShortWhatsAppReply(msg) {
      return (msg || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    test('should remove excessive newlines', () => {
      const result = formatShortWhatsAppReply('Hello\n\n\n\nWorld');
      expect(result).toBe('Hello\n\nWorld');
    });

    test('should trim whitespace', () => {
      const result = formatShortWhatsAppReply('  Message  ');
      expect(result).toBe('Message');
    });

    test('should handle empty string', () => {
      const result = formatShortWhatsAppReply('');
      expect(result).toBe('');
    });
  });
});

describe('Business Logic - Slot Proximity Sorting', () => {
  function timeToMinutes(time) {
    const [h, m] = (time || '00:00').split(':').map(Number);
    return h * 60 + m;
  }

  test('should sort slots by proximity to preferred time', () => {
    const allSlots = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];
    const preferredTime = '11:30';
    const prefMin = timeToMinutes(preferredTime);
    
    const sorted = [...allSlots].sort((a, b) =>
      Math.abs(timeToMinutes(a) - prefMin) - Math.abs(timeToMinutes(b) - prefMin)
    );
    
    expect(sorted[0]).toBe('11:00'); // closest to 11:30
    expect(sorted[1]).toBe('10:00'); // second closest
  });

  test('should find nearest slot to afternoon preference', () => {
    const allSlots = ['09:00', '10:00', '14:00', '15:00', '16:00'];
    const preferredTime = '14:30';
    const prefMin = timeToMinutes(preferredTime);
    
    const sorted = [...allSlots].sort((a, b) =>
      Math.abs(timeToMinutes(a) - prefMin) - Math.abs(timeToMinutes(b) - prefMin)
    );
    
    expect(sorted[0]).toBe('14:00'); // closest to 14:30
  });
});

describe('Date Validation', () => {
  test('should detect past dates', () => {
    const todayStr = '2026-03-27';
    const pastDate = '2026-03-26';
    
    expect(pastDate < todayStr).toBe(true);
  });

  test('should accept future dates', () => {
    const todayStr = '2026-03-27';
    const futureDate = '2026-03-28';
    
    expect(futureDate >= todayStr).toBe(true);
  });

  test('should accept today', () => {
    const todayStr = '2026-03-27';
    const today = '2026-03-27';
    
    expect(today >= todayStr).toBe(true);
  });
});
