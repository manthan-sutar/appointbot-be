# WhatsApp campaigns & bulk messaging

This app sends campaigns through the **WhatsApp Cloud API** (Meta Graph API). Meta enforces rules that are **not** controlled in code.

## Error `(#131030) Recipient phone number not in allowed list`

This almost always means one of:

### 1. App is in **Development** mode (most common locally)

- Meta only lets you message **phone numbers you add** in the developer app.
- **Where:** [Meta for Developers](https://developers.facebook.com/) → your app → **WhatsApp** → **API Setup** (or Getting started) → **Manage phone number list** / add recipients.
- Add each **E.164** number (without `+` in the API; we normalize in code), complete **OTP verification** when Meta asks.
- There is a **small limit** (often 5 numbers) for testing.

**What you need:** Add every real customer number you want to test, or move to production (below).

### 2. Production / bulk sending

For real customers at scale:

1. **Business verification** (Meta Business Manager) – confirm your business identity.
2. **WhatsApp Business Account (WABA)** – your number linked to the Cloud API.
3. **App mode** – switch the app from Development to **Live** when Meta allows (after review if required).
4. **Templates** – outbound messages to users who have **not** chatted in the last 24 hours must use **approved message templates** (usually **Marketing** or **Utility** category).
5. **Opt-in** – you must only message users who agreed to receive WhatsApp messages from you (marketing rules vary by region).

**What you need:** Completed Meta business setup, **Live** app, **approved templates** for campaign content, and compliant phone lists.

## What you configure in Appointbot

| Item | Purpose |
|------|--------|
| **Connect WhatsApp** (Settings) or env `WHATSAPP_*` | Per-business **access token** + **Phone number ID** for the Cloud API. |
| **Campaign type** | **Meta template** (recommended for bulk) – set template name + language to match Meta Business → WhatsApp → Message templates. |
| **Text message** | Only works for users inside the **24-hour session** after they last messaged you. For cold outreach, use **templates**. |

## Recommended setup for campaigns

1. In [Meta Business Manager](https://business.facebook.com/) → **WhatsApp → Message templates** – create and get **Approved** a template (e.g. marketing offer).
2. In **Create campaign** – choose **Meta template**, enter the **exact** template name and language code (e.g. `en`).
3. For **development** – add test recipient numbers under **API Setup** until you go Live.
4. For **production** – complete verification, go Live, use templates only for bulk sends.

## Useful links

- [WhatsApp Cloud API – error codes](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/)
- [Message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates)
