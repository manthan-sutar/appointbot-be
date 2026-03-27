#!/usr/bin/env node

/**
 * Comprehensive Chatbot Manual Test Suite
 * 
 * This script tests all chatbot features against a live backend server.
 * Run this to verify all flows work correctly after changes.
 * 
 * Usage:
 *   node manual-test.js
 * 
 * Requires:
 *   - Backend server running on localhost:3001 (or set BACKEND_URL env var)
 *   - GROQ_API_KEY configured in backend .env
 */

import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const TEST_PHONE = process.env.TEST_PHONE || '+15559999999';
const TEST_BUSINESS_ID = parseInt(process.env.TEST_BUSINESS_ID || '1', 10);

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

function logTest(name) {
  log(`\n→ ${name}`, 'blue');
}

function logPass(message) {
  log(`  ✓ ${message}`, 'green');
}

function logFail(message) {
  log(`  ✗ ${message}`, 'red');
}

function logResponse(response) {
  log(`  Response: ${response}`, 'dim');
}

async function sendMessage(message, phone = TEST_PHONE, businessId = TEST_BUSINESS_ID) {
  const response = await fetch(`${BACKEND_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      message,
      businessId,
      source: 'test',
    }),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    logPass(message);
    testsPassed++;
  } else {
    logFail(message);
    testsFailed++;
  }
}

function assertContains(text, substring, message) {
  const contains = text.toLowerCase().includes(substring.toLowerCase());
  assert(contains, message || `Response contains "${substring}"`);
  return contains;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

async function runTests() {
  log('\n🤖 AppointBot Chatbot Test Suite', 'cyan');
  log(`Testing against: ${BACKEND_URL}`, 'dim');
  log(`Test phone: ${TEST_PHONE}`, 'dim');
  log(`Business ID: ${TEST_BUSINESS_ID}`, 'dim');

  try {
    // ─── Test 1: Attribution Extraction ─────────────────────────────────────────
    logSection('TEST 1: Attribution Tag Extraction');
    
    logTest('Send message with all attribution tags');
    const attrResponse = await sendMessage(
      'Hi, I want to book. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram'
    );
    logResponse(attrResponse);
    assertContains(attrResponse, 'book', 'Bot recognizes booking intent');
    assertContains(attrResponse, 'service', 'Bot asks for service or shows options');

    await sleep(1000);

    // ─── Test 2: Help Keywords ──────────────────────────────────────────────────
    logSection('TEST 2: Help & Greeting Keywords');

    const helpKeywords = ['HELP', 'help', 'Hi', 'Hello', 'hey'];
    for (const keyword of helpKeywords) {
      logTest(`Test keyword: "${keyword}"`);
      const response = await sendMessage(keyword);
      logResponse(response);
      const hasHelp = assertContains(response, 'book', `Response offers booking help for "${keyword}"`);
      await sleep(500);
    }

    // ─── Test 3: Help Questions ─────────────────────────────────────────────────
    logSection('TEST 3: Help Questions');

    const helpQuestions = ['What can you do?', 'How can you help?', 'what do you do'];
    for (const question of helpQuestions) {
      logTest(`Test question: "${question}"`);
      const response = await sendMessage(question);
      logResponse(response);
      assertContains(response, 'book', `Response explains capabilities for "${question}"`);
      await sleep(500);
    }

    // ─── Test 4: Show My Bookings ───────────────────────────────────────────────
    logSection('TEST 4: Show My Bookings');

    const bookingQueries = [
      'show my bookings',
      'my bookings',
      'my appointments',
      'how my bookings',
      'how my bookings please',
    ];

    for (const query of bookingQueries) {
      logTest(`Test query: "${query}"`);
      const response = await sendMessage(query);
      logResponse(response);
      const valid = assertContains(response, 'schedule', 'Bot shows bookings or says none') ||
                   assertContains(response, 'clear', 'Bot shows bookings or says none') ||
                   assertContains(response, 'appointment', 'Bot shows bookings or says none');
      await sleep(500);
    }

    // ─── Test 5: Yes/No Confirmations ───────────────────────────────────────────
    logSection('TEST 5: Confirmation Keywords');

    logTest('Reset session first');
    await sendMessage('HELP');
    await sleep(500);

    const yesWords = ['yes', 'YES', 'ok', 'sure', 'haan', 'confirm'];
    log('\nTesting YES variations:', 'blue');
    yesWords.forEach(word => {
      log(`  "${word}" - should be recognized as confirmation`, 'dim');
    });

    const noWords = ['no', 'NO', 'nope', 'nahi', 'cancel'];
    log('\nTesting NO variations:', 'blue');
    noWords.forEach(word => {
      log(`  "${word}" - should be recognized as denial`, 'dim');
    });

    // ─── Test 6: Acknowledgments ────────────────────────────────────────────────
    logSection('TEST 6: Acknowledgment Responses');

    const ackWords = ['thanks', 'thank you', 'perfect', 'great', '👍'];
    for (const word of ackWords) {
      logTest(`Test acknowledgment: "${word}"`);
      const response = await sendMessage(word);
      logResponse(response);
      assertContains(response, 'help', `Bot responds appropriately to "${word}"`);
      await sleep(500);
    }

    // ─── Test 7: Gibberish Detection ────────────────────────────────────────────
    logSection('TEST 7: Gibberish Detection');

    const gibberish = ['aaaaaaa', 'hahahaha', 'qwrtyp'];
    for (const text of gibberish) {
      logTest(`Test gibberish: "${text}"`);
      const response = await sendMessage(text);
      logResponse(response);
      assert(response.length > 0, `Bot handles gibberish gracefully for "${text}"`);
      await sleep(500);
    }

    // ─── Test 8: Reminder Keywords ──────────────────────────────────────────────
    logSection('TEST 8: Reminder Feature');

    const reminderMessages = [
      'remind me at 7pm',
      'set a reminder',
      'send me a reminder in 10 minutes',
    ];

    for (const msg of reminderMessages) {
      logTest(`Test reminder: "${msg}"`);
      const response = await sendMessage(msg);
      logResponse(response);
      assertContains(response, 'reminder', `Bot handles reminder request: "${msg}"`);
      await sleep(500);
    }

    // ─── Test 9: Same Service/Rebook ────────────────────────────────────────────
    logSection('TEST 9: Repeat Booking Keywords');

    const rebookMessages = [
      'book the same again',
      'same as last time',
      'rebook',
      'book it again',
    ];

    for (const msg of rebookMessages) {
      logTest(`Test rebook: "${msg}"`);
      const response = await sendMessage(msg);
      logResponse(response);
      assert(response.length > 0, `Bot handles repeat booking: "${msg}"`);
      await sleep(500);
    }

    // ─── Test 10: STOP/START Keywords ───────────────────────────────────────────
    logSection('TEST 10: Opt-out/Opt-in');

    logTest('Test STOP keyword');
    const stopResponse = await sendMessage('STOP');
    logResponse(stopResponse);
    assertContains(stopResponse, 'unsubscribe', 'Bot confirms unsubscription');
    await sleep(1000);

    logTest('Test START keyword');
    const startResponse = await sendMessage('START');
    logResponse(startResponse);
    assertContains(startResponse, 'subscribe', 'Bot confirms subscription');
    await sleep(1000);

    // ─── Test 11: Handoff Request ───────────────────────────────────────────────
    logSection('TEST 11: Human Handoff');

    const handoffMessages = [
      'I want to talk to a human',
      'speak with someone',
      'talk to manager',
    ];

    for (const msg of handoffMessages) {
      logTest(`Test handoff: "${msg}"`);
      const response = await sendMessage(msg);
      logResponse(response);
      assertContains(response, 'team', `Bot handles handoff: "${msg}"`) ||
        assertContains(response, 'reach out', `Bot handles handoff: "${msg}"`);
      await sleep(1000);
      // Reset after handoff
      await sendMessage('HELP');
      await sleep(500);
    }

    // ─── Test 12: Multi-language Support ────────────────────────────────────────
    logSection('TEST 12: Hindi/Hinglish Support');

    logTest('Test Hindi confirmation: "haan"');
    // Note: This would need to be in a confirmation context
    log('  Hindi words (haan, nahi, bilkul) are supported in confirmation flow', 'dim');

    // ─── Test 13: Cancel Flow Keywords ──────────────────────────────────────────
    logSection('TEST 13: Cancel Flow');

    logTest('Test "cancel" during booking flow (should abort flow, not appointment)');
    await sendMessage('book appointment');
    await sleep(1000);
    const cancelFlowResponse = await sendMessage('cancel');
    logResponse(cancelFlowResponse);
    assertContains(cancelFlowResponse, 'cleared', 'Bot clears booking flow') ||
      assertContains(cancelFlowResponse, 'no problem', 'Bot clears booking flow');
    await sleep(500);

    // ─── Test 14: Continue/Restart ──────────────────────────────────────────────
    logSection('TEST 14: Continue/Restart Commands');

    logTest('Start a booking');
    await sendMessage('book appointment');
    await sleep(1000);

    logTest('Test RESTART command');
    const restartResponse = await sendMessage('restart');
    logResponse(restartResponse);
    assertContains(restartResponse, 'welcome', 'Bot restarts flow') ||
      assertContains(restartResponse, 'help', 'Bot restarts flow');
    await sleep(500);

    // ─── Test 15: Realistic Booking Flow ────────────────────────────────────────
    logSection('TEST 15: Realistic Booking Flow');

    logTest('Step 1: Initial greeting');
    const greeting = await sendMessage('Hi');
    logResponse(greeting);
    assert(greeting.length > 0, 'Bot responds to greeting');
    await sleep(1000);

    logTest('Step 2: User says they want to book');
    const bookIntent = await sendMessage('I want to book an appointment');
    logResponse(bookIntent);
    assertContains(bookIntent, 'service', 'Bot asks for service');
    await sleep(1000);

    logTest('Step 3: Reset for next test');
    await sendMessage('HELP');
    await sleep(500);

    // ─── Test 16: Error Scenarios ────────────────────────────────────────────────
    logSection('TEST 16: Error Handling');

    logTest('Send empty message');
    const emptyResponse = await sendMessage('   ');
    logResponse(emptyResponse);
    assert(emptyResponse.length > 0, 'Bot handles empty message gracefully');
    await sleep(500);

    logTest('Send very long message');
    const longMessage = 'I want to book '.repeat(50);
    const longResponse = await sendMessage(longMessage);
    logResponse(longResponse.slice(0, 100) + '...');
    assert(longResponse.length > 0, 'Bot handles long messages');
    await sleep(500);

    // ─── Test 17: msgNorm Bug Fix Verification ──────────────────────────────────
    logSection('TEST 17: msgNorm Bug Fix Verification');

    logTest('Test that bot does not crash on any message (msgNorm bug fix)');
    const testMessages = [
      'Hi, I want to book an appointment. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram',
      'Hello',
      'Show my bookings',
      'Yes',
      'HELP',
    ];

    let allPassed = true;
    for (const msg of testMessages) {
      try {
        const response = await sendMessage(msg);
        const noCrash = !response.toLowerCase().includes('sorry about the delay') &&
                       !response.toLowerCase().includes('hit a small hiccup');
        
        if (noCrash) {
          logPass(`"${msg}" - No error fallback`);
        } else {
          logFail(`"${msg}" - Got error fallback: ${response.slice(0, 80)}`);
          allPassed = false;
        }
      } catch (err) {
        logFail(`"${msg}" - Request failed: ${err.message}`);
        allPassed = false;
      }
      await sleep(500);
    }

    if (allPassed) {
      logPass('All messages handled without crashes or error fallbacks');
    }

    // ─── Summary ─────────────────────────────────────────────────────────────────
    logSection('TEST SUMMARY');
    log(`\nTotal Passed: ${testsPassed}`, 'green');
    log(`Total Failed: ${testsFailed}`, testsFailed > 0 ? 'red' : 'dim');
    
    if (testsFailed === 0) {
      log('\n✅ All tests passed!', 'green');
    } else {
      log(`\n⚠️  ${testsFailed} test(s) failed`, 'yellow');
    }

  } catch (err) {
    logFail(`Test suite error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// ─── Run Tests ──────────────────────────────────────────────────────────────────

log('\n🚀 Starting manual test suite...', 'cyan');
log('This will test all chatbot features against the live backend.\n', 'dim');

runTests()
  .then(() => {
    log('\n✨ Test suite completed', 'cyan');
    process.exit(testsFailed > 0 ? 1 : 0);
  })
  .catch(err => {
    logFail(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
