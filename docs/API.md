# appointbot — API Reference

## Endpoints

### `GET /health`
Returns server status.

**Response:**
```json
{ "status": "ok", "service": "appointbot" }
```

---

### `POST /webhook`
Main bot endpoint. Accepts WhatsApp webhook payloads or a simple JSON body for testing.

**Request (JSON — production / testing):**
```json
{ "From": "+919999999999", "Body": "Book haircut tomorrow at 5pm" }
```

**Response:** `text/plain` — the bot's reply message (WhatsApp-formatted)

---

### `GET /chat`
Serves the browser-based test chat UI (`public/chat.html`).

---

### `POST /chat/send`
Proxies a message to `/webhook` for the test UI.

**Request:**
```json
{ "message": "Book haircut tomorrow at 5pm" }
```

**Response:**
```json
{ "reply": "Please confirm your booking:\n\n..." }
```

---

### `DELETE /chat/reset`
Clears the test session from the database.

**Response:**
```json
{ "ok": true }
```

---

## Conversation States

| State | Description |
|---|---|
| `IDLE` | No active flow |
| `AWAITING_SERVICE` | Waiting for user to pick a service |
| `AWAITING_DATE` | Waiting for appointment date |
| `AWAITING_TIME` | Waiting for appointment time |
| `AWAITING_STAFF` | Waiting for staff selection |
| `AWAITING_NAME` | Waiting for customer name |
| `AWAITING_CONFIRMATION` | Waiting for YES/NO to confirm booking |
| `AWAITING_CANCEL_WHICH` | Waiting for user to pick which appointment to cancel |
| `AWAITING_RESCHEDULE_DATE` | Waiting for new date during reschedule |
| `AWAITING_RESCHEDULE_TIME` | Waiting for new time during reschedule |

---

## Example Conversation

```
User:  "Book haircut tomorrow at 5pm"
Bot:   "Please confirm your booking:
        📋 Service: Haircut
        👤 With: Priya
        📅 Date: Saturday, 28 February 2026
        🕐 Time: 5:00 PM
        💰 Price: ₹300
        Reply YES to confirm or NO to cancel."

User:  "YES"
Bot:   "✅ Booking Confirmed!
        📋 Service: Haircut
        👤 With: Priya
        📅 Date: Saturday, 28 February 2026
        🕐 Time: 5:00 PM
        🔖 Ref #: 42
        You'll receive a reminder 24 hours before your appointment."
```
