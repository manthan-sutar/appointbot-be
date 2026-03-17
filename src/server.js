import "dotenv/config";
import express from "express";
import cors from "cors";

import webhookRouter from "./routes/webhook.js";
import chatRouter from "./routes/chat.js";
import adminRouter from "./routes/admin.js";
import billingRouter from "./routes/billing.js";
import authRouter from "./routes/auth.js";
import businessRouter from "./routes/business.js";
import whatsappConnectRouter from "./routes/whatsappConnect.js";
import razorpayWebhookRouter from "./routes/razorpayWebhook.js";
import { startReminderScheduler } from "./services/reminder.service.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "appointbot" }),
);

app.use("/api/auth", authRouter);
app.use("/api/business", businessRouter);
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
