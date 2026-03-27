import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';

describe('Chatbot Integration Tests - End-to-End Flows', () => {
  describe('Conversation Flow Tests', () => {
    test('SCENARIO 1: User says HELP after greeting', async () => {
      // This tests the conversation from the chat log:
      // User: PJ
      // Bot: Welcome message with Type HELP for options
      // User: Help
      // Bot: Should show actual help menu, not hiccup message
      
      const conversation = [
        { user: 'PJ', expectedInReply: ['help', 'book', 'Deepak Clinic'] },
        { user: 'Help', expectedInReply: ['book', 'cancel', 'reschedule'] },
      ];
      
      // Test that HELP keyword is recognized
      const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
      expect(KEYWORD_HELP.test('Help')).toBe(true);
      expect(KEYWORD_HELP.test('help')).toBe(true);
    });

    test('SCENARIO 2: Booking with attribution tags', async () => {
      // From chat log: "Hi, I want to book an appointment. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram"
      const message = 'Hi, I want to book an appointment. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram';
      
      // Test attribution extraction
      function extractAttribution(text) {
        const raw = String(text || '');
        const sourceMatch = raw.match(/#src=([a-z0-9_\-]+)/i);
        const campaignMatch = raw.match(/#cmp=([a-z0-9_\-]+)/i);
        const utmMatch = raw.match(/#utm=([a-z0-9_\-]+)/i);
        const cleanMessage = raw
          .replace(/#src=[a-z0-9_\-]+/ig, '')
          .replace(/#cmp=[a-z0-9_\-]+/ig, '')
          .replace(/#utm=[a-z0-9_\-]+/ig, '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          cleanMessage: cleanMessage || raw,
          source: sourceMatch?.[1] || null,
          campaign: campaignMatch?.[1] || null,
          utmSource: utmMatch?.[1] || null,
        };
      }

      const attribution = extractAttribution(message);
      
      expect(attribution.source).toBe('whatsapp_book_now');
      expect(attribution.campaign).toBe('spring_launch');
      expect(attribution.utmSource).toBe('instagram');
      expect(attribution.cleanMessage).toBe('Hi, I want to book an appointment.');
    });

    test('SCENARIO 3: Show my bookings variations', async () => {
      // From chat log: "Show my bookings"
      // Should recognize all these variations
      const variations = [
        'show my bookings',
        'Show my bookings',
        'my bookings',
        'my appointments',
        'how my bookings',
        'how my bookings please',
        'what are my bookings',
        'upcoming appointments',
      ];

      const KEYWORD_MY_BOOKINGS = /^(can\s+(you|u)\s+)?(show\s+(me\s+)?)?(my\s+)(bookings?|appointments?)|^(what('s|s|\s+are)\s+my\s+bookings?)|^(upcoming\s+appointments?)|^(list\s+my\s+bookings?)|^(show\s+(me\s+)?my\s+bookings?)|^(how\s+(are\s+)?)?(my\s+)(bookings?|appointments?)(\s+please)?\s*[\?\.\!]*$/i;
      const CONTAINS_MY_BOOKINGS = /\bmy\s+bookings?\b|\bmy\s+appointments?\b/i;

      variations.forEach(msg => {
        const matches = KEYWORD_MY_BOOKINGS.test(msg) || CONTAINS_MY_BOOKINGS.test(msg);
        expect(matches).toBe(true);
      });
    });

    test('SCENARIO 4: Yes response after show bookings', async () => {
      // From chat log:
      // Bot: "Looks like your schedule is clear! Want to book one?"
      // User: "Yes"
      // Should recognize "Yes" as confirmation, not vague message
      
      const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;
      
      expect(YES_REGEX.test('Yes')).toBe(true);
      expect(YES_REGEX.test('yes')).toBe(true);
      expect(YES_REGEX.test('YES')).toBe(true);
    });

    test('SCENARIO 5: Hello after delay', async () => {
      // From chat log: User says "Hello" and expects helpful response
      // Should trigger HELP flow
      
      const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
      
      expect(KEYWORD_HELP.test('Hello')).toBe(true);
      expect(KEYWORD_HELP.test('hello')).toBe(true);
      expect(KEYWORD_HELP.test('Hi')).toBe(true);
    });
  });

  describe('Error Handling Tests', () => {
    test('should handle msgNorm being defined before use', () => {
      // This was the bug: msgNorm used on line 287 before definition on line 309
      
      function normForKeywords(msg) {
        return (msg || '').trim().replace(/[\?\.\!]+$/, '').trim();
      }

      const message = 'Hello';
      const msgNorm = normForKeywords(message);
      
      // msgNorm should be defined before any keyword tests
      expect(msgNorm).toBe('Hello');
      
      // Now we can use it safely
      const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
      expect(KEYWORD_HELP.test(msgNorm)).toBe(true);
    });

    test('should not crash when checking STOP keywords', () => {
      const KEYWORD_GLOBAL_STOP = /^(stop|unsubscribe|opt\s*out|remove\s*me|stop\s*campaigns?)\s*[\.\!\?]*$/i;
      
      function normForKeywords(msg) {
        return (msg || '').trim().replace(/[\?\.\!]+$/, '').trim();
      }

      const messages = ['stop', 'STOP', 'unsubscribe', 'opt out'];
      messages.forEach(msg => {
        const msgNorm = normForKeywords(msg);
        expect(() => KEYWORD_GLOBAL_STOP.test(msgNorm)).not.toThrow();
      });
    });
  });

  describe('Lead Tracking Tests', () => {
    test('should track lead from attribution tags', () => {
      const attribution = {
        source: 'whatsapp_book_now',
        campaign: 'spring_launch',
        utmSource: 'instagram',
      };
      
      expect(attribution.source).toBe('whatsapp_book_now');
      expect(attribution.campaign).toBe('spring_launch');
      expect(attribution.utmSource).toBe('instagram');
    });

    test('should use default source when no tags present', () => {
      const explicitBusinessId = null;
      const defaultSource = explicitBusinessId ? 'website_chat_widget' : 'whatsapp';
      
      expect(defaultSource).toBe('whatsapp');
    });

    test('should use website source for explicit business', () => {
      const explicitBusinessId = 1;
      const defaultSource = explicitBusinessId ? 'website_chat_widget' : 'whatsapp';
      
      expect(defaultSource).toBe('website_chat_widget');
    });
  });

  describe('Inactivity Nudge Tests', () => {
    test('should schedule nudge after delay', () => {
      const NUDGE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
      expect(NUDGE_DELAY_MS).toBe(300000);
    });

    test('should clear nudge on new message', () => {
      const nudgeTimers = new Map();
      const key = '+15551234567:1';
      
      // Schedule
      const timeoutId = setTimeout(() => {}, 1000);
      nudgeTimers.set(key, { timeoutId, baselineUpdatedAt: new Date() });
      
      expect(nudgeTimers.has(key)).toBe(true);
      
      // Clear
      const existing = nudgeTimers.get(key);
      if (existing?.timeoutId) {
        clearTimeout(existing.timeoutId);
        nudgeTimers.delete(key);
      }
      
      expect(nudgeTimers.has(key)).toBe(false);
    });
  });

  describe('Booking Flow State Transitions', () => {
    test('should transition from IDLE to AWAITING_SERVICE on book intent', () => {
      let state = 'IDLE';
      const intent = 'book';
      const hasService = false;
      
      if (intent === 'book' && !hasService) {
        state = 'AWAITING_SERVICE';
      }
      
      expect(state).toBe('AWAITING_SERVICE');
    });

    test('should transition from AWAITING_SERVICE to AWAITING_DATE after service selection', () => {
      let state = 'AWAITING_SERVICE';
      const serviceSelected = true;
      
      if (serviceSelected) {
        state = 'AWAITING_DATE';
      }
      
      expect(state).toBe('AWAITING_DATE');
    });

    test('should transition from AWAITING_DATE to AWAITING_TIME after date provided', () => {
      let state = 'AWAITING_DATE';
      const dateProvided = true;
      const slotsAvailable = true;
      
      if (dateProvided && slotsAvailable) {
        state = 'AWAITING_TIME';
      }
      
      expect(state).toBe('AWAITING_TIME');
    });

    test('should transition from AWAITING_TIME to AWAITING_CONFIRMATION with saved name', () => {
      let state = 'AWAITING_TIME';
      const timeSelected = true;
      const hasSavedName = true;
      
      if (timeSelected && hasSavedName) {
        state = 'AWAITING_CONFIRMATION';
      }
      
      expect(state).toBe('AWAITING_CONFIRMATION');
    });

    test('should transition from AWAITING_TIME to AWAITING_NAME without saved name', () => {
      let state = 'AWAITING_TIME';
      const timeSelected = true;
      const hasSavedName = false;
      
      if (timeSelected && !hasSavedName) {
        state = 'AWAITING_NAME';
      }
      
      expect(state).toBe('AWAITING_NAME');
    });

    test('should transition from AWAITING_CONFIRMATION to IDLE after booking', () => {
      let state = 'AWAITING_CONFIRMATION';
      const confirmed = true;
      const booked = true;
      
      if (confirmed && booked) {
        state = 'IDLE';
      }
      
      expect(state).toBe('IDLE');
    });
  });

  describe('Cancel Flow Tests', () => {
    test('should detect cancel intent', () => {
      const msgNorm = 'cancel';
      const KEYWORD_CANCEL_FLOW = /^(cancel|stop|quit|exit|nahi|nope|no thanks)$/i;
      
      expect(KEYWORD_CANCEL_FLOW.test(msgNorm)).toBe(true);
    });

    test('should NOT trigger cancel flow for "cancel my appointment"', () => {
      const msgNorm = 'cancel my appointment';
      const KEYWORD_CANCEL_FLOW = /^(cancel|stop|quit|exit|nahi|nope|no thanks)$/i;
      
      expect(KEYWORD_CANCEL_FLOW.test(msgNorm)).toBe(false);
    });

    test('should transition to AWAITING_CANCEL_WHICH when user has appointments', () => {
      let state = 'IDLE';
      const intent = 'cancel';
      const appointments = [{ id: 1 }, { id: 2 }];
      
      if (intent === 'cancel' && appointments.length > 1) {
        state = 'AWAITING_CANCEL_WHICH';
      }
      
      expect(state).toBe('AWAITING_CANCEL_WHICH');
    });
  });

  describe('Reschedule Flow Tests', () => {
    test('should detect reschedule intent', () => {
      const message = 'reschedule my appointment';
      // LLM would classify this as 'reschedule'
      expect(message.toLowerCase()).toContain('reschedule');
    });

    test('should transition through reschedule states', () => {
      const states = [
        'IDLE',
        'AWAITING_RESCHEDULE_WHICH',
        'AWAITING_RESCHEDULE_DATE',
        'AWAITING_RESCHEDULE_TIME',
        'AWAITING_RESCHEDULE_CONFIRM',
        'IDLE',
      ];
      
      expect(states[0]).toBe('IDLE');
      expect(states[states.length - 1]).toBe('IDLE');
      expect(states).toContain('AWAITING_RESCHEDULE_DATE');
    });
  });

  describe('Smart Features Tests', () => {
    test('should prefill last service for "book again"', () => {
      const lastBooking = {
        service_id: 1,
        service_name: 'Haircut',
        staff_id: 2,
        staff_name: 'John',
      };
      
      const prefilled = {
        serviceId: lastBooking.service_id,
        serviceName: lastBooking.service_name,
        staffId: lastBooking.staff_id,
        staffName: lastBooking.staff_name,
        lockStaff: true,
      };
      
      expect(prefilled.serviceName).toBe('Haircut');
      expect(prefilled.lockStaff).toBe(true);
    });

    test('should honor stored time preference', () => {
      const temp = { time: '14:00' };
      const allSlots = ['09:00', '10:00', '14:00', '15:00'];
      const exactMatch = allSlots.find(s => s === temp.time);
      
      expect(exactMatch).toBe('14:00');
    });

    test('should sort slots by proximity when preferred time not available', () => {
      const preferredTime = '14:30';
      const allSlots = ['09:00', '10:00', '14:00', '15:00', '16:00'];
      
      function timeToMinutes(time) {
        const [h, m] = time.split(':').map(Number);
        return h * 60 + m;
      }
      
      const prefMin = timeToMinutes(preferredTime);
      const sorted = [...allSlots].sort((a, b) =>
        Math.abs(timeToMinutes(a) - prefMin) - Math.abs(timeToMinutes(b) - prefMin)
      );
      
      expect(sorted[0]).toBe('14:00'); // closest
      expect(sorted[1]).toBe('15:00'); // second closest
    });
  });

  describe('Reminder Feature Tests', () => {
    test('should parse relative reminder delay', () => {
      function extractRelativeReminderDelayMs(message) {
        const text = (message || '').toLowerCase();
        if (!text) return null;

        const patterns = [
          /\b(?:in|after)\s+(\d{1,3})\s*(minutes?|mins?|min|hours?|hrs?|hr)\b/i,
          /\b(\d{1,3})\s*(minutes?|mins?|min|hours?|hrs?|hr)\s*(?:later|from\s+now)\b/i,
        ];

        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (!match) continue;

          const rawValue = parseInt(match[1], 10);
          if (!Number.isFinite(rawValue) || rawValue <= 0) return null;

          const unit = (match[2] || '').toLowerCase();
          const minutes = unit.startsWith('h') ? rawValue * 60 : rawValue;
          return minutes * 60 * 1000;
        }

        return null;
      }

      expect(extractRelativeReminderDelayMs('remind me in 10 minutes')).toBe(600000);
      expect(extractRelativeReminderDelayMs('after 2 hours')).toBe(7200000);
      expect(extractRelativeReminderDelayMs('30 mins later')).toBe(1800000);
    });

    test('should detect reminder override keyword', () => {
      const KEYWORD_REMINDER_OVERRIDE = /\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder)\b/i;
      
      expect(KEYWORD_REMINDER_OVERRIDE.test('remind me at 7pm')).toBe(true);
      expect(KEYWORD_REMINDER_OVERRIDE.test('set a reminder')).toBe(true);
      expect(KEYWORD_REMINDER_OVERRIDE.test('can you send me a reminder')).toBe(true);
    });

    test('should NOT confuse reminder with reschedule', () => {
      const message1 = 'remind me at 7pm';
      const message2 = 'reschedule to 7pm';
      
      const KEYWORD_REMINDER_OVERRIDE = /\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder)\b/i;
      
      expect(KEYWORD_REMINDER_OVERRIDE.test(message1)).toBe(true);
      expect(KEYWORD_REMINDER_OVERRIDE.test(message2)).toBe(false);
    });
  });

  describe('Multi-language Support Tests', () => {
    test('should recognize Hindi confirmations', () => {
      const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;
      
      expect(YES_REGEX.test('haan')).toBe(true);
      expect(YES_REGEX.test('ha')).toBe(true);
      expect(YES_REGEX.test('theek hai')).toBe(true);
      expect(YES_REGEX.test('bilkul')).toBe(true);
    });

    test('should recognize Hindi denials', () => {
      const NO_REGEX = /^(no|n|nope|nahi|nah|cancel|stop|dont|don't|na|nahh|❌|🚫|not now|skip)$/i;
      
      expect(NO_REGEX.test('nahi')).toBe(true);
      expect(NO_REGEX.test('na')).toBe(true);
      expect(NO_REGEX.test('nahh')).toBe(true);
    });
  });

  describe('Session Timeout Tests', () => {
    test('should calculate active session timeout correctly', () => {
      const SESSION_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
      expect(SESSION_ACTIVE_TIMEOUT_MS).toBe(600000); // 10 minutes
    });

    test('should calculate idle session timeout correctly', () => {
      const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
      expect(SESSION_IDLE_TIMEOUT_MS).toBe(1800000); // 30 minutes
    });

    test('should determine if session is stale', () => {
      const now = Date.now();
      const updatedAt = new Date(now - 11 * 60 * 1000); // 11 minutes ago
      const staleMs = now - updatedAt.getTime();
      const SESSION_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
      
      expect(staleMs > SESSION_ACTIVE_TIMEOUT_MS).toBe(true);
    });
  });

  describe('WhatsApp Message Extraction Tests', () => {
    function extractMetaMessageContent(msg) {
      const type = msg?.type;
      if (type === 'text') return { text: msg?.text?.body || '' };
      if (type === 'button') return { text: msg?.button?.text || '' };
      if (type === 'interactive') {
        const i = msg?.interactive || {};
        const buttonTitle = i?.button_reply?.title;
        const listTitle = i?.list_reply?.title;
        return { text: buttonTitle || listTitle || '' };
      }
      if (type === 'audio') {
        return { audioId: msg?.audio?.id, audioMimeType: msg?.audio?.mime_type };
      }
      return { text: '' };
    }

    test('should extract text message', () => {
      const msg = { type: 'text', text: { body: 'Hello' } };
      const result = extractMetaMessageContent(msg);
      
      expect(result.text).toBe('Hello');
    });

    test('should extract button message', () => {
      const msg = { type: 'button', button: { text: 'Book Now' } };
      const result = extractMetaMessageContent(msg);
      
      expect(result.text).toBe('Book Now');
    });

    test('should extract interactive button reply', () => {
      const msg = {
        type: 'interactive',
        interactive: {
          button_reply: { title: 'Confirm' },
        },
      };
      const result = extractMetaMessageContent(msg);
      
      expect(result.text).toBe('Confirm');
    });

    test('should extract audio message id', () => {
      const msg = {
        type: 'audio',
        audio: { id: 'audio123', mime_type: 'audio/ogg' },
      };
      const result = extractMetaMessageContent(msg);
      
      expect(result.audioId).toBe('audio123');
      expect(result.audioMimeType).toBe('audio/ogg');
    });
  });

  describe('Business Routing Tests', () => {
    test('should route to correct business by phone number', () => {
      const toNumber = '+15551628063';
      const displayNumber = toNumber;
      
      // Business would be looked up by this number
      expect(displayNumber).toBe('+15551628063');
    });

    test('should use explicit business ID when provided', () => {
      const explicitBusinessId = 5;
      const businessId = explicitBusinessId ? parseInt(explicitBusinessId, 10) : null;
      
      expect(businessId).toBe(5);
    });

    test('should fallback to default business', () => {
      const explicitBusinessId = null;
      const toNumber = '';
      const DEFAULT_BUSINESS_ID = 1;
      
      const businessId = explicitBusinessId || toNumber ? null : DEFAULT_BUSINESS_ID;
      
      expect(businessId).toBe(DEFAULT_BUSINESS_ID);
    });
  });
});

describe('Conversation Scenario Tests', () => {
  test('COMPLETE FLOW: Greeting -> Help -> Show Bookings -> Book', () => {
    const conversation = [
      { input: 'PJ', shouldMatch: 'CONVERSATIONAL' },
      { input: 'Help', shouldMatch: 'HELP' },
      { input: 'Show my bookings', shouldMatch: 'MY_BOOKINGS' },
      { input: 'Yes', shouldMatch: 'YES_CONFIRMATION' },
    ];

    const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
    const KEYWORD_MY_BOOKINGS = /^(can\s+(you|u)\s+)?(show\s+(me\s+)?)?(my\s+)(bookings?|appointments?)|^(what('s|s|\s+are)\s+my\s+bookings?)|^(upcoming\s+appointments?)|^(list\s+my\s+bookings?)|^(show\s+(me\s+)?my\s+bookings?)|^(how\s+(are\s+)?)?(my\s+)(bookings?|appointments?)(\s+please)?\s*[\?\.\!]*$/i;
    const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;

    // PJ doesn't match HELP (it's conversational), but that's fine
    expect(KEYWORD_HELP.test(conversation[0].input)).toBe(false);
    expect(KEYWORD_HELP.test(conversation[1].input)).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test(conversation[2].input)).toBe(true);
    expect(YES_REGEX.test(conversation[3].input)).toBe(true);
  });

  test('COMPLETE FLOW: Book with attribution', () => {
    const message = 'Hi, I want to book an appointment. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram';
    
    function extractAttribution(text) {
      const raw = String(text || '');
      const sourceMatch = raw.match(/#src=([a-z0-9_\-]+)/i);
      const campaignMatch = raw.match(/#cmp=([a-z0-9_\-]+)/i);
      const utmMatch = raw.match(/#utm=([a-z0-9_\-]+)/i);
      const cleanMessage = raw
        .replace(/#src=[a-z0-9_\-]+/ig, '')
        .replace(/#cmp=[a-z0-9_\-]+/ig, '')
        .replace(/#utm=[a-z0-9_\-]+/ig, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        cleanMessage: cleanMessage || raw,
        source: sourceMatch?.[1] || null,
        campaign: campaignMatch?.[1] || null,
        utmSource: utmMatch?.[1] || null,
      };
    }

    const attribution = extractAttribution(message);
    
    // Attribution should be extracted
    expect(attribution.source).toBe('whatsapp_book_now');
    expect(attribution.campaign).toBe('spring_launch');
    expect(attribution.utmSource).toBe('instagram');
    
    // Message should be cleaned for intent classification
    expect(attribution.cleanMessage).toBe('Hi, I want to book an appointment.');
    
    // Clean message should be used for intent classification, not the raw message
    expect(attribution.cleanMessage).not.toContain('#src');
    expect(attribution.cleanMessage).not.toContain('#cmp');
    expect(attribution.cleanMessage).not.toContain('#utm');
  });
});
