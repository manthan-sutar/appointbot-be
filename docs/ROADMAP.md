# appointbot — Feature Roadmap

A living document of planned features. Implement gradually, prioritize by impact.

---

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done

---

## 🤖 Bot Intelligence

### [x] Smart Reminders + Confirmation + Auto-cancel
After a booking is confirmed, the bot automatically messages the customer the day before:
> "Reminder: your Haircut with Priya is **tomorrow at 5:00 PM**. Reply CONFIRM or RESCHEDULE."

- 24h + 2h reminder flow implemented
- confirmation keyword flow implemented
- auto-cancel unconfirmed appointments implemented
- event logging + dashboard trends added

---

### [ ] "Book My Usual"
Returning customers can say "book my usual" and the bot books the same service, staff, and time slot as their last appointment.

- Store last booking details per customer in `customers` table (or derive from appointments)
- New intent: `book_usual` in `ai.service.js`
- Confirm before booking: "Last time you booked a Haircut with Priya on Fridays at 5pm — book the same?"
- **Difficulty:** Easy

---

### [ ] Waitlist
If a requested slot is fully booked, offer to add the customer to a waitlist.
When someone cancels, auto-notify the next person on the waitlist via WhatsApp.

- New `waitlist` table: `(id, business_id, customer_phone, service_id, staff_id, preferred_date, created_at)`
- On cancellation: check waitlist, send WhatsApp to first match
- **Difficulty:** Medium

---

### [ ] Multi-language Support
Detect the customer's language from their first message and reply in that language throughout the conversation.

- Groq/Ollama already handles multilingual — just pass a language instruction in the system prompt
- Store detected language in session
- Support: Hindi, Gujarati, Tamil, Marathi (India-first)
- **Difficulty:** Easy — mostly prompt engineering

---

### [ ] No-show Tracking & Deposit Request
Track customers who don't show up for their appointments.
After 3 no-shows, the bot asks for a deposit before confirming future bookings.

- Add `no_show_count` to `customers` table
- Owner can mark appointments as no-show from dashboard
- Bot checks count before confirming: "You've missed 3 appointments. Please pay ₹X deposit to confirm."
- **Difficulty:** Medium

---

### [ ] Post-appointment Review Request
1 hour after an appointment ends, the bot sends:
> "How was your visit at Priya's Salon? Rate us 1–5 ⭐"

- New `reviews` table: `(id, business_id, customer_phone, appointment_id, rating, comment, created_at)`
- Scheduler checks for appointments that ended 1 hour ago and haven't been reviewed
- Show average rating and recent reviews in the dashboard
- **Difficulty:** Medium

---

### [ ] Group Booking
Handle "book for me and my friend" — two people, same service, back-to-back slots.

- Detect group intent in `ai.service.js`
- Book two consecutive slots automatically
- **Difficulty:** Medium

---

## 📊 Business Owner Tools

### [ ] Weekly Digest Email
Every Monday morning, send the owner an email summary:
- Total bookings this week
- Busiest day
- Top service
- Estimated revenue (price × bookings)
- Comparison to last week

- Use `nodemailer` or a transactional email service (Resend, SendGrid)
- Add `owner_email` notification preference in settings
- **Difficulty:** Easy

---

### [x] Revenue + No-show + Repeat Dashboard
Show estimated revenue from bookings in the dashboard.

- Revenue/no-show/repeat metrics implemented
- lead funnel timeline + source analytics implemented
- campaign summary analytics implemented

---

### [ ] Google Calendar Sync
Push confirmed bookings to the business owner's Google Calendar automatically.

- OAuth2 flow: owner connects their Google account in Settings
- On booking confirmed: create a Google Calendar event via Google Calendar API
- On cancellation: delete the event
- **Difficulty:** Hard (OAuth flow + Google API)

---

### [ ] Holiday / Closure Override
Let owners mark specific dates as closed without changing their weekly schedule.

