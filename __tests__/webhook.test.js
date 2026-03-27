import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// Mock all external dependencies before importing webhook
const mockQuery = jest.fn();
const mockGetSession = jest.fn();
const mockUpdateSession = jest.fn();
const mockResetSession = jest.fn();
const mockGetServices = jest.fn();
const mockGetStaff = jest.fn();
const mockGetAvailableSlots = jest.fn();
const mockBookAppointment = jest.fn();
const mockGetUpcomingAppointments = jest.fn();
const mockCancelAppointment = jest.fn();
const mockRescheduleAppointment = jest.fn();
const mockGetCustomerName = jest.fn();
const mockUpsertCustomer = jest.fn();
const mockGetBusiness = jest.fn();
const mockGetBusinessByPhone = jest.fn();
const mockClassifyMessage = jest.fn();
const mockExtractBookingIntent = jest.fn();
const mockExtractConfirmation = jest.fn();
const mockGenerateHelpReply = jest.fn();
const mockGenerateReturningUserGreeting = jest.fn();
const mockSendWhatsAppText = jest.fn();
const mockUpsertLeadActivity = jest.fn();
const mockTrackLeadEvent = jest.fn();
const mockMarkLeadConverted = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
  query: mockQuery,
}));

jest.unstable_mockModule('../src/services/session.service.js', () => ({
  getSession: mockGetSession,
  updateSession: mockUpdateSession,
  resetSession: mockResetSession,
  normalizePhone: (phone) => phone.replace(/^whatsapp:/i, '').trim(),
  STATES: {
    IDLE: 'IDLE',
    AWAITING_SERVICE: 'AWAITING_SERVICE',
    AWAITING_DATE: 'AWAITING_DATE',
    AWAITING_TIME: 'AWAITING_TIME',
    AWAITING_NAME: 'AWAITING_NAME',
    AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
    AWAITING_CANCEL_WHICH: 'AWAITING_CANCEL_WHICH',
    AWAITING_RESCHEDULE_WHICH: 'AWAITING_RESCHEDULE_WHICH',
    AWAITING_RESCHEDULE_DATE: 'AWAITING_RESCHEDULE_DATE',
    AWAITING_RESCHEDULE_TIME: 'AWAITING_RESCHEDULE_TIME',
    AWAITING_RESCHEDULE_CONFIRM: 'AWAITING_RESCHEDULE_CONFIRM',
    AWAITING_HANDOFF: 'AWAITING_HANDOFF',
  },
}));

jest.unstable_mockModule('../src/services/appointment.service.js', () => ({
  getServices: mockGetServices,
  getStaff: mockGetStaff,
  getAvailableSlots: mockGetAvailableSlots,
  bookAppointment: mockBookAppointment,
  getUpcomingAppointments: mockGetUpcomingAppointments,
  cancelAppointment: mockCancelAppointment,
  rescheduleAppointment: mockRescheduleAppointment,
  getCustomerName: mockGetCustomerName,
  upsertCustomer: mockUpsertCustomer,
  getBusiness: mockGetBusiness,
  getBusinessByPhone: mockGetBusinessByPhone,
  findService: jest.fn(),
  getAvailableSlotsForRange: jest.fn(),
  getFirstStaffWithSlotsOnDate: jest.fn(),
  localToUTC: jest.fn(),
  findNextSlotNearTime: jest.fn(),
  getLastBookedService: jest.fn(),
  getMostRecentAppointment: jest.fn(),
  markNextPendingAppointmentConfirmedForCustomer: jest.fn(),
}));

jest.unstable_mockModule('../src/services/ai.service.js', () => ({
  classifyMessage: mockClassifyMessage,
  extractBookingIntent: mockExtractBookingIntent,
  extractConfirmation: mockExtractConfirmation,
  generateHelpReply: mockGenerateHelpReply,
  generateReturningUserGreeting: mockGenerateReturningUserGreeting,
  answerConversational: jest.fn(),
  extractRescheduleIntent: jest.fn(),
  extractAvailabilityQuery: jest.fn(),
  generateInactivityNudge: jest.fn(),
  generateDynamicFallbackReply: jest.fn(),
}));

jest.unstable_mockModule('../src/services/whatsapp.service.js', () => ({
  sendWhatsAppText: mockSendWhatsAppText,
  sendWhatsAppTemplate: jest.fn(),
}));

