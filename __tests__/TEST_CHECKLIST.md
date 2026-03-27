# Chatbot Test Checklist

Use this checklist to manually verify all chatbot features are working correctly.

## ✅ Critical Bug Fixes

- [ ] **msgNorm bug fixed**: All messages process without "Sorry about the delay" error
- [ ] Attribution tags are extracted before intent classification
- [ ] No undefined variable errors in logs

## ✅ Attribution & Lead Tracking

### Attribution Tag Extraction
- [ ] `#src=whatsapp_book_now` extracts correctly
- [ ] `#cmp=spring_launch` extracts correctly  
- [ ] `#utm=instagram` extracts correctly
- [ ] Message is cleaned after tag extraction
- [ ] Multiple tags in one message work together
- [ ] Lead activity is tracked with correct source/campaign/utm

**Test message**: 
```
Hi, I want to book an appointment. #src=whatsapp_book_now #cmp=spring_launch #utm=instagram
```

Expected: Bot responds to booking intent, tags are logged in lead tracking

## ✅ Help & Greeting Keywords

### Single-word keywords
- [ ] `HELP` triggers help menu
- [ ] `help` triggers help menu
- [ ] `Hi` triggers greeting
- [ ] `Hello` triggers greeting
- [ ] `Hey` triggers greeting
- [ ] `Start` triggers help menu
- [ ] `Menu` triggers help menu

### Help questions
- [ ] `What can you do?` shows capabilities
- [ ] `How can you help?` shows capabilities
- [ ] `What do you do` shows capabilities

**Expected**: All variations show services or explain what bot can do, NOT error messages

## ✅ Show My Bookings

### All variations should work
- [ ] `show my bookings`
- [ ] `Show my bookings`
- [ ] `my bookings`
- [ ] `my appointments`
- [ ] `how my bookings`
- [ ] `how my bookings please`
- [ ] `what are my bookings`
- [ ] `upcoming appointments`

**Expected**: Lists appointments or says "schedule is clear", NOT "didn't quite catch"

## ✅ Confirmation Keywords

### YES variations
- [ ] `yes`
- [ ] `YES`
- [ ] `ok`
- [ ] `okay`
- [ ] `sure`
- [ ] `haan` (Hindi)
- [ ] `confirm`
- [ ] `go ahead`
- [ ] `👍` emoji

### NO variations
- [ ] `no`
- [ ] `NO`
- [ ] `nope`
- [ ] `nahi` (Hindi)
- [ ] `cancel`
- [ ] `❌` emoji

**Context**: Test in AWAITING_CONFIRMATION state (after bot proposes a booking)

## ✅ Acknowledgments

Test that these get a brief thank-you response, not a booking pitch:
- [ ] `thanks`
- [ ] `thank you`
- [ ] `perfect`
- [ ] `great`
- [ ] `awesome`
- [ ] `👍`

**Expected**: "Glad I could help" or similar, without repeating business name/services

## ✅ Reminder Feature

### Reminder detection
- [ ] `remind me at 7pm`
- [ ] `set a reminder`
- [ ] `send me a reminder`
- [ ] `remind me in 10 minutes`
- [ ] `after 2 hours remind me`

**Expected**: Bot confirms reminder will be sent, NOT confused with reschedule

### Relative time parsing
- [ ] `in 5 minutes` = 5 * 60 * 1000ms
- [ ] `after 2 hours` = 2 * 60 * 60 * 1000ms
- [ ] `10 mins later` = 10 * 60 * 1000ms

## ✅ Repeat Booking

### Same service keywords
- [ ] `book the same again`
- [ ] `same as last time`
- [ ] `rebook`
- [ ] `book it again`
- [ ] `same appointment`
- [ ] `similar to last`

**Expected**: Bot prefills last service and staff, asks for date

## ✅ Booking Flow

### Complete flow
1. [ ] User: `I want to book an appointment`
2. [ ] Bot: Shows service list
3. [ ] User: Selects service (by number or name)
4. [ ] Bot: Asks for date
5. [ ] User: Provides date (e.g., "tomorrow", "Friday")
6. [ ] Bot: Shows available time slots
7. [ ] User: Selects time (by number or time)
8. [ ] Bot: Asks for name (if new user) or shows confirmation
9. [ ] User: Confirms with "yes"
10. [ ] Bot: Books appointment, shows confirmation

