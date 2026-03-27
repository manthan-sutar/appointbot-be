# AppointBot Test Suite

Comprehensive test coverage for the AppointBot WhatsApp chatbot.

## Test Files

### 1. `__tests__/webhook.test.js`
Tests for webhook route and core chatbot logic:
- ✅ Attribution extraction (#src, #cmp, #utm tags)
- ✅ Keyword detection (HELP, show bookings, YES/NO, etc.)
- ✅ Gibberish detection
- ✅ Relative reminder parsing
- ✅ Message normalization
- ✅ STOP/START opt-out keywords
- ✅ Handoff detection

### 2. `__tests__/ai.service.test.js`
Tests for AI/LLM service functions:
- ✅ Intent classification (book, cancel, reschedule, etc.)
- ✅ Booking intent extraction (service, date, time)
- ✅ Confirmation extraction (yes/no/unknown)
- ✅ Reschedule intent extraction
- ✅ Availability query parsing
- ✅ Conversational responses
- ✅ Help reply generation
- ✅ Returning user greeting
- ✅ Inactivity nudge generation
- ✅ JSON parsing from LLM responses

### 3. `__tests__/session.service.test.js`
Tests for session management:
- ✅ Phone number normalization
- ✅ State definitions
- ✅ State uniqueness

### 4. `__tests__/utils.test.js`
Tests for utility functions:
- ✅ Date formatting
- ✅ Time formatting
- ✅ Time to minutes conversion
- ✅ Slot curation logic
- ✅ Proximity-based slot sorting
- ✅ WhatsApp message formatting

### 5. `__tests__/integration.test.js`
Integration tests for complete conversation flows:
- ✅ Full booking flow with attribution
- ✅ Multi-step conversations
- ✅ State transitions
- ✅ Business routing
- ✅ Error scenarios

### 6. `__tests__/manual-test.js`
Manual test script for testing against live backend:
- ✅ All features tested end-to-end
- ✅ Real server responses
- ✅ Color-coded output
- ✅ Comprehensive scenario coverage

## Running Tests

### Unit & Integration Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:coverage
```

### Manual Tests (Live Server)
```bash
# Start the backend server first
npm run dev

# In another terminal, run manual tests
npm run test:manual
```

## Test Coverage

### Features Tested

#### 1. **Attribution Tracking** ✅
- Extract #src tags
- Extract #cmp campaign tags
- Extract #utm source tags
- Clean message after extraction
- Track lead source properly

#### 2. **Keyword Detection** ✅
- HELP keywords (hi, hello, help, menu, etc.)
- Show bookings variations
- YES confirmations (yes, ok, sure, haan, etc.)
- NO denials (no, nahi, cancel, etc.)
- Acknowledgments (thanks, perfect, great, etc.)
- STOP/START opt-out keywords
- Reminder keywords
- Same service/rebook keywords
- Handoff request keywords

#### 3. **Intent Classification** ✅
- Book appointment
- Cancel appointment
- Reschedule appointment
- Show my appointments
- Check availability
- Set reminder
- Request human handoff
- Help/FAQ
- Conversational messages

#### 4. **Booking Flow** ✅
- Service selection
- Date selection
- Time selection
- Name collection (if new user)
- Confirmation
- Complete booking
- Error handling (slot taken, no availability)

#### 5. **Cancel Flow** ✅
- List appointments
- Select appointment to cancel
- Confirm cancellation
- Handle "no" to keep appointment

#### 6. **Reschedule Flow** ✅
- List appointments
- Select appointment
- Pick new date
- Pick new time
- Confirm reschedule

#### 7. **Smart Features** ✅
- Repeat booking (prefill last service/staff)
- Time preference storage
- Proximity-based slot suggestions
- Inactivity nudges
- Smart reminder scheduling

#### 8. **Error Handling** ✅
- Gibberish detection
- Empty messages
- Invalid dates/times
- Missing data
- LLM failures
- Network errors
- **msgNorm bug fix** (variable defined before use)

#### 9. **Multi-language** ✅
- English support
- Hindi support (haan, nahi, kal, baje)
- Hinglish support

#### 10. **Session Management** ✅
- Session creation
- State transitions
- Timeout handling
- Session reset

## Key Bug Fixes Tested

### msgNorm Variable Bug ✅
**Fixed**: Variable `msgNorm` was used on lines 287 and 297 before being defined on line 309.

**Test**: Verify that all messages are processed without throwing errors about undefined variables.

**Affected scenarios**:
- Any message with attribution tags
- STOP/START keywords
- Any message that checks msgNorm early in the flow

**Verification**: The manual test suite sends various messages and ensures none trigger the "Sorry about the delay" error fallback.

## Test Scenarios from Real Chat Log

The test suite includes scenarios directly from the provided chat conversation:

1. **PJ → Help flow**: Tests that gibberish greeting + HELP works correctly
2. **Attribution tags**: Tests `#src=whatsapp_book_now #cmp=spring_launch #utm=instagram`
3. **Hello after delay**: Tests that "Hello" doesn't trigger error fallback
4. **Show my bookings**: Tests all variations including "how my bookings"
5. **Yes response**: Tests that "Yes" is properly recognized in context

## Expected Output

All tests should pass with:
- ✅ No "Sorry about the delay" messages
- ✅ No "hit a small hiccup" error fallbacks
- ✅ Proper intent recognition
- ✅ Correct state transitions
- ✅ Attribution tracking working
- ✅ All keywords recognized

## Continuous Testing

Run tests before:
- Deploying to production
- Making changes to webhook logic
- Updating AI prompts
- Modifying session management
- Adding new features

## Notes

- AI service tests may take 15-30 seconds as they call the actual LLM
- Manual tests require a running backend server
- Integration tests verify realistic conversation flows
- All regex patterns are tested against known inputs
- Edge cases (gibberish, empty, long messages) are covered
