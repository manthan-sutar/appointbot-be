# AppointBot Backend Operations Runbook

This runbook is for production/staging operation of reminder, lead automation, and campaign systems.

## 1) Pre-Deploy Checklist

- Confirm `DATABASE_URL` points to the correct environment.
- Apply latest schema (`db/schema.sql`) before app rollout.
- Verify required env values:
  - `JWT_SECRET`
  - `WHATSAPP_VERIFY_TOKEN`
  - WhatsApp credentials or embedded-signup flow readiness
- Verify optional but recommended env values:
  - `WHATSAPP_REMINDER_TEMPLATE_NAME`
  - `CAMPAIGN_AUTO_RETRY_MAX_ATTEMPTS`
  - `CAMPAIGN_MAX_RECIPIENTS_PER_SEND`

## 2) Migration Checklist

Run:

```bash
npm run db:init
```

Expected key tables/columns (must exist):
- `appointment_events`
- `leads`, `lead_events`
- `campaigns`, `campaign_recipients`
- `messaging_preferences`
- `async_job_executions`
- campaign extension columns (`send_mode`, `template_name`, `scheduled_at`, retry metadata)

## 3) Scheduler Health

The cron scheduler (every 10 minutes) runs:
- appointment reminders (24h / 2h)
- auto-cancel unconfirmed appointments
- dropped lead follow-up
- scheduled campaigns
- campaign auto-retries

Health checks:
- `GET /health` responds `{ status: "ok" }`
- logs show periodic `[Reminders] Running reminder + no-show checks…`
- no repeated fatal errors in send/retry loops

## 4) WhatsApp Failure Playbook

### Auth failures (401 / Meta code 190)
- Symptom: repeated auth errors in logs.
- Action:
  1. Reconnect WhatsApp in dashboard OR rotate token.
  2. Verify business-specific credentials in `businesses` table.
  3. Re-run failed campaign retries.

### 24-hour window errors (131026 / 131047)
- Symptom: freeform text rejected.
- Action:
  1. Use approved template mode for campaigns/reminders.
  2. Verify `template_name` and language.

### Rate-limit errors (429)
- Symptom: sends fail due to throughput limits.
- Action:
  1. Lower `CAMPAIGN_MAX_RECIPIENTS_PER_SEND`.
  2. Retry failed recipients later.

## 5) Campaign Recovery Steps

1. Open Campaigns page and inspect failed campaign.
2. Use failure drilldown (`/campaigns/:id/failures`) to identify dominant reason.
3. Export CSV for support triage if needed.
4. Run `Retry failed` action after underlying issue is fixed.
5. Monitor:
   - Retry pending
   - Retry exhausted
   - delivery rate trends

## 6) Compliance / Messaging Preferences

- Customer `STOP`/`UNSUBSCRIBE` sets campaign opt-out.
- Customer `START`/`SUBSCRIBE` re-enables campaign messaging.
- Booking-critical transactional messages continue.
- Ops can manually opt-in/out via messaging preferences API and Campaigns UI.

## 7) Incident Severity Guide

- **SEV-1**: Booking confirmations/reminders not delivering across tenants.
- **SEV-2**: Campaign sends failing for one/few businesses.
- **SEV-3**: Dashboard analytics drift without customer-facing impact.

## 8) Rollback Guidance

- Prefer forward-fix over rollback for schema-additive releases.
- If rollback is unavoidable:
  - keep DB schema additions (safe additive)
  - deploy previous app version only
  - revalidate scheduler logs and campaign status transitions

