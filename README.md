# AppointBot — Backend

Express.js backend for AppointBot — AI-powered WhatsApp appointment booking bot.

## Stack
- Node.js + Express
- PostgreSQL (`pg`)
- WhatsApp Cloud API (Meta)
- Groq / Ollama (LLM)
- Razorpay (payments)
- node-cron (reminders)

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
