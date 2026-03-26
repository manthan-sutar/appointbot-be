import express from "express";
import "dotenv/config";
import { query } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ─── Helper: encode/decode state payload ───────────────────────────────────────
function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Allowed characters for frontend origin (protocol + host, no path) to avoid XSS
function sanitizeFrontendOrigin(origin) {
  if (!origin || typeof origin !== "string") return null;
  const trimmed = origin.trim();
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

// Success page shown in popup/same window after connect. Signals opener via postMessage and redirects to dashboard.
function successHtml(frontendOrigin) {
  const safeOrigin = sanitizeFrontendOrigin(frontendOrigin);
  const dashboardUrl = safeOrigin ? `${safeOrigin}/dashboard` : "/dashboard";
  const targetOrigin = safeOrigin || "*";
  const redirectSeconds = 5;
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WhatsApp Connected</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; background: #f9fafb; color: #111827; }
      .card { max-width: 400px; margin: 40px auto; background: #fff; padding: 24px 28px; border-radius: 12px; box-shadow: 0 10px 30px rgba(15,23,42,0.08); text-align: center; }
      h1 { font-size: 20px; margin-bottom: 12px; }
      p { font-size: 14px; line-height: 1.6; margin: 6px 0; }
      .btn { margin-top: 18px; display: inline-block; padding: 10px 18px; border-radius: 8px; background: #111827; color: #fff; font-size: 14px; text-decoration: none; }
      .countdown { font-size: 13px; color: #6b7280; margin-top: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connected</h1>
      <p>WhatsApp is linked. You can go to the dashboard now or we&apos;ll redirect you in a few seconds.</p>
      <a href="${dashboardUrl}" class="btn" id="goBtn">Go to Dashboard</a>
      <p class="countdown" id="countdown"></p>
    </div>
    <script>
      (function() {
        var targetOrigin = ${JSON.stringify(targetOrigin)};
        var dashboardUrl = ${JSON.stringify(dashboardUrl)};
        var redirectSeconds = ${redirectSeconds};
        var remaining = redirectSeconds;
        try {
          if (window.opener) {
            window.opener.postMessage({ type: 'whatsapp-connected' }, targetOrigin);
            setTimeout(function() { window.close(); }, 1500);
          }
        } catch (e) {}
        var countEl = document.getElementById('countdown');
        var countdown = setInterval(function() {
          remaining--;
          if (countEl) countEl.textContent = remaining > 0 ? 'Redirecting to dashboard in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + '…' : '';
          if (remaining <= 0) {
            clearInterval(countdown);
            window.location.href = dashboardUrl;
          }
        }, 1000);
        document.getElementById('goBtn').addEventListener('click', function() {
          if (window.opener) { window.opener.focus(); window.close(); }
          else window.location.href = dashboardUrl;
        });
      })();
    </script>
  </body>
</html>
  `;
}

// ─── GET /api/whatsapp-connect/start ───────────────────────────────────────────
// Returns a URL that starts Meta's WhatsApp embedded signup / OAuth flow.
// Optional query: origin = frontend origin (e.g. https://app.example.com) so the
// callback can postMessage to the opener and redirect to the correct dashboard.
router.get("/start", requireAuth, (req, res) => {
  const appId = process.env.WHATSAPP_APP_ID;
  const configId = process.env.WHATSAPP_EMBEDDED_CONFIG_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";

  if (!appId || !configId) {
    return res.status(500).json({
      error: "WhatsApp embedded signup is not configured on the server.",
    });
  }

  const redirectUri = process.env.WHATSAPP_EMBEDDED_REDIRECT_URL;
  const frontendOrigin = sanitizeFrontendOrigin(req.query.origin);

  const state = encodeState({
    businessId: req.owner.businessId,
    ownerId: req.owner.ownerId,
    ts: Date.now(),
    frontendOrigin: frontendOrigin || undefined,
  });

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: "whatsapp_business_messaging,whatsapp_business_management",
    response_type: "code",
    config_id: configId,
  });

  const url = `https://www.facebook.com/${apiVersion}/dialog/oauth?${params.toString()}`;

  return res.json({ url });
});

// ─── GET /api/whatsapp-connect/callback ────────────────────────────────────────
// Handles the redirect from Meta after the embedded signup flow.
router.get("/callback", async (req, res) => {
  const {
    state,
    error,
    error_description: errorDescription,
    access_token: waAccessToken,
    code,
    waba_id,
    phone_number_id,
    phone_number,
    account_mode,
  } = req.query;

  if (!state) {
    return res.status(400).send("Missing state.");
  }

  const decoded = decodeState(state);
  const businessId = decoded?.businessId;

  if (!businessId) {
    return res.status(400).send("Invalid state.");
  }

  if (error) {
    const msg = errorDescription || error;
    return res.status(400).send(`WhatsApp connect failed: ${msg}`);
  }

  // If Meta returned the access token + phone number details directly, persist
  // them so this business can start sending messages immediately.
  if (waAccessToken && phone_number_id && phone_number) {
    const normalizedPhone = String(phone_number)
      .replace(/^whatsapp:/i, "")
      .trim();
    const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";

    try {
      await query(
        `UPDATE businesses
         SET
           phone                         = COALESCE(phone, $1),
           whatsapp_display_phone        = $2,
           whatsapp_phone_number_id      = $3,
           whatsapp_access_token         = $4,
           whatsapp_api_version          = $5,
           whatsapp_status               = $6,
           whatsapp_business_account_id  = COALESCE($7, whatsapp_business_account_id)
         WHERE id = $8`,
        [
          normalizedPhone,
          phone_number,
          phone_number_id,
          waAccessToken,
          apiVersion,
          account_mode || "connected",
          waba_id || null,
          businessId,
        ],
      );
    } catch (err) {
      console.error("[WhatsApp Connect] Failed to save config:", err.message);
      return res
        .status(500)
        .send("Failed to save WhatsApp configuration. Please try again.");
    }

    return res.send(successHtml(decoded.frontendOrigin));
  }

  // If we did not get credentials inline but we have an auth code, try to exchange
  // it for an access token and resolve WABA + phone numbers via Graph API.
  if (code) {
    const appId = process.env.WHATSAPP_APP_ID;
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";
    const redirectUri =
      process.env.WHATSAPP_EMBEDDED_REDIRECT_URL ||
      `${req.protocol}://${req.get("host")}/api/whatsapp-connect/callback`;

    if (!appId || !appSecret) {
      console.error(
        "[WhatsApp Connect] Missing WHATSAPP_APP_ID or WHATSAPP_APP_SECRET for code exchange",
      );
    } else {
      try {
        const tokenParams = new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code,
        });

        const tokenRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/oauth/access_token?${tokenParams.toString()}`,
        );
        const tokenData = await tokenRes.json();

        if (!tokenRes.ok || !tokenData.access_token) {
          console.error("[WhatsApp Connect] Token exchange failed:", tokenData);
        } else {
          const userAccessToken = tokenData.access_token;
          console.log(
            "[WhatsApp Connect] Token exchange succeeded, resolving WABA + phone numbers…",
          );

          let resolvedWabaId = null;
          let firstPhone = null;

          // Strategy 1: /me?fields=businesses{owned_whatsapp_business_accounts}
          try {
            const meRes = await fetch(
              `https://graph.facebook.com/${apiVersion}/me?fields=businesses{owned_whatsapp_business_accounts}&access_token=${encodeURIComponent(userAccessToken)}`,
            );
            const me = await meRes.json();
            console.log(
              "[WhatsApp Connect] /me response:",
              JSON.stringify(me).slice(0, 500),
            );

            const meBiz = me.businesses?.data || [];
            for (const b of meBiz) {
              const wabAs = b.owned_whatsapp_business_accounts?.data || [];
              if (wabAs.length) {
                resolvedWabaId = wabAs[0].id;
                break;
              }
            }
          } catch (e) {
            console.error(
              "[WhatsApp Connect] Strategy 1 (/me) failed:",
              e.message,
            );
          }

          // Strategy 2: use debug_token to find granular_scopes with WhatsApp targets
          if (!resolvedWabaId) {
            try {
              const debugRes = await fetch(
                `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${encodeURIComponent(userAccessToken)}&access_token=${encodeURIComponent(appId + "|" + appSecret)}`,
              );
              const debugData = await debugRes.json();
              console.log(
                "[WhatsApp Connect] debug_token response:",
                JSON.stringify(debugData).slice(0, 800),
              );

              const scopes = debugData.data?.granular_scopes || [];
              for (const scope of scopes) {
                if (
                  scope.scope === "whatsapp_business_management" &&
                  scope.target_ids?.length
                ) {
                  resolvedWabaId = scope.target_ids[0];
                  break;
                }
                if (
                  scope.scope === "whatsapp_business_messaging" &&
                  scope.target_ids?.length
                ) {
                  resolvedWabaId = scope.target_ids[0];
                  break;
                }
              }
            } catch (e) {
              console.error(
                "[WhatsApp Connect] Strategy 2 (debug_token) failed:",
                e.message,
              );
            }
          }

          // Strategy 3: fall back to env WHATSAPP_BUSINESS_ACCOUNT_ID if set
          if (!resolvedWabaId && process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
            resolvedWabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
            console.log(
              "[WhatsApp Connect] Strategy 3: using env WHATSAPP_BUSINESS_ACCOUNT_ID:",
              resolvedWabaId,
            );
          }

          // Fetch phone numbers from the resolved WABA
          if (resolvedWabaId) {
            try {
              const phonesRes = await fetch(
                `https://graph.facebook.com/${apiVersion}/${resolvedWabaId}/phone_numbers?access_token=${encodeURIComponent(userAccessToken)}`,
              );
              const phonesData = await phonesRes.json();
              console.log(
                "[WhatsApp Connect] phone_numbers response:",
                JSON.stringify(phonesData).slice(0, 500),
              );
              firstPhone = phonesData.data?.[0] || null;
            } catch (e) {
              console.error(
                "[WhatsApp Connect] Failed to fetch phone numbers:",
                e.message,
              );
            }
          }

          if (firstPhone?.id && firstPhone?.display_phone_number) {
            const normalizedPhone = String(firstPhone.display_phone_number)
              .replace(/^whatsapp:/i, "")
              .replace(/^\+/, "")
              .replace(/\s+/g, "");

            try {
              await query(
                `UPDATE businesses
                   SET
                     phone                         = COALESCE(phone, $1),
                     whatsapp_display_phone        = $2,
                     whatsapp_phone_number_id      = $3,
                     whatsapp_access_token         = $4,
                     whatsapp_api_version          = $5,
                     whatsapp_status               = $6,
                     whatsapp_business_account_id  = COALESCE($7, whatsapp_business_account_id)
                 WHERE id = $8`,
                [
                  normalizedPhone,
                  firstPhone.display_phone_number,
                  firstPhone.id,
                  userAccessToken,
                  apiVersion,
                  "connected",
                  resolvedWabaId,
                  businessId,
                ],
              );

              return res.send(successHtml(decoded.frontendOrigin));
            } catch (saveErr) {
              console.error(
                "[WhatsApp Connect] Failed to save config (code path):",
                saveErr.message,
              );
            }
          } else {
            console.error(
              "[WhatsApp Connect] Could not resolve phone number. WABA:",
              resolvedWabaId,
              "Phone:",
              firstPhone,
            );
          }
        }
      } catch (ex) {
        console.error(
          "[WhatsApp Connect] Exception during code exchange flow:",
          ex,
        );
      }
    }
  }

  // Fallback: we did not receive the automatic credentials (e.g. Meta app config).
  return res.send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WhatsApp Setup</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; background: #f9fafb; color: #111827; }
      .card { max-width: 520px; margin: 40px auto; background: #fff; padding: 24px 28px; border-radius: 12px; box-shadow: 0 10px 30px rgba(15,23,42,0.08); }
      h1 { font-size: 20px; margin-bottom: 12px; }
      p { font-size: 14px; line-height: 1.6; margin: 6px 0; }
      .btn { margin-top: 18px; display: inline-block; padding: 8px 14px; border-radius: 999px; background: #111827; color: #fff; font-size: 13px; text-decoration: none; }
      .small { font-size: 12px; color: #6b7280; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connection incomplete</h1>
      <p>We didn't receive your WhatsApp details from Meta. Please try <strong>Connect WhatsApp Business</strong> again from Settings → WhatsApp.</p>
      <p>If it keeps failing, your WhatsApp Business number may need to be approved in the Meta app. Contact support for help.</p>
      <a href="/dashboard/settings" class="btn">Back to Dashboard</a>
    </div>
  </body>
</html>
  `);
});

export default router;