### Smart suggestions
- [ ] Bot suggests specific slot when user says time preference
- [ ] Bot sorts slots by proximity when preferred time not available
- [ ] Bot remembers time preference across date changes

## ✅ Cancel Flow

1. [ ] User: `cancel my appointment`
2. [ ] Bot: Lists appointments or asks which one
3. [ ] User: Selects appointment
4. [ ] Bot: Confirms cancellation

### Cancel flow abort
- [ ] User starts booking, says `cancel` → clears flow without canceling appointment

## ✅ Reschedule Flow

1. [ ] User: `reschedule my appointment`
2. [ ] Bot: Lists appointments or asks which one
3. [ ] User: Selects appointment
4. [ ] Bot: Asks for new date
5. [ ] User: Provides date
6. [ ] Bot: Shows slots
7. [ ] User: Selects time
8. [ ] Bot: Asks for YES/NO confirmation
9. [ ] User: Confirms
10. [ ] Bot: Reschedules appointment

## ✅ Availability Check

- [ ] `what's available this week`
- [ ] `any slots tomorrow`
- [ ] `when are you free`

**Expected**: Shows availability summary for date/week

## ✅ STOP/START (Opt-out)

- [ ] User: `STOP` → Bot confirms unsubscription
- [ ] User: `START` → Bot confirms re-subscription
- [ ] Booking messages still work after STOP

## ✅ Human Handoff

- [ ] `I want to talk to a human`
- [ ] `speak with someone`
- [ ] `talk to manager`
- [ ] `need help urgently`

**Expected**: Bot says team will reach out, sets AWAITING_HANDOFF state

## ✅ Multi-language Support

### Hindi/Hinglish
- [ ] `haan` (yes) works in confirmation
- [ ] `nahi` (no) works in confirmation
- [ ] `kal` (tomorrow) works for dates
- [ ] `5 baje` (5 o'clock) works for times

## ✅ Error Handling

- [ ] Empty message → helpful response
- [ ] Gibberish (aaaaaa) → conversational response
- [ ] Very long message → handled gracefully
- [ ] Invalid date → asks to try again
- [ ] Invalid time → shows available times
- [ ] No slots available → offers different date

## ✅ Session Management

- [ ] Session persists across messages
- [ ] Session times out after 10 minutes (active flow)
- [ ] Session times out after 30 minutes (idle)
- [ ] RESTART command clears session
- [ ] CONTINUE command resumes flow

## ✅ Inactivity Nudges

- [ ] After 5 minutes of no reply, bot sends gentle nudge
- [ ] Nudge is cancelled when user replies
- [ ] Nudge only sent during active flows, not IDLE

## ✅ WhatsApp Message Types

- [ ] Text messages
- [ ] Button responses
- [ ] Interactive list responses
- [ ] Audio messages (with transcription)

## ✅ Business Routing

- [ ] Routes to correct business by WhatsApp number
- [ ] Uses explicit business ID when provided
- [ ] Falls back to default business

## Running the Tests

### Automated Tests
```bash
# Run all unit tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Quick Validation
```bash
node __tests__/quick-test.js
```

### Manual Testing (Live Server)
```bash
# Terminal 1: Start backend
npm run dev

# Terminal 2: Run manual tests
npm run test:manual
```

### Real WhatsApp Testing
1. Send messages to your WhatsApp number
2. Check server logs for errors
3. Verify responses are appropriate
4. Check database for correct lead/appointment records

## Success Criteria

All tests should show:
- ✅ No "Sorry about the delay" messages
- ✅ No "hit a small hiccup" error fallbacks
- ✅ Proper intent recognition
- ✅ Correct state transitions
- ✅ Attribution tracking in logs
- ✅ All keywords recognized
- ✅ Smooth conversation flow
- ✅ No crashes or undefined errors

## Common Issues to Watch For

1. **msgNorm undefined**: Fixed - variable now defined before use
2. **Attribution not tracked**: Fixed - extraction happens before classification
3. **"Show my bookings" not recognized**: Fixed - comprehensive regex patterns
4. **"Yes" treated as vague**: Fixed - YES_REGEX checks before LLM
5. **Reminder vs Reschedule confusion**: Fixed - KEYWORD_REMINDER_OVERRIDE

## Test Results

**Date**: March 27, 2026  
**Total Tests**: 134  
**Status**: ✅ All Passing  

Last test run: Run `npm test` to update
