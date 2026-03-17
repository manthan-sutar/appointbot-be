# WhatsApp: platform setup and testing with real numbers

## Who configures what

- **Platform (you):** One Meta app, one webhook URL, one verify token. You set these in `.env` and in the Meta Developer Console. Businesses never see or configure webhooks.
- **Business (your clients):** They only need a **WhatsApp Business number** already registered with Meta. In the dashboard they click **Connect WhatsApp Business**, complete Meta’s OAuth flow, and their number is linked. No Meta configuration, no webhook URL, no copying tokens.

## Testing with real phone numbers

### 1. Development / test numbers (no app review)

- In [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp** → **API Setup**, you get a **test phone number** and can add **test recipient numbers** (up to 5).
- Only those test numbers can message the test WhatsApp number. Real random users cannot.
- Use this to verify: Connect flow, webhook delivery, booking flow, and reminders for your test numbers.
- **No app review needed** for this. You can test end-to-end with your own phones by adding them as test numbers.

### 2. Using a real WhatsApp Business number (still in dev)

- You can connect a **real** WhatsApp Business number to your app while the app is in **Development** mode.
- That number must be added to the WhatsApp product in your Meta app (e.g. via Embedded Signup, which your “Connect WhatsApp Business” flow uses).
- In Development mode, **only test numbers** (the ones you add in API Setup) can send messages to that business number. So you add your own phone (and teammates’) as test numbers and message the business number to test.
- **App Review is still not required** for this.

### 3. Allowing any customer to message (production)

- When you switch the Meta app to **Live** and want **any** customer (not just test numbers) to message your clients’ WhatsApp Business numbers, Meta requires **App Review** for the WhatsApp permissions you use (e.g. `whatsapp_business_messaging`, `whatsapp_business_management`).
- You submit your app for review; Meta checks use case, privacy, and UX. Once approved, any user can message the connected business numbers within your app’s limits.
- So: **you need to send your Meta app for WhatsApp App Review only when you want real, non–test users to be able to message.** For internal/testing with test numbers and a real business number, you do **not** need app review.

## Summary

| Goal | App review needed? |
|------|--------------------|
| Test with Meta’s test number + up to 5 test recipients | No |
| Use a real WhatsApp Business number but only test recipients can message | No |
| Any customer can message connected business numbers (app Live) | Yes |

Business users of your platform only need to click **Connect WhatsApp Business** and have their number on Meta. You handle webhook and Meta config once at the platform level.

---

## Troubleshooting

### "Error validating access token" / Code 190 — "The session is invalid because the user logged out"

**Cause:** The WhatsApp/Meta access token your app is using is no longer valid. Common reasons:

- The Facebook/Meta user who authorized the app **logged out**, **changed their password**, or **revoked the app**.
- The token **expired** (short‑lived ~1 hour; long‑lived user tokens ~60 days).
- The app was removed from the Meta Business account.

**Fix:**

1. **Default business (businessId 1, uses `.env`):**
   - Get a new access token from [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp** → **API Setup** (use the token from the API setup page, or generate a long‑lived token via the Graph API Explorer with the right permissions).
   - Put it in `.env` as `WHATSAPP_ACCESS_TOKEN` and restart the server.

2. **Businesses that connected via dashboard:**
   - Have the business owner open your app’s **Settings** (or **Connect WhatsApp**) and click **Connect WhatsApp Business** again to go through Meta’s OAuth. That will store a fresh token in the database.

3. **Preventing repeat:** Prefer **long‑lived** or **system user** tokens for production, and/or use the Embedded Signup (Connect) flow so businesses can re-authenticate when needed.
