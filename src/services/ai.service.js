import 'dotenv/config';

const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const GROQ_MODEL    = process.env.GROQ_MODEL    || 'llama-3.3-70b-versatile';
const OLLAMA_URL    = process.env.OLLAMA_URL    || 'http://localhost:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL  || 'llama3';

const WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT = `
You are a human receptionist texting on WhatsApp for an appointment booking business.

STRICT OUTPUT RULES (always follow):
- Maximum 2–3 lines total. Never more than 3 non-empty lines.
- No paragraphs: do NOT use blank lines. Use line breaks only.
- One idea per message. Keep it punchy and direct.
- Sound like a human receptionist texting, not a formal assistant or email.
- Never use more than 2 emojis total.
- Never repeat information already given in the conversation. Do not restate the business name/services unless the user asked again.
- Get straight to the point. No filler phrases like:
  "That's a great question", "I'd be happy to help", "Certainly", "Of course", "Absolutely",
  "How may I assist you", "We offer ...", "Our staff are ready ...", "Feel free to ...".

Formatting:
- Prefer short lines.
- If you need to give options, put each option on its own line.
`.trim();

// ─── LLM router ──────────────────────────────────────────────────────────────

async function callLLM(prompt, { temperature = 0, systemPrompt = null } = {}) {
  if (GROQ_API_KEY) {
    const messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }];
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Ollama fallback
  const fullPrompt = systemPrompt
    ? `SYSTEM:\n${systemPrompt}\n\nUSER:\n${prompt}`.trim()
    : prompt;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: fullPrompt, stream: false }),
  });
  const data = await res.json();
  return data.response || '';
}

// ─── JSON parser (same bracket-counting approach as sparebot) ─────────────────

