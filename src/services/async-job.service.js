import { query } from '../config/db.js';

function getRetryDelayMinutes(attemptNumber, retryScheduleMinutes) {
  const idx = Math.max(0, attemptNumber - 1);
  if (idx < retryScheduleMinutes.length) return retryScheduleMinutes[idx];
  return retryScheduleMinutes[retryScheduleMinutes.length - 1];
}

export async function runIdempotentJob({
  jobName,
  jobKey,
  maxAttempts = 3,
  retryScheduleMinutes = [15, 30, 60],
  handler,
}) {
  if (!jobName || !jobKey || typeof handler !== 'function') {
    throw new Error('runIdempotentJob requires jobName, jobKey, and handler');
  }

  await query(
    `INSERT INTO async_job_executions (job_name, job_key, status, attempts)
     VALUES ($1, $2, 'pending', 0)
     ON CONFLICT (job_name, job_key) DO NOTHING`,
    [jobName, jobKey],
  );

  const claimRes = await query(
    `UPDATE async_job_executions
     SET status = 'running',
         attempts = attempts + 1,
         last_run_at = NOW(),
         updated_at = NOW()
     WHERE job_name = $1
       AND job_key = $2
       AND status != 'succeeded'
       AND status != 'running'
       AND attempts < $3
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     RETURNING id, attempts`,
    [jobName, jobKey, maxAttempts],
  );

  const claimed = claimRes.rows[0];
  if (!claimed) {
    return { skipped: true };
  }

  try {
    const result = await handler();
    await query(
      `UPDATE async_job_executions
       SET status = 'succeeded',
           last_error = NULL,
           next_retry_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [claimed.id],
    );
    return { skipped: false, result };
  } catch (err) {
    const attempts = Number(claimed.attempts || 1);
    const shouldRetry = attempts < maxAttempts;
    const delay = getRetryDelayMinutes(attempts, retryScheduleMinutes);
    await query(
      `UPDATE async_job_executions
       SET status = 'failed',
           last_error = $2,
           next_retry_at = CASE
             WHEN $3 THEN NOW() + make_interval(mins => $4::int)
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [claimed.id, err?.message || 'async job failed', shouldRetry, delay],
    );
    throw err;
  }
}

