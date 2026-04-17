import { Resend } from "resend";

let resendClient;
let warnedMissingKey;

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

const DEFAULT_FROM = "Booklyft <onboarding@resend.dev>";

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

  const from = (process.env.RESEND_FROM || DEFAULT_FROM).trim();
  const safeName = escapeHtml(businessName);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeType = escapeHtml(businessType);
  const safeMessage = message
    ? escapeHtml(message).replace(/\n/g, "<br/>")
    : "";

  const safeMagic =
    magicLinkUrl && /^https?:\/\//i.test(String(magicLinkUrl).trim())
      ? String(magicLinkUrl).trim()
      : null;

  const sandboxBlock = safeMagic
    ? `
    <div style="margin:20px 0;padding:16px;border-radius:12px;background:#f4f4f5;border:1px solid #e4e4e7;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#18181b;">Try the sandbox</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#52525b;">
        Open this link once to sign in to a shared demo workspace (no password). The link expires after a few days and can only be used once.
      </p>
      <a href="${escapeHtml(safeMagic)}"
         style="display:inline-block;padding:10px 18px;background:#18181b;color:#fafafa;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
        Open Booklyft sandbox
      </a>
      <p style="margin:16px 0 0;font-size:12px;line-height:1.4;color:#71717a;word-break:break-all;">
        If the button does not work, copy and paste this URL into your browser:<br/>
        ${escapeHtml(safeMagic)}
      </p>
    </div>`
    : "";

  const userHtml = `
    <p>Hi,</p>
    <p>Thanks for requesting a demo of <strong>Booklyft</strong>. We received your details and will get back to you shortly.</p>
    ${sandboxBlock}
    <p><strong>Business:</strong> ${safeName}<br/>
    <strong>Email:</strong> ${safeEmail}<br/>
    <strong>Phone:</strong> ${safePhone}<br/>
    <strong>Type:</strong> ${safeType}</p>
    ${message ? `<p><strong>Message:</strong><br/>${safeMessage}</p>` : ""}
    <p>If you did not submit this request, you can ignore this email.</p>
    <p>— The Booklyft team</p>
  `;

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
    console.error(
      "[Email] Demo confirmation to user failed:",

      JSON.stringify(userResult.error),
    );
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
        <p><strong>New demo request</strong></p>
        <p><strong>Business:</strong> ${safeName}<br/>
        <strong>Email:</strong> ${safeEmail}<br/>
        <strong>Phone:</strong> ${safePhone}<br/>
        <strong>Type:</strong> ${safeType}</p>
        ${message ? `<p><strong>Message:</strong><br/>${safeMessage}</p>` : ""}
      `;
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
