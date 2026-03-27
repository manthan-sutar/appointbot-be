import { describe, test, expect } from '@jest/globals';
import {
  extractBookingIntent,
  extractRescheduleIntent,
  extractConfirmation,
  classifyMessage,
  extractAvailabilityQuery,
  answerConversational,
  generateHelpReply,
  generateReturningUserGreeting,
  generateInactivityNudge,
  generateDynamicFallbackReply,
} from '../src/services/ai.service.js';

// Note: These tests will actually call the LLM, so they may take a few seconds
// and require GROQ_API_KEY or Ollama to be configured.

describe('AI Service - extractBookingIntent', () => {
  test('should extract service, date, and time from message', async () => {
    const result = await extractBookingIntent(
      'I want to book a haircut tomorrow at 3pm',
      ['Haircut', 'Hair Color', 'Styling'],
      'Asia/Kolkata'
    );

    expect(result).toHaveProperty('service');
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('time');
    expect(result).toHaveProperty('staffName');
  }, 30000);

  test('should handle "tomorrow" correctly', async () => {
    const result = await extractBookingIntent('book tomorrow', [], 'Asia/Kolkata');
    
    expect(result.date).not.toBeNull();
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30000);

  test('should parse fuzzy times like "morning", "evening"', async () => {
    const result = await extractBookingIntent('book tomorrow morning', [], 'Asia/Kolkata');
    
    if (result.time) {
      expect(result.time).toMatch(/^\d{2}:\d{2}$/);
    }
  }, 30000);

  test('should return nulls when no intent found', async () => {
    const result = await extractBookingIntent('hello', [], 'Asia/Kolkata');
    
    expect(result).toBeDefined();
    expect(result.service).toBeFalsy();
    expect(result.date).toBeFalsy();
  }, 30000);
});

describe('AI Service - classifyMessage', () => {
  test('should classify booking intent', async () => {
    const result = await classifyMessage('I want to book an appointment', []);
    
    expect(result).toHaveProperty('handoff');
    expect(result).toHaveProperty('intent');
    expect(result.intent).toBe('book');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should classify cancel intent', async () => {
    const result = await classifyMessage('cancel my appointment', []);
    
    expect(result.intent).toBe('cancel');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should classify reschedule intent', async () => {
    const result = await classifyMessage('reschedule my booking to Friday', []);
    
    expect(result.intent).toBe('reschedule');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should classify my_appointments intent', async () => {
    const result = await classifyMessage('show my bookings', []);
    
    expect(result.intent).toBe('my_appointments');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should detect handoff request', async () => {
    const result = await classifyMessage('I want to talk to a human', []);
    
    expect(result.handoff).toBe(true);
  }, 30000);

  test('should classify reminder intent', async () => {
    const result = await classifyMessage('remind me at 7pm', []);
    
    expect(result.intent).toBe('reminder');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should classify help intent', async () => {
    const result = await classifyMessage('what can you do?', []);
    
    expect(result.intent).toBe('help');
    expect(result.handoff).toBe(false);
  }, 30000);

  test('should handle casual greetings as none', async () => {
    const result = await classifyMessage('hey there', []);
    
    expect(result.intent).toMatch(/none|help|faq/);
    expect(result.handoff).toBe(false);
  }, 30000);
});

describe('AI Service - extractConfirmation', () => {
  test('should recognize YES variations', async () => {
    const yesVariations = ['yes', 'YES', 'yep', 'ok', 'sure', 'haan', 'confirm'];
    
    for (const word of yesVariations) {
      const result = await extractConfirmation(word);
      expect(result).toBe('yes');
    }
  }, 30000);

  test('should recognize NO variations', async () => {
    const noVariations = ['no', 'NO', 'nope', 'nahi', 'cancel'];
    
    for (const word of noVariations) {
      const result = await extractConfirmation(word);
      expect(result).toBe('no');
    }
  }, 30000);

  test('should return unknown for ambiguous messages', async () => {
    const result = await extractConfirmation('maybe later');
    
    expect(result).toBe('unknown');
  }, 30000);
});

describe('AI Service - extractRescheduleIntent', () => {
  test('should extract new date from reschedule message', async () => {
    const result = await extractRescheduleIntent('move it to Friday', 'Asia/Kolkata');
    
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('time');
  }, 30000);

  test('should extract date and time together', async () => {
    const result = await extractRescheduleIntent('reschedule to tomorrow at 5pm', 'Asia/Kolkata');
    
    if (result.date) {
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    if (result.time) {
      expect(result.time).toMatch(/^\d{2}:\d{2}$/);
    }
  }, 30000);
});

describe('AI Service - extractAvailabilityQuery', () => {
  test('should extract day query', async () => {
    const result = await extractAvailabilityQuery('what slots are available tomorrow', 'Asia/Kolkata');
    
    expect(result).toHaveProperty('type');
    if (result.type === 'day') {
      expect(result).toHaveProperty('date');
    }
  }, 30000);

  test('should extract week query', async () => {
    const result = await extractAvailabilityQuery('show me availability this week', 'Asia/Kolkata');
    
    expect(result).toHaveProperty('type');
    if (result.type === 'week') {
      expect(result).toHaveProperty('weekStart');
      expect(result).toHaveProperty('weekEnd');
    }
  }, 30000);
});

describe('AI Service - Conversational Responses', () => {
  test('should answer language questions', async () => {
    const result = await answerConversational('Do you speak Hindi?', {
      name: 'Deepak Clinic',
      type: 'clinic',
    });
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30000);

  test('should handle casual greetings', async () => {
    const result = await answerConversational('yo', {
      name: 'Deepak Clinic',
    });
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  }, 30000);
});

describe('AI Service - Help Reply Generation', () => {
  test('should generate help reply with services', async () => {
    const result = await generateHelpReply({
      businessName: 'Deepak Clinic',
      businessType: 'clinic',
      services: [
        { name: 'Consultation', price: 500 },
        { name: 'Follow-up', price: 300 },
      ],
      customerName: null,
    });
    
    expect(result).toBeDefined();
    if (result) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  }, 30000);

  test('should generate personalized help for returning customer', async () => {
    const result = await generateHelpReply({
      businessName: 'Deepak Clinic',
      businessType: 'clinic',
      services: [{ name: 'Checkup', price: 500 }],
      customerName: 'Manthan',
    });
    
    expect(result).toBeDefined();
    if (result) {
      expect(typeof result).toBe('string');
    }
  }, 30000);
});

describe('AI Service - Returning User Greeting', () => {
  test('should generate personalized greeting', async () => {
    const result = await generateReturningUserGreeting({
      businessName: 'Deepak Clinic',
      customerName: 'Manthan Sutar',
      businessType: 'clinic',
      services: [{ name: 'Consultation' }],
    });
    
    expect(result).toBeDefined();
    if (result) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  }, 30000);
});

describe('AI Service - Inactivity Nudge', () => {
  test('should generate inactivity nudge message', async () => {
    const result = await generateInactivityNudge({
      businessName: 'Deepak Clinic',
      businessType: 'clinic',
      lastStepDescription: 'Waiting for them to pick a time',
    });
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }, 30000);
});

describe('AI Service - Dynamic Fallback Reply', () => {
  test('should generate fallback for error scenario', async () => {
    const result = await generateDynamicFallbackReply({
      userMessage: 'show my bookings',
      businessName: 'Deepak Clinic',
      businessType: 'clinic',
    });
    
    expect(result).toBeDefined();
    if (result) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  }, 30000);
});

describe('AI Service - JSON Parser', () => {
  function parseJSON(raw) {
    try {
      const cleaned = raw
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const firstBrace = cleaned.indexOf('{');
      const firstBracket = cleaned.indexOf('[');
      let start = -1;
      let isArray = false;

      if (firstBrace === -1 && firstBracket === -1) return null;
      if (firstBrace === -1) { start = firstBracket; isArray = true; }
      else if (firstBracket === -1) { start = firstBrace; isArray = false; }
      else if (firstBracket < firstBrace) { start = firstBracket; isArray = true; }
      else { start = firstBrace; isArray = false; }

      const open = isArray ? '[' : '{';
      const close = isArray ? ']' : '}';
      let depth = 0;
      let end = -1;

      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === open) depth++;
        if (cleaned[i] === close) depth--;
        if (depth === 0) { end = i; break; }
      }

      if (end === -1) return null;
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  test('should parse clean JSON object', () => {
    const result = parseJSON('{"intent":"book","date":"2026-03-28"}');
    expect(result).toEqual({ intent: 'book', date: '2026-03-28' });
  });

  test('should parse JSON with markdown code fence', () => {
    const result = parseJSON('```json\n{"intent":"book"}\n```');
    expect(result).toEqual({ intent: 'book' });
  });

  test('should parse JSON with extra text before', () => {
    const result = parseJSON('Here is the result: {"intent":"cancel"}');
    expect(result).toEqual({ intent: 'cancel' });
  });

  test('should parse JSON with extra text after', () => {
    const result = parseJSON('{"intent":"book"} and more text');
    expect(result).toEqual({ intent: 'book' });
  });

  test('should parse JSON array', () => {
    const result = parseJSON('[{"name":"test"}]');
    expect(result).toEqual([{ name: 'test' }]);
  });

  test('should return null for invalid JSON', () => {
    const result = parseJSON('not json at all');
    expect(result).toBeNull();
  });

  test('should handle nested objects', () => {
    const result = parseJSON('{"outer":{"inner":"value"}}');
    expect(result).toEqual({ outer: { inner: 'value' } });
  });
});