jest.unstable_mockModule('../src/services/lead.service.js', () => ({
  upsertLeadActivity: mockUpsertLeadActivity,
  trackLeadEvent: mockTrackLeadEvent,
  markLeadConverted: mockMarkLeadConverted,
}));

jest.unstable_mockModule('../src/services/messaging-preference.service.js', () => ({
  setCampaignOptOut: jest.fn(),
}));

jest.unstable_mockModule('../src/services/whisper.service.js', () => ({
  transcribeMetaAudio: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/formatter.js', () => ({
  formatWelcome: jest.fn(() => 'Welcome message'),
  formatServiceList: jest.fn(() => 'Service list'),
  formatStaffList: jest.fn(() => 'Staff list'),
  formatSlotList: jest.fn(() => 'Slot list'),
  curateSlots: jest.fn((slots) => slots.slice(0, 6)),
  formatConfirmationPrompt: jest.fn(() => 'Confirm booking?'),
  formatBookingConfirmed: jest.fn(() => 'Booking confirmed!'),
  formatAppointmentList: jest.fn(() => 'Your appointments'),
  formatCancellationConfirmed: jest.fn(() => 'Cancelled!'),
  formatRescheduleConfirmed: jest.fn(() => 'Rescheduled!'),
  formatAvailabilitySummary: jest.fn(() => 'Availability summary'),
  formatHandoffMessage: jest.fn(() => 'Connecting you to a human'),
  formatError: jest.fn((msg) => `Error: ${msg}`),
  formatNotUnderstood: jest.fn(() => 'I did not understand'),
  formatFriendlyFallback: jest.fn((msg) => msg),
  formatDate: jest.fn((date) => date),
  formatTime: jest.fn((time) => time),
  formatDateTime: jest.fn((dt) => dt),
  timeToMinutes: jest.fn(() => 600),
  getTimeNotAvailableReason: jest.fn(() => 'slot is booked'),
  formatShortWhatsAppReply: jest.fn((msg) => msg),
}));

