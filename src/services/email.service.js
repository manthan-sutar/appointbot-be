import { Resend } from "resend";

let resendClient;
let warnedMissingKey;
let warnedResendFromMissing;

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        "[Email] RESEND_API_KEY is not set; demo confirmation emails are skipped.",
      );
    }
    return null;
  }
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only for local dev when RESEND_FROM is unset — Resend allows one recipient (your account email). */
const DEFAULT_FROM = "Booklyft <onboarding@resend.dev>";

/**
 * @returns {string}
 */
function resolveResendFrom() {
  const explicit = process.env.RESEND_FROM?.trim();
  if (explicit) return explicit;
  if (!warnedResendFromMissing) {
    warnedResendFromMissing = true;
    console.warn(
      "[Email] RESEND_FROM is not set in this process — falling back to onboarding@resend.dev. " +
        "That sender only delivers to your Resend account email. " +
        "Set RESEND_FROM=Booklyft <noreply@your-verified-domain> (same domain as resend.com/domains) on your host (e.g. Render → Environment).",
    );
  }
  return DEFAULT_FROM;
}

/**
 * After a public demo form submit: notify the lead and optionally the team.
 * Does not throw — failures are logged so HTTP handlers still return 201.
 */
export async function sendDemoRequestEmails({
  businessName,
  email,
  phone,
  businessType,
  message,
  magicLinkUrl = null,
}) {
  const resend = getResend();
  if (!resend) return { sent: false, reason: "no_api_key" };

  const from = resolveResendFrom();
  const safeName = escapeHtml(businessName);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeType = escapeHtml(businessType);
  const safeMessage = message
    ? escapeHtml(message).replace(/\n/g, "<br/>")
    : "";

  const mailtoHref = `mailto:${encodeURIComponent(String(email ?? "").trim())}`;

  const safeMagic =
    magicLinkUrl && /^https?:\/\//i.test(String(magicLinkUrl).trim())
      ? String(magicLinkUrl).trim()
      : null;

  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
  const sandboxBlock = safeMagic
    ? `
<!--[if mso]><table role="presentation" width="100%"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0;border-collapse:collapse;">
  <tr>
    <td style="border-radius:14px;border:1px solid #e2e8f0;background:linear-gradient(135deg,#fafafa 0%,#f1f5f9 100%);background-color:#f8fafc;padding:0;overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td style="width:4px;background:#6366f1;font-size:0;line-height:0;">&nbsp;</td>
          <td style="padding:22px 20px 22px 18px;">
            <p style="margin:0 0 6px;font-family:${font};font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#6366f1;">Sandbox access</p>
            <p style="margin:0 0 12px;font-family:${font};font-size:17px;font-weight:700;color:#0f172a;line-height:1.3;">Try the live demo workspace</p>
            <p style="margin:0 0 20px;font-family:${font};font-size:14px;line-height:1.6;color:#64748b;">
              Open once to sign in — no password. The link expires after a few days and works a single time.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="border-radius:10px;background:#0f172a;">
                  <a href="${escapeHtml(safeMagic)}" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
                    Open Booklyft sandbox →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:18px 0 0;font-family:${font};font-size:12px;line-height:1.5;color:#94a3b8;word-break:break-all;">
              Button not working? Paste this into your browser:<br/>
              <span style="color:#64748b;">${escapeHtml(safeMagic)}</span>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->`
    : "";

  const detailsRows = `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:13px;color:#64748b;width:96px;vertical-align:top;">Business</td>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:14px;color:#0f172a;font-weight:500;">${safeName}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:13px;color:#64748b;vertical-align:top;">Email</td>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:14px;color:#0f172a;"><a href="${mailtoHref}" style="color:#4f46e5;text-decoration:none;">${safeEmail}</a></td>
    </tr>
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:13px;color:#64748b;vertical-align:top;">Phone</td>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:14px;color:#0f172a;">${safePhone}</td>
    </tr>
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:13px;color:#64748b;vertical-align:top;">Type</td>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-family:${font};font-size:14px;color:#0f172a;text-transform:capitalize;">${safeType}</td>
    </tr>
    ${message ? `
    <tr>
      <td style="padding:10px 0;font-family:${font};font-size:13px;color:#64748b;vertical-align:top;">Message</td>
      <td style="padding:10px 0;font-family:${font};font-size:14px;color:#0f172a;line-height:1.55;">${safeMessage}</td>
    </tr>` : ""}`;

  const userHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Booklyft demo</title>
</head>
<body style="margin:0;padding:0;background-color:#e2e8f0;-webkit-font-smoothing:antialiased;">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Your Booklyft demo request — details inside.</span>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#e2e8f0;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;border-collapse:collapse;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
          <!-- Header -->
          <tr>
            <td style="padding:28px 32px 24px;background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);background-color:#0f172a;">
              <p style="margin:0;font-family:${font};font-size:22px;font-weight:800;letter-spacing:-0.03em;color:#ffffff;">Booklyft</p>
              <p style="margin:6px 0 0;font-family:${font};font-size:13px;color:#94a3b8;line-height:1.4;">Appointment booking, simplified</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 8px;">
              <p style="margin:0 0 8px;font-family:${font};font-size:15px;color:#0f172a;line-height:1.5;">Hi there,</p>
              <p style="margin:0;font-family:${font};font-size:15px;line-height:1.65;color:#475569;">
                Thanks for your interest in <strong style="color:#0f172a;">Booklyft</strong>. We’ve received your demo request and our team will follow up shortly.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px;">
              ${sandboxBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;">
              <p style="margin:0 0 14px;font-family:${font};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">What you sent us</p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid #f1f5f9;border-radius:12px;overflow:hidden;">
                ${detailsRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0;font-family:${font};font-size:13px;line-height:1.55;color:#94a3b8;">
                If you didn’t request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid #f1f5f9;background-color:#fafafa;">
              <p style="margin:0;font-family:${font};font-size:13px;color:#64748b;">— The Booklyft team</p>
              <p style="margin:8px 0 0;font-family:${font};font-size:11px;color:#cbd5e1;">© ${new Date().getFullYear()} Booklyft · Smart scheduling for salons & clinics</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = [
    "Hi,",
    "",
    "Thanks for requesting a demo of Booklyft. We received your details and will get back to you shortly.",
    "",
  ];
  if (safeMagic) {
    textLines.push(
      "SANDBOX — open this link once (no password). It expires after a few days and works only once:",
      safeMagic,
      "",
    );
  }
  textLines.push(
    `Business: ${businessName}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Type: ${businessType}`,
  );
  if (message) textLines.push("", `Message: ${message}`);
  textLines.push(
    "",
    "If you did not submit this request, you can ignore this email.",
    "",
    "— The Booklyft team",
  );
  const userText = textLines.join("\n");

  const userResult = await resend.emails.send({
    from,
    to: [email],
    subject: safeMagic
      ? "Your Booklyft demo — sandbox link inside"
      : "We received your Booklyft demo request",
    html: userHtml,
    text: userText,
  });
  if (userResult?.error) {
    const errJson = JSON.stringify(userResult.error);
    console.error("[Email] Demo confirmation to user failed (from:", from, "):", errJson);
    if (userResult.error?.statusCode === 403 && /testing emails|verify a domain/i.test(String(userResult.error?.message))) {
      console.error(
        "[Email] Fix: add RESEND_FROM on the server to an address on your verified domain (e.g. Booklyft <noreply@booklyft.bayselabs.in>), redeploy, and ensure that exact subdomain is verified at https://resend.com/domains — not only the parent domain.",
      );
    }
    return { sent: false, reason: "user_send_failed", error: userResult.error };
  }

  const notifyRaw = process.env.DEMO_NOTIFY_EMAIL;
  if (notifyRaw && String(notifyRaw).trim()) {
    const teamTo = String(notifyRaw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (teamTo.length) {
      const internalHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:${font};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr><td style="padding:16px 20px;background:#0f172a;color:#fff;font-size:15px;font-weight:700;">New Booklyft demo request</td></tr>
    <tr><td style="padding:20px;font-size:14px;color:#334155;line-height:1.6;">
      <strong style="color:#0f172a;">Business:</strong> ${safeName}<br/>
      <strong style="color:#0f172a;">Email:</strong> ${safeEmail}<br/>
      <strong style="color:#0f172a;">Phone:</strong> ${safePhone}<br/>
      <strong style="color:#0f172a;">Type:</strong> ${safeType}
      ${message ? `<br/><br/><strong style="color:#0f172a;">Message:</strong><br/>${safeMessage}` : ""}
    </td></tr>
  </table>
</body></html>`;
      const teamResult = await resend.emails.send({
        from,
        to: teamTo,
        subject: `[Booklyft] Demo request: ${businessName}`,
        html: internalHtml,
      });
      if (teamResult?.error) {
        console.error(
          "[Email] Demo notify to team failed:",
          JSON.stringify(teamResult.error),
        );
      }
    }
  }

  return { sent: true };
}