- New `closures` table: `(id, business_id, date, reason)`
- Dashboard: calendar picker to mark closed dates
- Bot checks closures before offering slots
- **Difficulty:** Easy

---

### [ ] Export Appointments to CSV
One button in the dashboard to download all appointments as a CSV file.

- Backend: `GET /api/business/appointments/export` — returns CSV
- Frontend: trigger download from dashboard
- **Difficulty:** Easy

---

### [ ] Custom Bot Greeting
Let owners write their own welcome message from the dashboard.

- Add `welcome_message` column to `businesses` table
- Settings → Business tab: textarea for custom greeting
- Bot uses it instead of the default `formatWelcome()`
- **Difficulty:** Easy

---

## 💬 Customer Experience

### [ ] Loyalty Points / Punch Card
Simple punch-card style loyalty system.
- "You've booked 5 times! Your next service gets 10% off."
- Add `booking_count` and `loyalty_discount` to `customers` table
- Bot mentions the discount at confirmation time
- **Difficulty:** Medium

---

### [ ] Photo Sharing
Customer sends a photo ("I want this haircut") and the bot acknowledges it and attaches a note to the booking for the staff.

- The WhatsApp webhook payload includes media URLs
- Store the URL in `appointments.notes`
- Show in dashboard appointment detail
- **Difficulty:** Easy

---

## 🏢 Platform / SaaS

### [ ] Public Business Profile Page
A shareable public page at `/b/priya-salon` with:
- Business name, type, hours
- List of services
- "Book Now" button that opens the WhatsApp chat link
- Perfect for Instagram bios, Google listings

- New React page: `dashboard/src/pages/BusinessProfile.jsx`
- Public route, no auth required
- **Difficulty:** Easy

---

### [x] Embeddable Website Chat Widget + Tracked Book Now
A `<script>` tag businesses paste on their website that adds a floating WhatsApp booking button.

- `GET /chat/:slug/widget.js` floating widget implemented
- tracked WhatsApp book-now links in settings
- campaign + utm attribution persisted in lead events

---

## 📣 Marketing Campaigns

### [x] Campaigns MVP+ (send, schedule, reliability)
- create/list/send campaigns by audience segment
- text mode and template mode
- scheduled campaigns processed in scheduler
- failure drilldown and CSV export
- manual retry for failed recipients
- auto-retry with backoff and max attempts
- campaign delivery analytics in dashboard and campaigns page

---

### [ ] Referral System
"Invite another business owner, get 1 month Pro free."

- Unique referral code per owner stored in `business_owners` table
- Track signups via referral code
- Auto-credit 1 month Pro on successful referral
- **Difficulty:** Medium

---

### [ ] Mobile PWA for Owners
Make the dashboard a Progressive Web App so owners can add it to their phone home screen and get push notifications for new bookings.

- Add `manifest.json` and service worker to dashboard
- Push notifications via Web Push API when a new booking comes in
- **Difficulty:** Medium

---

## ⚡ Quick Wins (1–2 hours each)

| Feature | Where | Notes |
|---|---|---|
| Dark mode for dashboard | `index.css` + CSS variables | Toggle in sidebar |
| Appointment notes field | `appointments` table + bot flow | "Any special requests?" |
| Staff profile photos | `staff` table + Settings UI | Upload URL |
| Business logo upload | `businesses` table + Settings UI | Shown in profile page |
| Timezone-aware dashboard | Dashboard date display | Use `business.timezone` |
| Pagination for appointments | Dashboard table | For high-volume businesses |
| Search appointments | Dashboard | Filter by customer name/phone |

---

## Remaining High-Priority Work

1. **Docs and API contract alignment** (in progress)
2. **Async durability hardening** (partially done; continue with queue abstraction/migrations)
3. **Campaign safeguards** (suppression/opt-out, per-tenant throttle caps)
4. **Calendar sync / external integrations**
