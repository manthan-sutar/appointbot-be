# AppointBot Staging Smoke Checklist

Use this checklist after migration and before production rollout.

## 0) Environment + Migration

- [ ] Backend starts with no boot errors.
- [ ] Frontend loads and login works.
- [ ] `npm run db:init` (or schema apply) completed successfully.
- [ ] New tables/columns exist:
  - `campaigns`, `campaign_recipients`
  - `messaging_preferences`
  - `async_job_executions`
  - campaign retry/scheduling columns

## 1) Core Booking / No-show

- [ ] Book an appointment via chat/webhook flow.
- [ ] Confirm appointment via confirmation keyword.
- [ ] 24h and 2h reminder due queries produce expected candidates.
- [ ] Auto-cancel unconfirmed appointment path works (staging test case).
- [ ] Dashboard no-show trend updates correctly.

## 2) Lead Attribution

- [ ] Send chat message with source/campaign/utm.
- [ ] Lead event stores attribution fields.
- [ ] Dashboard source/campaign/utm panels show expected counts.
- [ ] 7d/30d/90d filter changes metrics correctly.

## 3) Campaigns (Text Mode)

- [ ] Create text campaign (draft).
- [ ] Send now works and status/counters update.
- [ ] Failed recipients are visible in drilldown.
- [ ] Retry failed action updates counts and status.
- [ ] CSV export downloads valid file with rows.

## 4) Campaigns (Template Mode)

- [ ] Create template campaign with valid template name.
- [ ] Send now works for template mode.
- [ ] Missing template name is rejected by API validation.

## 5) Scheduled Campaigns

- [ ] Create campaign with `scheduled_at` in near future.
- [ ] Scheduler picks it up and sends once due.
- [ ] No duplicate campaign execution under overlapping ticks.

## 6) Auto-Retry

- [ ] Induce controlled failure (staging credentials/rate limit simulation).
- [ ] `next_retry_at` is set after failure.
- [ ] Retry backoff progresses (15m -> 30m -> 60m).
- [ ] `retryPending` / `retryExhausted` summary fields reflect state.

## 7) Suppression / Compliance

- [ ] User sends `STOP` -> contact marked opted-out.
- [ ] User sends `START` -> opt-out cleared.
- [ ] Opted-out contacts are excluded from campaign targeting.
- [ ] Suppressed contacts appear in Campaigns UI and can be opted in manually.

## 8) Reliability / Observability

- [ ] `async_job_executions` rows appear for idempotent scheduler tasks.
- [ ] Re-running scheduler cycle does not duplicate idempotent jobs for same bucket key.
- [ ] Logs include actionable errors for auth/window/rate-limit cases.

## 9) Rollout Decision Gate

Go-live only if all are true:

- [ ] No blocker in booking/reminder/campaign flows
- [ ] No schema mismatch errors
- [ ] Suppression behavior verified
- [ ] Retry and failure recovery verified
- [ ] Dashboard metrics align with test events
