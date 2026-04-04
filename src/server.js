import "dotenv/config";
import express from "express";
import cors from "cors";

import webhookRouter from "./routes/webhook.js";
import chatRouter from "./routes/chat.js";
import widgetPublicRouter, { serveWidgetScript } from "./routes/widget-public.js";
import adminRouter from "./routes/admin.js";
import { validateWidgetApiKey } from "./middleware/widgetAuth.js";
import billingRouter from "./routes/billing.js";
import authRouter from "./routes/auth.js";
import businessRouter from "./routes/business.js";
import whatsappConnectRouter from "./routes/whatsappConnect.js";
import razorpayWebhookRouter from "./routes/razorpayWebhook.js";
import demoRouter from "./routes/demo.js";
import { startReminderScheduler } from "./services/reminder.service.js";

const app = express();
const PORT = process.env.PORT || 3000;

// So req.protocol / X-Forwarded-* match the public URL behind Render, Railway, etc.
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
// Include this server's own origin — same-origin fetch from /chat/* still sends Origin
// (e.g. http://localhost:3000) and must be allowed or cors() rejects with an error → 500.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.BACKEND_URL,
  "http://localhost:5173",
  "http://localhost:5175",
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
].filter(Boolean);

const strictCors = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/widget")) {
    return cors({
      origin: true,
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Widget-API-Key"],
    })(req, res, next);
  }
  return strictCors(req, res, next);
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Security headers (CSP relaxed enough for hosted chat + Google Fonts)
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: https: blob:",
      "connect-src 'self'",
    ].join("; "),
  );
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "appointbot" }),
);

app.use("/api/auth", authRouter);
app.use("/api/demo", demoRouter);
app.use("/api/business", businessRouter);
app.use("/api/widget", widgetPublicRouter);
app.get("/widget.js", validateWidgetApiKey, serveWidgetScript);
app.use("/api/billing", billingRouter);
app.use("/api/whatsapp-connect", whatsappConnectRouter);
// Razorpay webhooks — support both /webhooks/razorpay and /webhook/razorpay
app.use("/webhooks", razorpayWebhookRouter);
app.use("/webhook", razorpayWebhookRouter);
app.use("/webhook", webhookRouter);
app.use("/chat", chatRouter);
app.use("/admin", adminRouter);

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Prevent crashes from unhandled promise rejections ───────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 appointbot running on http://localhost:${PORT}`);
  console.log(`   Chat UI  → http://localhost:${PORT}/chat`);
  console.log(`   Admin    → http://localhost:${PORT}/admin`);
  console.log(`   Health   → http://localhost:${PORT}/health`);
  console.log(`   Webhook  → POST http://localhost:${PORT}/webhook\n`);

  startReminderScheduler();
});
