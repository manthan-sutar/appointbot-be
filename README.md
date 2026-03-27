# AppointBot — Backend

Express.js backend for AppointBot — AI-powered WhatsApp appointment booking bot.

## Stack

- Node.js + Express
- PostgreSQL (`pg`)
- WhatsApp Cloud API (Meta)
- Groq / Ollama (LLM)
- Razorpay (payments)
- node-cron (reminders + scheduled campaign processing + auto-retries)
- Durable async execution records (`async_job_executions`) for idempotent scheduler work

## Setup

```bash
cp .env.example .env
# fill in your values

npm install
npm run db:init   # create tables in your PostgreSQL DB
npm run dev       # start with file watching
```

## Deploy

Recommended: **Railway** or **Fly.io** (requires a persistent process for cron jobs).

## Environment

See `.env.example` for all required variables.

## Key Features Implemented

- No-show prevention: 24h + 2h reminders, confirmation flow, auto-cancel unconfirmed.
- Lead funnel attribution: source/campaign/utm tracking, dropped lead follow-up.
- CRM APIs: customer profile, history, notes, risk indicators.
- Campaigns: create/list/send, schedule, template mode, failure drilldown, CSV export, manual retry, auto-retry.

## Operations Docs

- API reference: `docs/API.md`
- Roadmap status: `docs/ROADMAP.md`
- Operations runbook: `docs/OPERATIONS_RUNBOOK.md`
- Staging smoke checklist: `docs/STAGING_SMOKE_CHECKLIST.md`
