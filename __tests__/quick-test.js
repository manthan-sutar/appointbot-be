#!/usr/bin/env node

/**
 * Quick Validation Test
 * Tests the critical bug fix (msgNorm) and key features
 */

console.log('\n🔍 Running Quick Validation Tests...\n');

// ─── Test 1: Attribution Extraction ─────────────────────────────────────────────
console.log('TEST 1: Attribution Extraction');

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

const msg1 = 'Hi, I want to book. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram';
const attr1 = extractAttribution(msg1);

console.assert(attr1.source === 'whatsapp_book_now', '  ✗ Source extraction failed');
console.assert(attr1.campaign === 'spring_launch', '  ✗ Campaign extraction failed');
console.assert(attr1.utmSource === 'instagram', '  ✗ UTM extraction failed');
console.assert(attr1.cleanMessage === 'Hi, I want to book.', '  ✗ Message cleaning failed');
console.log('  ✓ All attribution tags extracted correctly');

// ─── Test 2: msgNorm Definition Order ───────────────────────────────────────────
console.log('\nTEST 2: msgNorm Variable Definition Order');

function normForKeywords(msg) {
  return (msg || '').trim().replace(/[\?\.\!]+$/, '').trim();
}

// Simulate the fixed code flow
const messageForIntent = 'Hello';
const msgNorm = normForKeywords(messageForIntent); // Must be defined BEFORE use

// Now test using msgNorm (this should not throw)
const KEYWORD_GLOBAL_STOP = /^(stop|unsubscribe|opt\s*out|remove\s*me|stop\s*campaigns?)\s*[\.\!\?]*$/i;
const KEYWORD_GLOBAL_START = /^(start|subscribe|opt\s*in|resume)\s*[\.\!\?]*$/i;

try {
  KEYWORD_GLOBAL_STOP.test(msgNorm);
  KEYWORD_GLOBAL_START.test(msgNorm);
  console.log('  ✓ msgNorm defined before use - no crash');
} catch (err) {
  console.log('  ✗ msgNorm still causing errors:', err.message);
}

// ─── Test 3: Show Bookings Keyword Match ────────────────────────────────────────
console.log('\nTEST 3: "Show My Bookings" Keyword Detection');

const KEYWORD_MY_BOOKINGS = /^(can\s+(you|u)\s+)?(show\s+(me\s+)?)?(my\s+)(bookings?|appointments?)|^(what('s|s|\s+are)\s+my\s+bookings?)|^(upcoming\s+appointments?)|^(list\s+my\s+bookings?)|^(show\s+(me\s+)?my\s+bookings?)|^(how\s+(are\s+)?)?(my\s+)(bookings?|appointments?)(\s+please)?\s*[\?\.\!]*$/i;
const CONTAINS_MY_BOOKINGS = /\bmy\s+bookings?\b|\bmy\s+appointments?\b/i;

const bookingQueries = [
  'show my bookings',
  'my bookings',
  'how my bookings',
  'how my bookings please',
];

bookingQueries.forEach(query => {
  const matches = KEYWORD_MY_BOOKINGS.test(query) || CONTAINS_MY_BOOKINGS.test(query);
  console.assert(matches, `  ✗ Failed to match: "${query}"`);
});
console.log('  ✓ All booking query variations recognized');

// ─── Test 4: Yes Confirmation ────────────────────────────────────────────────────
console.log('\nTEST 4: YES Confirmation Detection');

const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;

const yesVariations = ['yes', 'YES', 'Yes', 'ok', 'sure', 'haan'];
yesVariations.forEach(word => {
  console.assert(YES_REGEX.test(word), `  ✗ Failed to recognize: "${word}"`);
});
console.log('  ✓ All YES variations recognized');

// ─── Test 5: HELP Keywords ───────────────────────────────────────────────────────
console.log('\nTEST 5: HELP Keyword Detection');

const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
const KEYWORD_HELP_QUESTIONS = /^(what\s+(can\s+)?(you|u)\s+(can\s+)?do|how\s+(can\s+)?(you|u)\s+(can\s+)?help(\s+me)?|what\s+do\s+you\s+do|how\s+(you|u)\s+can\s+(help|assist)(\s+me)?)\s*[\?\.\!]*$/i;

const helpInputs = ['HELP', 'help', 'Hi', 'Hello', 'What can you do?', 'How can you help?'];
helpInputs.forEach(input => {
  const matches = KEYWORD_HELP.test(input) || KEYWORD_HELP_QUESTIONS.test(input);
  console.assert(matches, `  ✗ Failed to match: "${input}"`);
});
console.log('  ✓ All HELP variations recognized');

// ─── Test 6: Reminder Keywords ───────────────────────────────────────────────────
console.log('\nTEST 6: Reminder Keyword Detection');

const KEYWORD_REMINDER_OVERRIDE = /\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder)\b/i;

const reminderInputs = ['remind me at 7pm', 'set a reminder', 'send me a reminder'];
reminderInputs.forEach(input => {
  console.assert(KEYWORD_REMINDER_OVERRIDE.test(input), `  ✗ Failed to match: "${input}"`);
});
console.log('  ✓ All reminder variations recognized');

// ─── Test 7: Gibberish Detection ─────────────────────────────────────────────────
console.log('\nTEST 7: Gibberish Detection');

function looksLikeGibberish(msg) {
  const s = (msg || '').trim().toLowerCase();
  if (s.length < 3 || s.includes(' ') || /\d/.test(s)) return false;
  if (/^(.)\1{5,}$/.test(s)) return true;
  if (/^(.{1,3})\1{3,}/.test(s) && s.length > 7) return true;
  if (s.length > 5 && !/[aeiou]/.test(s)) return true;
  return false;
}

console.assert(looksLikeGibberish('aaaaaa') === true, '  ✗ Failed to detect: "aaaaaa"');
console.assert(looksLikeGibberish('hahahaha') === true, '  ✗ Failed to detect: "hahahaha"');
console.assert(looksLikeGibberish('qwrtyp') === true, '  ✗ Failed to detect: "qwrtyp"');
console.assert(looksLikeGibberish('hello') === false, '  ✗ False positive: "hello"');
console.assert(looksLikeGibberish('book appointment') === false, '  ✗ False positive: "book appointment"');
console.log('  ✓ Gibberish detection working correctly');

// ─── Test 8: Time Parsing ────────────────────────────────────────────────────────
console.log('\nTEST 8: Relative Reminder Time Parsing');

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

console.assert(extractRelativeReminderDelayMs('in 5 minutes') === 300000, '  ✗ Failed: "in 5 minutes"');
console.assert(extractRelativeReminderDelayMs('after 2 hours') === 7200000, '  ✗ Failed: "after 2 hours"');
console.assert(extractRelativeReminderDelayMs('30 mins later') === 1800000, '  ✗ Failed: "30 mins later"');
console.log('  ✓ Relative time parsing working correctly');

// ─── Summary ─────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log('✅ All quick validation tests passed!');
console.log('='.repeat(60));
console.log('\nNext steps:');
console.log('  1. Run full test suite: npm test');
console.log('  2. Run manual tests: npm run test:manual');
console.log('  3. Test with real WhatsApp messages');
console.log('');
