# Meta App Review — Allowed Usage Form Text

Use the text below when filling the three "How will this app use…" sections in the Meta for Developers App Review → Allowed usage step. Copy-paste into the **"Describe how your app uses this permission or feature"** field for each permission.

---

## 1. whatsapp_business_messaging

**Describe how your app uses this permission or feature:**

Our app (AppointBot) is an appointment-booking platform for small businesses (salons, clinics, etc.). We use **whatsapp_business_messaging** so that:

- **Customers** can message a business’s WhatsApp number to book, reschedule, or cancel appointments; ask for availability; and receive confirmations and reminders—all via conversational text (and optional voice messages, which we transcribe).
- **Businesses** receive and send these messages through the WhatsApp Cloud API. Each business connects their own WhatsApp Business number via our “Connect WhatsApp Business” flow; we then send and receive messages on their behalf using the stored access token and phone number ID.

All messaging is **transactional and service-related**: booking flows, appointment confirmations, 24-hour and custom reminders, and short FAQ-style replies. We do not use WhatsApp for marketing, bulk broadcasts, or non-service conversations. Messages are sent only in direct reply to customer-initiated chats or as appointment reminders for existing bookings.

---

## 2. business_management

**Describe how your app uses this permission or feature:**

We use **business_management** so that business users can **connect their WhatsApp Business number** to our platform in a single, secure flow:

1. From our dashboard (Settings → WhatsApp), the user clicks “Connect WhatsApp Business.”
2. They are redirected to Meta’s OAuth (embedded signup) with scopes that include business_management.
3. After the user authorizes, we exchange the auth code for an access token and call the Graph API (e.g. `me?fields=businesses{owned_whatsapp_business_accounts}`) to determine which WhatsApp Business Account(s) they own or manage.
4. We then associate the correct WABA and phone number with that user’s business record in our system so that all future messaging for that business uses their connected number.

We use business_management **only** to resolve the business and WhatsApp Business Account ownership so we can link the right phone number to the right business in our app. We do not manage ad accounts, Pages, or other Meta assets; we only need to know which WABA and phone number belong to the authenticated business user.

---

## 3. whatsapp_business_management

**Describe how your app uses this permission or feature:**

We use **whatsapp_business_management** to **link a business’s WhatsApp Business Account and phone number** to our platform after they complete the “Connect WhatsApp Business” OAuth flow:

1. After the user authorizes our app, we use the granted token to resolve their WhatsApp Business Account (e.g. via `me?fields=businesses{owned_whatsapp_business_accounts}` or `debug_token` with granular_scopes).
2. We then call the Graph API to fetch the phone numbers for that WABA (e.g. `/{waba_id}/phone_numbers`) to obtain the **phone number ID** and **display phone number**.
3. We store the access token, phone number ID, and related metadata in our database for that business so that:
   - Incoming webhook events from Meta are routed to the correct business (by display phone number).
   - Outgoing messages (replies, appointment confirmations, reminders) are sent via the Cloud API using that business’s phone number ID and token.

We use whatsapp_business_management **only** to complete the one-time connection of a WhatsApp Business number to a business in our app and to maintain the association for sending and receiving messages. We do not create or manage WABAs or phone numbers; we only read the existing WABA and phone number(s) the user has already set up in Meta.

---

## Screencast checklist

For **“Upload screencast showing the end-to-end user experience”** for each permission, you can use one or more short videos that show:

1. **Business side:** Log in to the dashboard → Settings → click “Connect WhatsApp Business” → complete Meta’s OAuth → return to dashboard with “WhatsApp connected.”
2. **Customer side:** Open WhatsApp → message the business number with “Hi” or “Book appointment” → go through the flow (choose service, date, time, confirm) → receive confirmation and, later, a reminder.

That single flow demonstrates use of all three permissions: messaging (customer ↔ business), business_management (resolving the business/WABA in OAuth), and whatsapp_business_management (resolving and storing the WABA and phone number for messaging).

---

## Compliance

For **“Agree that you will comply with allowed usage”**: check the box. Your use case (transactional appointment booking, confirmations, reminders, no marketing) aligns with Meta’s allowed usage for these permissions.

---

## Quick reference

| Permission                       | One-line summary for your notes |
|---------------------------------|----------------------------------|
| whatsapp_business_messaging     | Send/receive booking-related messages and reminders on behalf of connected businesses. |
| business_management             | Resolve which WABA belongs to the user during “Connect WhatsApp” OAuth. |
| whatsapp_business_management    | Resolve and store WABA + phone number ID after OAuth for routing and sending messages. |