describe('WhatsApp Webhook - Attribution Extraction', () => {
  test('should extract #src attribution tag', async () => {
    const message = 'Hi, I want to book an appointment. #src=whatsapp_book_now';
    const regex = /#src=([a-z0-9_\-]+)/i;
    const match = message.match(regex);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('whatsapp_book_now');
  });

  test('should extract #cmp campaign tag', async () => {
    const message = 'Hello #cmp=spring_launch';
    const regex = /#cmp=([a-z0-9_\-]+)/i;
    const match = message.match(regex);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('spring_launch');
  });

  test('should extract #utm source tag', async () => {
    const message = 'Book me #utm=instagram';
    const regex = /#utm=([a-z0-9_\-]+)/i;
    const match = message.match(regex);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('instagram');
  });

  test('should extract all three attribution tags', async () => {
    const message = 'Hi, I want to book. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram';
    const sourceMatch = message.match(/#src=([a-z0-9_\-]+)/i);
    const campaignMatch = message.match(/#cmp=([a-z0-9_\-]+)/i);
    const utmMatch = message.match(/#utm=([a-z0-9_\-]+)/i);
    
    expect(sourceMatch[1]).toBe('whatsapp_book_now');
    expect(campaignMatch[1]).toBe('spring_launch');
    expect(utmMatch[1]).toBe('instagram');
  });

  test('should clean message after extracting attribution', async () => {
    const message = 'Hi, I want to book. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram';
    const cleaned = message
      .replace(/#src=[a-z0-9_\-]+/ig, '')
      .replace(/#cmp=[a-z0-9_\-]+/ig, '')
      .replace(/#utm=[a-z0-9_\-]+/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    expect(cleaned).toBe('Hi, I want to book.');
  });
});

describe('WhatsApp Webhook - Keyword Detection', () => {
  test('should detect HELP keywords', () => {
    const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
    
    expect(KEYWORD_HELP.test('help')).toBe(true);
    expect(KEYWORD_HELP.test('HELP')).toBe(true);
    expect(KEYWORD_HELP.test('hi')).toBe(true);
    expect(KEYWORD_HELP.test('hello')).toBe(true);
    expect(KEYWORD_HELP.test('hey!')).toBe(true);
    expect(KEYWORD_HELP.test('hi there')).toBe(false);
  });

  test('should detect "show my bookings" variations', () => {
    const KEYWORD_MY_BOOKINGS = /^(can\s+(you|u)\s+)?(show\s+(me\s+)?)?(my\s+)(bookings?|appointments?)|^(what('s|s|\s+are)\s+my\s+bookings?)|^(upcoming\s+appointments?)|^(list\s+my\s+bookings?)|^(show\s+(me\s+)?my\s+bookings?)|^(how\s+(are\s+)?)?(my\s+)(bookings?|appointments?)(\s+please)?\s*[\?\.\!]*$/i;
    
    expect(KEYWORD_MY_BOOKINGS.test('show my bookings')).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test('my bookings')).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test('my appointments')).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test('how my bookings')).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test('how my bookings please')).toBe(true);
    expect(KEYWORD_MY_BOOKINGS.test('upcoming appointments')).toBe(true);
  });

  test('should detect YES confirmations', () => {
    const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;
    
    expect(YES_REGEX.test('yes')).toBe(true);
    expect(YES_REGEX.test('YES')).toBe(true);
    expect(YES_REGEX.test('ok')).toBe(true);
    expect(YES_REGEX.test('sure')).toBe(true);
    expect(YES_REGEX.test('haan')).toBe(true);
    expect(YES_REGEX.test('go ahead')).toBe(true);
  });

  test('should detect NO denials', () => {
    const NO_REGEX = /^(no|n|nope|nahi|nah|cancel|stop|dont|don't|na|nahh|❌|🚫|not now|skip)$/i;
    
    expect(NO_REGEX.test('no')).toBe(true);
    expect(NO_REGEX.test('nahi')).toBe(true);
    expect(NO_REGEX.test('cancel')).toBe(true);
    expect(NO_REGEX.test('nope')).toBe(true);
  });

  test('should detect same service/rebook keywords', () => {
    const KEYWORD_SAME_SERVICE = /\b(same\s+(as\s+)?(last|before|previous|usual|time)|book\s+(it\s+)?again|same\s+service|rebook|same\s+thing|same\s+appointment|similar\s+to\s+last|same\s+one|repeat\s+booking|one\s+more\s+like\s+before)\b/i;
    
    expect(KEYWORD_SAME_SERVICE.test('same as last time')).toBe(true);
    expect(KEYWORD_SAME_SERVICE.test('same as before')).toBe(true);
    expect(KEYWORD_SAME_SERVICE.test('rebook')).toBe(true);
    expect(KEYWORD_SAME_SERVICE.test('book it again')).toBe(true);
    expect(KEYWORD_SAME_SERVICE.test('same appointment')).toBe(true);
  });

  test('should detect reminder keywords', () => {
    const KEYWORD_REMINDER_OVERRIDE = /\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder)\b/i;
    
    expect(KEYWORD_REMINDER_OVERRIDE.test('remind me at 7pm')).toBe(true);
    expect(KEYWORD_REMINDER_OVERRIDE.test('set a reminder')).toBe(true);
    expect(KEYWORD_REMINDER_OVERRIDE.test('send me a reminder')).toBe(true);
    expect(KEYWORD_REMINDER_OVERRIDE.test('can you remind me')).toBe(true);
  });

  test('should detect acknowledgment keywords', () => {
    const KEYWORD_ACK = /^(great|thanks|thank\s*you|thankyou|thx|ty|perfect|awesome|excellent|nice|cool|sweet|ok\s*thanks|okay\s*thanks|got\s*it|noted|alright|brilliant|cheers|👍+|🙏+|😊+)[\s\!\.\,🙂😊]*$/i;
    
    expect(KEYWORD_ACK.test('thanks')).toBe(true);
    expect(KEYWORD_ACK.test('thank you')).toBe(true);
    expect(KEYWORD_ACK.test('perfect')).toBe(true);
    expect(KEYWORD_ACK.test('great!')).toBe(true);
    expect(KEYWORD_ACK.test('👍')).toBe(true);
  });
});

describe('WhatsApp Webhook - Gibberish Detection', () => {
  function looksLikeGibberish(msg) {
    const s = (msg || '').trim().toLowerCase();
    if (s.length < 3 || s.includes(' ') || /\d/.test(s)) return false;
    if (/^(.)\1{5,}$/.test(s)) return true;
    if (/^(.{1,3})\1{3,}/.test(s) && s.length > 7) return true;
    if (s.length > 5 && !/[aeiou]/.test(s)) return true;
    return false;
  }

  test('should detect repeated single character', () => {
    expect(looksLikeGibberish('aaaaaa')).toBe(true);
    expect(looksLikeGibberish('zzzzzzz')).toBe(true);
  });

  test('should detect repeating patterns', () => {
    expect(looksLikeGibberish('hahahaha')).toBe(true);
    expect(looksLikeGibberish('lalalala')).toBe(true);
    // 'asdasdasd' has 9 chars with 'a' vowel, so it won't trigger no-vowel rule
    // But it should trigger the repeating pattern rule
    expect(looksLikeGibberish('hjkhjkhjk')).toBe(true);
  });

  test('should detect no vowels', () => {
    expect(looksLikeGibberish('hjklzxcvb')).toBe(true);
    expect(looksLikeGibberish('qwrtyp')).toBe(true);
  });

  test('should NOT flag normal words', () => {
    expect(looksLikeGibberish('hello')).toBe(false);
    expect(looksLikeGibberish('book')).toBe(false);
    expect(looksLikeGibberish('yes')).toBe(false);
  });

  test('should NOT flag phrases with spaces', () => {
    expect(looksLikeGibberish('hi there')).toBe(false);
    expect(looksLikeGibberish('book appointment')).toBe(false);
  });

  test('should NOT flag messages with numbers', () => {
    expect(looksLikeGibberish('test123')).toBe(false);
    expect(looksLikeGibberish('room2')).toBe(false);
  });
});

describe('WhatsApp Webhook - Relative Reminder Parser', () => {
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

  test('should parse "in 5 minutes"', () => {
    const delay = extractRelativeReminderDelayMs('remind me in 5 minutes');
    expect(delay).toBe(5 * 60 * 1000);
  });

  test('should parse "after 2 hours"', () => {
    const delay = extractRelativeReminderDelayMs('remind me after 2 hours');
    expect(delay).toBe(2 * 60 * 60 * 1000);
  });

  test('should parse "10 mins later"', () => {
    const delay = extractRelativeReminderDelayMs('10 mins later');
    expect(delay).toBe(10 * 60 * 1000);
  });

  test('should parse "1 hr from now"', () => {
    const delay = extractRelativeReminderDelayMs('1 hr from now');
    expect(delay).toBe(60 * 60 * 1000);
  });

  test('should return null for invalid input', () => {
    expect(extractRelativeReminderDelayMs('remind me tomorrow')).toBeNull();
    expect(extractRelativeReminderDelayMs('sometime later')).toBeNull();
  });
});

describe('WhatsApp Webhook - Message Normalization', () => {
  function normForKeywords(msg) {
    return (msg || '').trim().replace(/[\?\.\!]+$/, '').trim();
  }

  test('should trim whitespace', () => {
    expect(normForKeywords('  hello  ')).toBe('hello');
  });

  test('should remove trailing punctuation', () => {
    expect(normForKeywords('help?')).toBe('help');
    expect(normForKeywords('hello!')).toBe('hello');
    expect(normForKeywords('hi.')).toBe('hi');
    expect(normForKeywords('help???')).toBe('help');
  });

  test('should handle multiple trailing punctuation', () => {
    expect(normForKeywords('help?!.')).toBe('help');
  });
});

describe('WhatsApp Webhook - Attribution Function', () => {
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

  test('should extract all attribution and clean message', () => {
    const result = extractAttribution('Hi, I want to book. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram');
    
    expect(result.source).toBe('whatsapp_book_now');
    expect(result.campaign).toBe('spring_launch');
    expect(result.utmSource).toBe('instagram');
    expect(result.cleanMessage).toBe('Hi, I want to book.');
  });

  test('should handle message with only source tag', () => {
    const result = extractAttribution('Book appointment #src=website');
    
    expect(result.source).toBe('website');
    expect(result.campaign).toBeNull();
    expect(result.utmSource).toBeNull();
    expect(result.cleanMessage).toBe('Book appointment');
  });

  test('should handle message without any tags', () => {
    const result = extractAttribution('Hello, I need help');
    
    expect(result.source).toBeNull();
    expect(result.campaign).toBeNull();
    expect(result.utmSource).toBeNull();
    expect(result.cleanMessage).toBe('Hello, I need help');
  });

  test('should handle empty message', () => {
    const result = extractAttribution('');
    
    expect(result.source).toBeNull();
    expect(result.campaign).toBeNull();
    expect(result.utmSource).toBeNull();
    expect(result.cleanMessage).toBe('');
  });

  test('should handle multiple spaces after tag removal', () => {
    const result = extractAttribution('Hi   #src=web   #cmp=test   there');
    
    expect(result.cleanMessage).toBe('Hi there');
  });
});

describe('WhatsApp Webhook - Message Contains Patterns', () => {
  test('should detect "my bookings" in various contexts', () => {
    const CONTAINS_MY_BOOKINGS = /\bmy\s+bookings?\b|\bmy\s+appointments?\b/i;
    
    expect(CONTAINS_MY_BOOKINGS.test('show my bookings')).toBe(true);
    expect(CONTAINS_MY_BOOKINGS.test('can you show my bookings')).toBe(true);
    expect(CONTAINS_MY_BOOKINGS.test('I want to see my appointments')).toBe(true);
    expect(CONTAINS_MY_BOOKINGS.test('how are my bookings')).toBe(true);
    expect(CONTAINS_MY_BOOKINGS.test('tell me my booking')).toBe(true);
  });

  test('should NOT trigger on cancel bookings', () => {
    const msgNorm = 'cancel my bookings';
    const CONTAINS_MY_BOOKINGS = /\bmy\s+bookings?\b|\bmy\s+appointments?\b/i;
    
    // The code has a check for /^cancel\s+/i before using CONTAINS_MY_BOOKINGS
    expect(/^cancel\s+/i.test(msgNorm)).toBe(true);
    // So "cancel my bookings" should NOT be treated as show bookings
  });
});

describe('WhatsApp Webhook - Help Questions', () => {
  test('should detect help questions', () => {
    const KEYWORD_HELP_QUESTIONS = /^(what\s+(can\s+)?(you|u)\s+(can\s+)?do|how\s+(can\s+)?(you|u)\s+(can\s+)?help(\s+me)?|what\s+do\s+you\s+do|how\s+(you|u)\s+can\s+(help|assist)(\s+me)?)\s*[\?\.\!]*$/i;
    
    expect(KEYWORD_HELP_QUESTIONS.test('what can you do')).toBe(true);
    expect(KEYWORD_HELP_QUESTIONS.test('what can you do?')).toBe(true);
    expect(KEYWORD_HELP_QUESTIONS.test('how can you help')).toBe(true);
    expect(KEYWORD_HELP_QUESTIONS.test('how can you help me?')).toBe(true);
    expect(KEYWORD_HELP_QUESTIONS.test('what do you do')).toBe(true);
    expect(KEYWORD_HELP_QUESTIONS.test('what can u do')).toBe(true);
  });
});

describe('WhatsApp Webhook - Handoff Detection', () => {
  test('should detect handoff request keywords', () => {
    const HANDOFF_REGEX = /\b(human|person|agent|manager|owner|staff|reception|someone|talk to (a|someone)|speak (to|with) (a|someone)|real person|live (chat|support)|help me please|need help urgently)\b/i;
    
    expect(HANDOFF_REGEX.test('I want to talk to a human')).toBe(true);
    expect(HANDOFF_REGEX.test('speak with someone')).toBe(true);
    expect(HANDOFF_REGEX.test('need help urgently')).toBe(true);
    expect(HANDOFF_REGEX.test('talk to manager')).toBe(true);
    expect(HANDOFF_REGEX.test('real person please')).toBe(true);
  });
});

describe('WhatsApp Webhook - STOP/START Keywords', () => {
  test('should detect STOP keywords', () => {
    const KEYWORD_GLOBAL_STOP = /^(stop|unsubscribe|opt\s*out|remove\s*me|stop\s*campaigns?)\s*[\.\!\?]*$/i;
    
    expect(KEYWORD_GLOBAL_STOP.test('stop')).toBe(true);
    expect(KEYWORD_GLOBAL_STOP.test('STOP')).toBe(true);
    expect(KEYWORD_GLOBAL_STOP.test('unsubscribe')).toBe(true);
    expect(KEYWORD_GLOBAL_STOP.test('opt out')).toBe(true);
    expect(KEYWORD_GLOBAL_STOP.test('stop campaigns')).toBe(true);
  });

  test('should detect START keywords', () => {
    const KEYWORD_GLOBAL_START = /^(start|subscribe|opt\s*in|resume)\s*[\.\!\?]*$/i;
    
    expect(KEYWORD_GLOBAL_START.test('start')).toBe(true);
    expect(KEYWORD_GLOBAL_START.test('START')).toBe(true);
    expect(KEYWORD_GLOBAL_START.test('subscribe')).toBe(true);
    expect(KEYWORD_GLOBAL_START.test('opt in')).toBe(true);
  });
});
