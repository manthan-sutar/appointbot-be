/**
 * Smoke-test Resend from local .env (does not print API keys).
 * Usage: node scripts/test-resend.mjs you@example.com
 */
import "dotenv/config";
import { sendDemoRequestEmails } from "../src/services/email.service.js";

const to = process.argv[2] || process.env.TEST_RESEND_TO;
if (!to) {
  console.error("Usage: node scripts/test-resend.mjs <recipient@email.com>");
  process.exit(1);
}

const result = await sendDemoRequestEmails({
  businessName: "Resend test",
  email: to,
  phone: "0000000000",
  businessType: "salon",
  message: "Manual Resend smoke test from scripts/test-resend.mjs",
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.sent ? 0 : 1);
