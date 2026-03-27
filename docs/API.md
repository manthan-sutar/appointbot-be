# appointbot — API Reference (current)

## Core Public Endpoints

### `GET /health`
Returns server status.

### `POST /webhook`
Main bot endpoint for WhatsApp and internal chat proxy payloads.

### `GET /chat/:slug`
Serves browser chat UI per business slug.

### `GET /chat/:slug/widget.js`
Embeddable website chat widget script.

### `POST /chat/:slug/send`
Proxy a chat message to webhook with optional attribution fields:
- `message`
- `source`
- `campaign`
- `utmSource`

### `DELETE /chat/:slug/reset`
Resets test session for chat UI.

## Authenticated Business APIs (`/api/business/*`)

### Dashboard + Funnel
- `GET /api/business/dashboard`
- `GET /api/business/funnel?days=7|30|90`

### No-show Settings
- `GET /api/business/no-show-settings`
- `PUT /api/business/no-show-settings`

### CRM
- `GET /api/business/customers`
- `GET /api/business/customers/:phone/profile`
- `GET /api/business/customers/:phone/history`
- `POST /api/business/customers/:phone/notes`

### Campaigns
- `GET /api/business/campaigns`
- `POST /api/business/campaigns`
- `POST /api/business/campaigns/:id/send`
- `GET /api/business/campaigns/summary`
- `GET /api/business/campaigns/:id/failures`
- `GET /api/business/campaigns/:id/failures.csv`
- `POST /api/business/campaigns/:id/retry-failed`

## Campaign Create Payload (summary)

`POST /api/business/campaigns`

```json
{
  "name": "Festival Offer - April",
  "audienceType": "all_leads",
  "sendMode": "text",
  "message": "Hi! Limited time offer this week...",
  "templateName": "",
  "templateLanguage": "en",
  "scheduledAt": "2026-04-01T10:30:00.000Z"
}
```

Notes:
- `sendMode` can be `text` or `template`.
- For `template`, `templateName` is required.
- `scheduledAt` is optional; when set, scheduler sends automatically when due.

## Async Reliability

Scheduler-critical jobs use durable execution records (`async_job_executions`) with:
- idempotent `job_name + job_key`
- retry metadata and status
- safe claim/update semantics to reduce duplicate executions.
