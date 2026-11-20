import "server-only";

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}
import { createHash } from "node:crypto";

import enMessages from "../../public/locales/en.json";
import esMessages from "../../public/locales/es.json";
import ptMessages from "../../public/locales/pt.json";
import { resolveLocale, type SupportedLocale } from "@/lib/i18n-config";
import { withRetry } from "@/lib/retry";
import { recordAuditLog } from "@/lib/audit";

const EMAIL_MESSAGES: Record<SupportedLocale, typeof enMessages.email> = {
  en: enMessages.email,
  es: esMessages.email,
  pt: ptMessages.email,
};

export interface LocalizedEmailTemplate {
  subject: string;
  body: string;
}

export interface InviteEmailDetails {
  inviteCode: string;
  recipientName?: string;
  expiresAt?: Date | string | null;
  locale?: string;
}

export interface BanEmailDetails {
  githubUsername: string;
  reason: string;
  locale?: string;
}

export interface EmailNotification {
  to: string;
  subject: string;
  body: string;
  recipientName?: string;
  idempotencyScope?: string;
  attachments?: EmailAttachment[];
}

export interface NotReadyNotification extends EmailNotification {
  contributorUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
  lastCheckedAt?: Date;
}

/**
 * A single dispute that has breached its SLA window. Only non-PII fields
 * (id, age, deep link) are carried so the digest never leaks contributor
 * identity beyond the existing masking policy.
 */
export interface DisputeSlaBreachItem {
  disputeId: string;
  ageHours: number;
  slaHours: number;
  deepLink: string;
}

export interface DisputeSlaBreachDigestDetails {
  breaches: DisputeSlaBreachItem[];
  totalOpenDisputes?: number;
  generatedAt?: Date | string | null;
  locale?: string;
}

export function buildInviteEmail(
  details: InviteEmailDetails
): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].invite;
  const inviteCode = details.inviteCode.trim();
  if (!inviteCode) throw new Error("Invite code is required");

  const recipientName = details.recipientName?.trim() || messages.greetingFallback;
  const expiryDate = formatEmailDate(details.expiresAt, locale);
  const registrationUrl = getRegistrationUrl();

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { recipientName })}</p>
  <p>${messages.codeLabel}: <strong><code>${escapeHtml(inviteCode)}</code></strong></p>
  <p>${expiryDate ? interpolateEmailText(messages.expires, { date: expiryDate }) : messages.noExpiry}</p>
  <p>${messages.instructions}</p>
  <p><a href="${escapeHtml(registrationUrl)}">${messages.action}</a></p>
</div>`.trim(),
  };
}

export function buildBanEmail(details: BanEmailDetails): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].ban;
  const githubUsername = details.githubUsername.trim();
  const reason = details.reason.trim();
  if (!githubUsername) throw new Error("GitHub username is required");
  if (!reason) throw new Error("Ban reason is required");

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { githubUsername })}</p>
  <p><strong>${messages.reasonLabel}:</strong> ${escapeHtml(reason)}</p>
  <p>${messages.nextSteps}</p>
</div>`.trim(),
  };
}

/**
 * Builds the maintainer digest section listing disputes that have breached
 * their SLA. Renders counts plus deep links only — no contributor PII.
 */