function parseJSON(raw) {
  try {
    const cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    // Find first { or [
    const firstBrace  = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    let start = -1;
    let isArray = false;

    if (firstBrace === -1 && firstBracket === -1) return null;
    if (firstBrace === -1) { start = firstBracket; isArray = true; }
    else if (firstBracket === -1) { start = firstBrace; isArray = false; }
    else if (firstBracket < firstBrace) { start = firstBracket; isArray = true; }
    else { start = firstBrace; isArray = false; }

    const open  = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';
    let depth = 0;
    let end = -1;

    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === open)  depth++;
      if (cleaned[i] === close) depth--;
      if (depth === 0) { end = i; break; }
    }

    if (end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ─── Timezone-aware date helpers ─────────────────────────────────────────────

function getTodayInTZ(tz = 'Asia/Kolkata') {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function getTomorrowInTZ(tz = 'Asia/Kolkata') {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

// Returns the next 7 days as YYYY-MM-DD strings (for the LLM to resolve weekday names)
function getNextWeekDatesInTZ(tz = 'Asia/Kolkata') {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const result = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const str = d.toLocaleDateString('en-CA', { timeZone: tz });
    const dow = new Date(str + 'T12:00:00').getDay();
    result.push(`${days[dow]} = ${str}`);
  }
  return result.join(', ');
}

// ─── 1. Extract booking intent from natural language ─────────────────────────
// Returns: { service, date, time, staffName } — all optional / null

export async function extractBookingIntent(message, serviceList = [], tz = 'Asia/Kolkata') {
  const today    = getTodayInTZ(tz);
  const tomorrow = getTomorrowInTZ(tz);
  const nextWeek = getNextWeekDatesInTZ(tz);
  const servicesText = serviceList.length
    ? `Available services: ${serviceList.join(', ')}.`
    : '';

  const prompt = `
Today's date is ${today} (timezone: ${tz}).
Upcoming dates (use these to resolve weekday names — always pick the NEXT upcoming occurrence, never a past date):
${nextWeek}
${servicesText}

The user sent: "${message}"

Extract appointment booking intent. Return a JSON object with these keys:
- "service": the service they want (string, or null if unclear)
- "date": the resolved date in YYYY-MM-DD format (e.g. "tomorrow" → actual date, or null)
- "time": the time in HH:MM 24h format (e.g. "5pm" → "17:00", or null)
- "staffName": preferred staff name if mentioned (string, or null)

Date/time resolution rules:
- "tomorrow" / "kal" / "aane wala din" = ${tomorrow}
- "today" / "aaj" = ${today}
- For weekday names like "Monday", "Tuesday" etc. — use the upcoming dates list above. NEVER resolve to a past date.
- "next Monday" = the Monday in the upcoming dates list
- "this weekend" → the upcoming Saturday (use upcoming dates list)
- "this week" → the soonest weekday available (use today's date)
- Fuzzy time: "morning"/"subeh"/"subah" → "10:00", "afternoon"/"dopahar" → "14:00", "evening"/"shaam" → "17:00", "night"/"raat" → "19:00"
- "before lunch" / "before noon" → "11:00"
- "after lunch" / "post lunch" → "13:30"
- "around X" = use X as the time (e.g. "around 10 am" → "10:00")
- "anytime after X" / "after X" → use X as the time (e.g. "anytime after 5" → "17:00")
- "anytime before X" / "before X" → use 1 hour before X (e.g. "before 3pm" → "14:00")
- "5 pm", "5:00 pm", "17", "17h", "5 o'clock", "5 baje", "paanch baje" → "17:00"
- "9 baje" → "09:00", "6 baje shaam" → "18:00"
- "first thing" / "early" → "09:00"
- "late afternoon" → "16:00"
- "end of day" / "closing time" → "17:30"
- Understands Hindi, Hinglish, and English date/time expressions
- "anytime", "any day", "any date", "flexible", "whenever", "koi bhi din" → date: null (do NOT default to today)
- "anytime in the evening/morning/afternoon" → date: null, but set time to the matching fuzzy value
- "anytime after X" → date: null, time: X resolved. "anytime before X" → date: null, time: 1 hour before X
- If no date/time mentioned, return null for those fields
- Return ONLY the JSON object, no explanation

Example output: {"service":"haircut","date":"${tomorrow}","time":"17:00","staffName":null}
`.trim();

  try {
    const raw = await callLLM(prompt);
    const result = parseJSON(raw);
    return result || { service: null, date: null, time: null, staffName: null };
  } catch {
    return { service: null, date: null, time: null, staffName: null };
  }
}

// ─── 1b. Extract reschedule intent ───────────────────────────────────────────
// Returns: { date, time } — the new desired date/time

export async function extractRescheduleIntent(message, tz = 'Asia/Kolkata') {
  const today    = getTodayInTZ(tz);
  const tomorrow = getTomorrowInTZ(tz);
  const nextWeek = getNextWeekDatesInTZ(tz);

  const prompt = `
Today's date is ${today} (timezone: ${tz}).
Upcoming dates (use these to resolve weekday names — always pick the NEXT upcoming occurrence, never a past date):
${nextWeek}
The user wants to reschedule an appointment. They said: "${message}"

Extract the NEW date and time they want. Return a JSON object:
- "date": resolved date in YYYY-MM-DD format, or null
- "time": time in HH:MM 24h format, or null

Rules:
- "tomorrow" / "kal" = ${tomorrow}
- "today" / "aaj" = ${today}
- For weekday names like "Monday" etc. — use the upcoming dates list above. NEVER resolve to a past date.
- "around X" = use X as the time
- Fuzzy time: "morning"/"subeh" → "10:00", "afternoon"/"dopahar" → "14:00", "evening"/"shaam" → "17:00"
- "X baje" → resolve to HH:00 (e.g. "9 baje" → "09:00", "6 baje shaam" → "18:00")
- Understands Hindi, Hinglish, and English
- Return ONLY the JSON object.

Example: {"date":"${tomorrow}","time":"15:00"}
`.trim();

  try {
    const raw = await callLLM(prompt);
    const result = parseJSON(raw);
    return result || { date: null, time: null };
  } catch {
    return { date: null, time: null };
  }
}

// ─── 1c. Extract availability query intent ────────────────────────────────────
// Returns: { date } or { weekStart, weekEnd } for "this week" queries

export async function extractAvailabilityQuery(message, tz = 'Asia/Kolkata') {
  const today = getTodayInTZ(tz);
  const nextWeek = getNextWeekDatesInTZ(tz);
  // "this week" = today through next 6 days
  const todayDate = new Date(today + 'T12:00:00');
  const weekEnd = new Date(todayDate);
  weekEnd.setDate(todayDate.getDate() + 6);
  const weekEndStr = weekEnd.toLocaleDateString('en-CA', { timeZone: tz });

  const prompt = `
Today is ${today}.
Upcoming dates (use these to resolve weekday names — always pick the NEXT upcoming occurrence, never a past date):
${nextWeek}

The user asked about availability: "${message}"

Return a JSON object:
- "type": "day" if asking about a specific day, "week" if asking about this week or next few days
- "date": if type is "day", the resolved YYYY-MM-DD date (or null)
- "weekStart": if type is "week", start date YYYY-MM-DD (use today: ${today})
- "weekEnd": if type is "week", end date YYYY-MM-DD (use ${weekEndStr} for "this week")

Return ONLY the JSON object.
`.trim();

  try {
    const raw = await callLLM(prompt);
    const result = parseJSON(raw);
    return result || { type: 'week', weekStart: today, weekEnd: weekEndStr };
  } catch {
    return { type: 'week', weekStart: today, weekEnd: weekEndStr };
  }
}

// ─── 2. Single-shot classifier: handoff + intent in one LLM call ─────────────
// Replaces two sequential LLM calls (detectHandoffIntent + extractGlobalIntent).
// Returns { handoff: bool, intent: string }
//
// Fast regex shortcuts that skip the LLM entirely for obvious cases.
const HANDOFF_REGEX_FAST = /\b(human|person|agent|manager|owner|reception|real person|live (chat|support)|talk to (a |someone)|speak (to|with) (a |someone)|need help urgently)\b/i;

const VALID_INTENTS = ['book', 'cancel', 'reschedule', 'repeat_booking', 'reminder', 'my_appointments',
  'availability', 'help', 'contact', 'faq', 'none'];

export async function classifyMessage(message, serviceNames = []) {
  // Fast-path: clear handoff request → skip LLM
  if (HANDOFF_REGEX_FAST.test(message)) {
    return { handoff: true, intent: 'none' };
  }

  const servicesHint = serviceNames.length
    ? `Services at this business: ${serviceNames.join(', ')}.`
    : '';

  const prompt = `
You are a classifier for a WhatsApp appointment booking assistant.

Given the user message, return a JSON object with EXACTLY two fields:
- "handoff": true if the user wants to stop talking to the bot and speak to a real human, otherwise false
- "intent": exactly one of: "book", "cancel", "reschedule", "repeat_booking", "reminder", "my_appointments", "availability", "help", "contact", "faq", "none"

${servicesHint}
User message: "${message}"

Intent rules:
- "book" — wants to book/schedule, mentions a service name, OR mentions a date/time
- "cancel" — cancel an existing appointment
- "reschedule" — MOVE/CHANGE an existing appointment to a new date/time
- "repeat_booking" — wants to BOOK A NEW appointment similar to the last one / same appointment again (do NOT modify existing booking). Trigger phrases include: "same appointment", "book again", "similar to last", "same one", "repeat booking", "one more like before", "same one next month"
- "reminder" — wants the bot to NOTIFY them at a specific time (e.g. "remind me at 7pm", "send me a reminder"). NOT the same as reschedule.
- "my_appointments" — wants to see their upcoming bookings
- "availability" — asks what slots/times are free
- "help" — asks for help or what the bot can do
- "contact" — wants business phone/address/hours
- "faq" — general question about the bot/service
- "none" — casual greeting, off-topic, gibberish, unclear

CRITICAL: "remind me at 7pm" → "reminder". "reschedule to 7pm" → "reschedule". Never confuse these.
Understands English, Hindi, Hinglish.

Return ONLY valid JSON. Example: {"handoff":false,"intent":"book"}
`.trim();

  try {
    const raw = await callLLM(prompt, { temperature: 0 });
    const parsed = parseJSON(raw);
    const intent = parsed?.intent?.toLowerCase().replace(/[^a-z_]/g, '') || 'none';
    return {
      handoff: Boolean(parsed?.handoff),
      intent: VALID_INTENTS.includes(intent) ? intent : 'none',
    };
  } catch (err) {
    console.error('[AI] classifyMessage failed:', err.message);
    return { handoff: false, intent: 'none' };
  }
}

// ─── 2b. Classify global intent (legacy — kept for backward compat) ────────────
// Returns one of: "book", "cancel", "reschedule", "reminder", "my_appointments",
//                 "availability", "help", "contact", "faq", "none"

export async function extractGlobalIntent(message, serviceNames = []) {
  const servicesHint = serviceNames.length
    ? `Known services at this business: ${serviceNames.join(', ')}.`
    : '';

  const prompt = `
Classify this message into exactly one intent. Return only the intent word.

Message: "${message}"
${servicesHint}

Intents:
- "book"            — user wants to book/schedule an appointment, OR mentions a service name (e.g. "root canal", "haircut", "checkup"), OR says a date/time (e.g. "kal 5 baje", "tomorrow 9am")
- "cancel"          — user wants to cancel an existing appointment
- "reschedule"      — user wants to MOVE or CHANGE the date/time of an existing appointment (e.g. "reschedule my booking", "move my appointment to Friday")
- "reminder"        — user asks the bot to REMIND them at a specific time (e.g. "remind me at 7pm", "can you remind me about this", "send me a reminder today at 6", "yaad dila dena"). This is NOT reschedule — the user wants to keep the appointment but receive a notification at a certain time.
- "my_appointments" — user wants to SEE or LIST their upcoming appointments (e.g. "show my bookings", "can u show me my bookings", "my bookings", "my appointments", "how my bookings please", "how are my bookings", "what are my appointments", "upcoming appointments", "list my bookings", "do I have any bookings")
- "availability"    — user asks what slots/times are free (e.g. "what's available", "when can I come", "any slots this week")
- "help"            — user asks for help or what the bot can do
- "contact"         — user wants to reach the business (phone, address, hours)
- "faq"             — user asks a general question about the bot/service (e.g. "which languages do you support", "do you speak Hindi", "what is this", "are you a bot")
- "none"            — casual greetings, off-topic, or anything else

IMPORTANT: "remind me at 7pm" = "reminder". "reschedule to 7pm" = "reschedule". Do NOT confuse them.
Understands English, Hindi, and Hinglish (e.g. "kal appointment chahiye", "booking karni hai", "yaad dilao").
Return only the intent word.
`.trim();

  try {
    const raw = await callLLM(prompt);
    const intent = raw.trim().toLowerCase().replace(/[^a-z_]/g, '');
    const valid = ['book', 'cancel', 'reschedule', 'reminder', 'my_appointments', 'availability', 'help', 'contact', 'faq', 'none'];
    return valid.includes(intent) ? intent : 'none';
  } catch {
    return 'none';
  }
}

// ─── 3. Confirm / deny detection ─────────────────────────────────────────────
// Returns: "yes" | "no" | "unknown"

// Fast regex shortcuts — avoid LLM for obvious cases
const YES_REGEX = /^(yes|y|yep|yeah|yup|ok|okay|sure|confirm|confirmed|haan|ha|theek hai|bilkul|done|go ahead|book it|👍|✅|👌|correct|right|perfect|sounds good|great)$/i;
const NO_REGEX  = /^(no|n|nope|nahi|nah|cancel|stop|dont|don't|na|nahh|❌|🚫|not now|skip)$/i;

export async function extractConfirmation(message) {
  const trimmed = message.trim();

  // Fast-path for common responses
  if (YES_REGEX.test(trimmed)) return 'yes';
  if (NO_REGEX.test(trimmed))  return 'no';

  const prompt = `
Does this message mean YES or NO? Reply with exactly "yes", "no", or "unknown".

Message: "${trimmed}"

- YES examples: "yes", "yep", "ok", "sure", "confirm", "haan", "theek hai", "bilkul", "👍", "✅", "sounds good", "go ahead"
- NO examples: "no", "nope", "cancel", "nahi", "na", "don't", "❌"
- UNKNOWN: ambiguous or unrelated messages

Reply with only one word: yes, no, or unknown.
`.trim();

  try {
    const raw = await callLLM(prompt);
    const answer = raw.trim().toLowerCase();
    if (answer.startsWith('yes')) return 'yes';
    if (answer.startsWith('no'))  return 'no';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── 3b. Human handoff detection ─────────────────────────────────────────────
// Returns true if the user wants to speak to a real person.

const HANDOFF_REGEX = /\b(human|person|agent|manager|owner|staff|reception|someone|talk to (a|someone)|speak (to|with) (a|someone)|real person|live (chat|support)|help me please|need help urgently)\b/i;

export async function detectHandoffIntent(message) {
  const trimmed = message.trim();
  if (HANDOFF_REGEX.test(trimmed)) return true;

  // LLM fallback for more subtle phrasing
  const prompt = `Does this message mean the user wants to stop talking to the bot and speak to a real human instead? Reply only "yes" or "no".

Message: "${trimmed}"`;

  try {
    const raw = await callLLM(prompt);
    return raw.trim().toLowerCase().startsWith('yes');
  } catch {
    return false;
  }
}

// ─── 4. Conversational / FAQ answer ──────────────────────────────────────────

export async function answerConversational(question, businessContext = {}) {
  const ctx = [
    businessContext.name    && `Business name: ${businessContext.name}`,
    businessContext.type    && `Business type: ${businessContext.type}`,
    businessContext.services && `Services offered: ${businessContext.services}`,
  ].filter(Boolean).join('\n');

  const prompt = `
You are a friendly WhatsApp appointment booking assistant for a business.
${ctx}

The customer sent: "${question}"

Reply in 1-3 short sentences. Be warm and helpful. Guidelines:
- Language questions (e.g. "which languages do you support", "do you speak Hindi"): Say you support English, Hindi, and Hinglish — customers can type in any of these.
- WhatsApp questions: Confirm they are chatting via WhatsApp.
- Casual greetings (e.g. "yo", "hey bro", "sup"): Respond warmly and invite them to book.
- Questions about services, prices, or hours: Answer based on the business context above. If you don't know, say to contact the business directly.
- Off-topic questions: Politely say you can only help with appointment bookings and suggest typing HELP.
- NEVER return an empty response. Always say something helpful.
- Keep it conversational — this is WhatsApp, not a formal chat.
`.trim();

  try {
    const answer = await callLLM(prompt, { systemPrompt: WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT });
    return answer?.trim() || "I can help you book appointments here! Type *HELP* to see what I can do. 😊";
  } catch {
    return "I can help you book appointments here! Type *HELP* to see what I can do. 😊";
  }
}

// ─── 5. Gentle inactivity nudge message ──────────────────────────────────────
// Used after a few minutes of silence mid-flow to sound human and varied.

export async function generateInactivityNudge({
  businessName,
  businessType,
  lastStepDescription,
}) {
  const ctx = [
    businessName && `Business name: ${businessName}`,
    businessType && `Business type: ${businessType}`,
    lastStepDescription && `Last thing we asked the customer: ${lastStepDescription}`,
  ].filter(Boolean).join('\n');

  const prompt = `
You are a friendly WhatsApp booking assistant sending a gentle follow-up after the customer hasn't replied for a few minutes.
${ctx}

Write a SHORT WhatsApp-style message (1–2 sentences) that:
- Sounds human, warm, and low-pressure.
- Gently checks if they still want to continue.
- DOES NOT mention minutes or exact time passed.
- Mentions that they can either continue or come back later.
- Optionally suggests they can type HELP to see options.
- Varies phrasing a bit (not robotic, not always the same template).

Return ONLY the message text with no quotes or explanation.
`.trim();

  try {
    const text = await callLLM(prompt, { temperature: 0.7, systemPrompt: WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT });
    return text?.trim() ||
      "Still here whenever you’re ready 🙂 You can continue with your booking or type *HELP* to see options.";
  } catch {
    return "Still here whenever you’re ready 🙂 You can continue with your booking or type *HELP* to see options.";
  }
}

// ─── 5b. Dynamic help reply (what we do, how we can help) ──────────────────────
// Human, conversational message — no fixed template. Uses real services and business context.

export async function generateHelpReply({
  businessName,
  businessType,
  services = [],
  customerName = null,
}) {
  const serviceList = services.length
    ? services.map((s) => `${s.name}${s.price != null ? ` (₹${parseFloat(s.price).toLocaleString('en-IN')})` : ''}`).join(', ')
    : '';

  const ctx = [
    businessName && `Business name: ${businessName}`,
    businessType && `Business type: ${businessType}`,
    serviceList && `Services offered: ${serviceList}`,
    customerName && `Returning customer name: ${customerName}`,
  ].filter(Boolean).join('\n');

  const prompt = `
You are a friendly WhatsApp booking assistant for a single business. The customer is asking what you can do or how you can help (e.g. "what can you do?", "how can you help me?").

${ctx}

Write a SHORT, warm WhatsApp reply (2–4 sentences) that:
- Feels human and conversational, not a template or bullet list.
- Explains in plain language what you help with: booking appointments, cancelling or rescheduling, showing their upcoming bookings, checking availability, and telling them about services.
- If we have services listed above, mention them naturally (e.g. "We do haircuts, colour, and styling" or "You can book a consultation, follow-up, or checkup").
- Optionally greet the customer by name if you know it.
- End with a gentle invite to just say what they need or type HELP anytime.
- Do NOT use emoji bullets (📅 ❌ 🔄) or a rigid list. Sound like a helpful person, not a menu.

Return ONLY the message text, no quotes or explanation.
`.trim();

  try {
    const text = await callLLM(prompt, { temperature: 0.6, systemPrompt: WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT });
    return text?.trim() || null;
  } catch {
    return null;
  }
}

// ─── 5c. Returning-user greeting ─────────────────────────────────────────────
// Short, personal reply when a known customer says hello — NOT the full menu.
// "Hey Manthan! Great to see you again 😊 Want to book something, or check your appointments?"

export async function generateReturningUserGreeting({
  businessName,
  customerName,
  businessType,
  services = [],
}) {
  const topServices = services.slice(0, 3).map(s => s.name).join(', ');

  const prompt = `
You are a friendly WhatsApp booking assistant for ${businessName}${businessType ? ` (${businessType})` : ''}.
A returning customer named ${customerName} just said hello or hi.

Write a SHORT (1–2 sentences), warm, casual reply that:
- Greets them by first name (${customerName.split(' ')[0]})
- Feels like a friendly text, not a menu or announcement
- Lightly hints they can book, check their appointments, or ask about services${topServices ? ` (${topServices})` : ''}
- Ends with an open question like "What can I do for you?" or "How can I help today?"
- No bullet points, no lists, no formal language, no emojis overload

Return ONLY the message text.
`.trim();

  try {
    const text = await callLLM(prompt, { temperature: 0.7, systemPrompt: WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT });
    return text?.trim() || null;
  } catch {
    return null;
  }
}

// ─── 6. Dynamic fallback when something went wrong ─────────────────────────────
export async function generateDynamicFallbackReply({
  userMessage,
  businessName,
  businessType,
}) {
  const ctx = [
    businessName && `Business: ${businessName}`,
    businessType && `Business type: ${businessType}`,
  ].filter(Boolean).join('. ');

  const prompt = `
You are a friendly WhatsApp booking assistant. Something went wrong on our side while handling the customer's message.

What the customer said: "${(userMessage || '').slice(0, 200)}"
${ctx}

Write a SHORT WhatsApp reply (2–4 sentences) that:
1. Apologise briefly for the hiccup.
2. If their message was clearly a request (e.g. bookings, book, cancel, reschedule), acknowledge it in one line.
3. Say what you can help with: booking, cancelling, rescheduling, showing their bookings, availability, services. One line, natural.
4. End with a warm nudge to try again or type *HELP*.
Be conversational. Do NOT use bullet lists. Return ONLY the message text, no quotes.
`.trim();

  try {
    const text = await callLLM(prompt, { temperature: 0.6, systemPrompt: WHATSAPP_RECEPTIONIST_SYSTEM_PROMPT });
    return text?.trim() || null;
  } catch {
    return null;
  }
}
