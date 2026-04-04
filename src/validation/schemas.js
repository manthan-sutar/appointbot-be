import { z } from "zod";

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/;

/** First Zod issue message for API responses */
export function formatZodError(error) {
  const msg = error?.issues?.[0]?.message;
  return msg || "Invalid input";
}

export const loginBodySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .max(320)
    .email("Valid email required")
    .transform((e) => e.toLowerCase()),
  password: z.string().min(1, "Password is required").max(1024),
});

export const signupBodySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .max(320)
    .email("Valid email required")
    .transform((e) => e.toLowerCase()),
  password: z
    .string()
    .min(
      PASSWORD_MIN_LENGTH,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    )
    .max(256)
    .regex(
      PASSWORD_REGEX,
      "Password must contain uppercase, lowercase, a number, and a special character (@$!%*?&)",
    ),
});

export const demoRequestSchema = z
  .object({
    business_name: z.string().trim().min(1).max(255),
    email: z.string().trim().min(1).max(255).email(),
    phone: z.string().trim().min(1).max(20),
    business_type: z
      .string()
      .trim()
      .transform((s) => s.toLowerCase())
      .refine((v) => ["salon", "doctor", "dentist", "tutor", "other"].includes(v), {
        message: "Please select a valid business type",
      }),
    message: z.string().max(5000).optional().nullable(),
  })
  .transform((d) => ({
    business_name: d.business_name.trim(),
    email: d.email.trim().toLowerCase(),
    phone: d.phone.trim(),
    business_type: d.business_type,
    message:
      d.message != null && String(d.message).trim()
        ? String(d.message).trim()
        : null,
  }));

export const widgetChatBodySchema = z.object({
  message: z.string().min(1).max(5000),
  source: z.string().max(100).optional(),
  campaign: z.string().max(100).optional(),
  utmSource: z.string().max(100).optional(),
});