export function buildDisputeSlaBreachDigest(
  details: DisputeSlaBreachDigestDetails
): LocalizedEmailTemplate {
  const breaches = Array.isArray(details.breaches) ? details.breaches : [];
  const count = breaches.length;
  const generatedAt = formatEmailDate(details.generatedAt, "en");

  const subject =
    count > 0
      ? `[TrustBridge] ${count} dispute${count === 1 ? "" : "s"} past SLA`
      : "[TrustBridge] No disputes past SLA";

  const rows = breaches
    .map((item) => {
      const age = Number.isFinite(item.ageHours)
        ? Math.max(0, Math.round(item.ageHours))
        : 0;
      const sla = Number.isFinite(item.slaHours)
        ? Math.max(0, Math.round(item.slaHours))
        : 0;
      return `    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;"><a href="${escapeHtml(item.deepLink)}">${escapeHtml(item.disputeId)}</a></td>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;">${age}h</td>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;">${sla}h</td>
    </tr>`;
    })
    .join("\n");

  const summary =
    count > 0
      ? `<p><strong>${count}</strong> dispute${count === 1 ? "" : "s"} exceeded the SLA window${
          typeof details.totalOpenDisputes === "number"
            ? ` (out of ${details.totalOpenDisputes} open)`
            : ""
        }.</p>`
      : `<p>No disputes are currently past their SLA window.</p>`;

  const table =
    count > 0
      ? `  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead>
      <tr>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">Dispute</th>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">Age</th>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">SLA</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`
      : "";

  return {
    subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>Dispute SLA breaches</h2>
  ${summary}
${table}
  ${generatedAt ? `<p style="color:#6c757d;font-size:12px;">Generated ${escapeHtml(generatedAt)}</p>` : ""}
</div>`.trim(),
  };
}

function formatEmailDate(
  value: Date | string | null | undefined,
  locale: SupportedLocale
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function getRegistrationUrl(): string {
  try {
    const url = new URL(
      "/register",
      process.env.NEXTAUTH_URL?.trim() || "https://trustbridge.dev"
    );
    if (url.protocol === "https:" || url.hostname === "localhost") {
      return url.toString();
    }
  } catch {
    // Fall back to the canonical registration page for malformed configuration.
  }
  return "https://trustbridge.dev/register";
}

function interpolateEmailText(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    escapeHtml(values[key] ?? "")
  );
}

/**
 * Maximum number of send attempts (including the first).
 * Configurable via EMAIL_MAX_ATTEMPTS env var, capped at 5.
 */
function getMaxAttempts(): number {
  const raw = Number.parseInt(process.env.EMAIL_MAX_ATTEMPTS ?? "3", 10);
  return Math.min(Math.max(1, Number.isFinite(raw) ? raw : 3), 5);
}

/**
 * Deterministic idempotency key derived from recipient + subject.
 * Prevents duplicate emails when Resend retries a 429 and the first
 * request actually succeeded (network timeout, etc.).
 */
function buildIdempotencyKey(
  to: string,
  subject: string,
  scope?: string
): string {
  const payload = scope ? `${to}:${subject}:${scope}` : `${to}:${subject}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export async function sendEmailNotification(
  notification: EmailNotification
): Promise<boolean> {
  const emailService = process.env.EMAIL_SERVICE || "console";

  if (emailService === "console") {
    return sendViaConsole(notification);
  }

  if (emailService === "resend") {
    return sendViaResend(notification);
  }

  console.warn(`Unknown EMAIL_SERVICE: ${emailService}, falling back to console`);
  return sendViaConsole(notification);
}

async function sendViaConsole(
  notification: EmailNotification
): Promise<boolean> {
  console.log(`[EMAIL] To: ${notification.to}`);
  console.log(`[EMAIL] Subject: ${notification.subject}`);
  console.log(`[EMAIL] Body:\n${notification.body}`);
  if (notification.attachments && notification.attachments.length > 0) {
    console.log(
      `[EMAIL] Attachments: ${notification.attachments
        .map((a) => `${a.filename} (${a.content.length} bytes)`)
        .join(", ")}`
    );
  }
  return true;
}

/**
 * Retryable HTTP error from Resend (429 = rate limit, 5xx = transient).
 * 4xx except 429 are permanent failures — don't retry.
 */
function isRetryableResendError(error: unknown): boolean {
  if (error instanceof ResendApiError) {
    if (error.status === 429) return true;
    if (error.status >= 500) return true;
    return false;
  }
  // Network errors, timeouts, etc. — retry
  return true;
}

class ResendApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ResendApiError";
  }
}

async function sendViaResend(
  notification: EmailNotification
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set, email not sent");
    return false;
  }

  const maxAttempts = getMaxAttempts();
  const idempotencyKey = buildIdempotencyKey(
    notification.to,
    notification.subject,
    notification.idempotencyScope
  );

  try {
    const payload: Record<string, unknown> = {
      from: process.env.EMAIL_FROM || "noreply@trustbridge.dev",
      to: notification.to,
      subject: notification.subject,
      html: notification.body,
    };

    if (notification.attachments && notification.attachments.length > 0) {
      payload.attachments = notification.attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
      }));
    }

    await withRetry(
      async () => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new ResendApiError(
            `Resend API error: ${response.status} ${response.statusText} ${body}`.trim(),
            response.status
          );
        }
      },
      {
        maxAttempts,
        shouldRetry: isRetryableResendError,
      }
    );

    return true;
  } catch (error) {
    console.error("Failed to send email via Resend:", error);
    return false;
  }
}
