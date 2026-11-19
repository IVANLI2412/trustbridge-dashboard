import type { HorizonCheckResult } from "@/types";

/**
 * Client-side wrapper around `POST /api/check`.
 *
 * The route itself already encodes several distinct outcomes (see
 * `src/app/api/check/route.ts`), but they arrive over the wire in
 * inconsistent shapes:
 *  - Rate limiting is a genuine HTTP 429 with a `Retry-After` header.
 *  - A circuit-breaker-open / transient Horizon failure is still HTTP 200,
 *    with a normal `HorizonCheckResult` body whose `errors` array contains a
 *    recognizable string (`"...temporarily unavailable..."` or a
 *    `"Horizon error: ..."` prefix). There is no dedicated status code or
 *    field for this today, and changing that is out of scope for this
 *    change — we only need to recognize the existing convention.
 *  - Anything else non-2xx is a generic error.
 *  - The request itself can hang (Horizon retries/circuit breaker can sit
 *    for a while), so this wrapper applies its own 10 s timeout via an
 *    `AbortController` and also relays a caller-provided AbortSignal.
 *
 * This helper normalizes all of that into a single discriminated union so
 * UI code can `switch` on `outcome.kind` instead of re-deriving these rules.
 *
 * Retries: transient failures (timeout, network error, circuit-open, and
 * 429/5xx responses) are retried a bounded number of times. Every attempt
 * carries the same `Idempotency-Key` for correlation, but `/api/check` is a
 * read-only Horizon check and does not dedupe requests on that header.
 */

/** How long to wait for `/api/check` before treating the request as timed out. */
export const CHECK_TIMEOUT_MS = 10_000;

/** Maximum number of attempts (initial + retries) for a single check. */
export const CHECK_MAX_ATTEMPTS = 3;

/** Base backoff between retries, in milliseconds (exponential). */
export const CHECK_RETRY_BASE_MS = 250;

export type CheckOutcome =
  | { kind: "ok"; result: HorizonCheckResult }
  | { kind: "rate_limited"; retryAfterSeconds: number | null; errors: string[] }
  | { kind: "circuit_open"; errors: string[] }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network_error" }
  | { kind: "error"; status: number; errors: string[] };

/**
 * True when a successful (HTTP 200) `HorizonCheckResult`'s `errors` match the
 * known transient-Horizon-failure conventions emitted by `src/lib/horizon.ts`
 * (circuit breaker open, or a generic wrapped Horizon error).
 */
function isTransientHorizonError(errors: string[] | undefined): boolean {
  if (!errors || errors.length === 0) return false;
  return errors.some(
    (error) =>
      error.includes("temporarily unavailable") ||
      error.startsWith("Horizon error:")
  );
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Generate a stable correlation key for a single logical check. Uses
 * `crypto.randomUUID` when available and falls back to a random string. The
 * header is informational only — `/api/check` does not dedupe on it.
 */
function createIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `check-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when an outcome represents a transient failure worth retrying. A
 * `rate_limited` outcome is retried only when the server did not ask us to
 * wait longer than our bounded backoff budget.
 */
function isRetryable(outcome: CheckOutcome): boolean {
  switch (outcome.kind) {
    case "aborted":
      return false;
    case "timeout":
    case "network_error":
    case "circuit_open":
      return true;
    case "error":
      return outcome.status >= 500;
    case "rate_limited":
      return true;
    default:
      return false;
  }
}

/**
 * Perform a single attempt against `/api/check`. Never throws — all failure
 * modes are represented as outcomes. A caller abort wins over the internal
 * timeout so cancellation is never mislabelled as a slow Horizon request.
 */
async function attemptCheck(
  address: string,
  options: { assetCode?: string; assetIssuer?: string; signal?: AbortSignal },
  idempotencyKey: string
): Promise<CheckOutcome> {
  if (options.signal?.aborted) return { kind: "aborted" };

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        address,
        asset_code: options.assetCode,
        asset_issuer: options.assetIssuer,
      }),
      signal: controller.signal,
    });

    if (options.signal?.aborted) return { kind: "aborted" };

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: string[];
      };
      return {
        kind: "rate_limited",
        retryAfterSeconds: parseRetryAfter(response),
        errors: body.errors ?? ["Rate limit exceeded. Please try again later."],
      };
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: string[];
      };
      return {
        kind: "error",
        status: response.status,
        errors: body.errors ?? ["Failed to check address"],
      };
    }

    const result = (await response.json()) as HorizonCheckResult;

    if (isTransientHorizonError(result.errors)) {
      return { kind: "circuit_open", errors: result.errors };
    }

    return { kind: "ok", result };
  } catch (error) {
    if (options.signal?.aborted) return { kind: "aborted" };
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    // A same-shaped abort can also surface as a plain Error in some
    // environments (e.g. jsdom/node-fetch polyfills) rather than a
    // DOMException — treat any "aborted"-named error the same way.
    if (
      error instanceof Error &&
      (error.name === "AbortError" || /aborted/i.test(error.message))
    ) {
      return { kind: "timeout" };
    }
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

/**
 * POST an address to `/api/check` and normalize the response into a
 * `CheckOutcome`. Never throws — all failure modes (internal timeout, caller
 * cancellation, network error, non-2xx status, transient Horizon failure) are
 * represented as outcomes.
 *
 * Transient failures are retried up to `CHECK_MAX_ATTEMPTS` total attempts
 * with the same correlation key. Caller cancellation stops retries immediately,
 * including during backoff.
 */
export async function checkAddressViaApi(
  address: string,
  options: {
    assetCode?: string;
    assetIssuer?: string;
    signal?: AbortSignal;
  } = {}
): Promise<CheckOutcome> {
  const idempotencyKey = createIdempotencyKey();
  let outcome: CheckOutcome = { kind: "network_error" };

  for (let attempt = 0; attempt < CHECK_MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { kind: "aborted" };

    outcome = await attemptCheck(address, options, idempotencyKey);

    if (outcome.kind === "ok" || !isRetryable(outcome)) {
      return outcome;
    }

    const isLastAttempt = attempt === CHECK_MAX_ATTEMPTS - 1;
    if (isLastAttempt) break;

    // Honor a server-provided Retry-After when present, otherwise use
    // exponential backoff. Cap the wait so a large Retry-After does not
    // stall the UI indefinitely.
    const backoff = CHECK_RETRY_BASE_MS * 2 ** attempt;
    const retryAfterMs =
      outcome.kind === "rate_limited" && outcome.retryAfterSeconds !== null
        ? outcome.retryAfterSeconds * 1000
        : 0;
    const waited = await sleep(
      Math.min(Math.max(backoff, retryAfterMs), CHECK_TIMEOUT_MS),
      options.signal
    );
    if (waited === "aborted") return { kind: "aborted" };
  }

  return outcome;
}

/**
 * Human-readable, actionable message for a `CheckOutcome`. UI code should
 * render this instead of re-deriving copy per outcome kind, so degraded
 * states (circuit open, timeout, network failure) stay consistent.
 */
export function describeCheckOutcome(outcome: CheckOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return "Check completed.";
    case "rate_limited":
      return outcome.retryAfterSeconds !== null
        ? `Too many requests. Please retry in ${outcome.retryAfterSeconds}s.`
        : "Too many requests. Please try again shortly.";
    case "circuit_open":
      return "Stellar services are temporarily unavailable. Please try again in a moment.";
    case "timeout":
      return "The check timed out. Please try again.";
    case "aborted":
      return "Check cancelled.";
    case "network_error":
      return "Network error while checking the address. Please check your connection and retry.";
    case "error":
      return outcome.errors[0] ?? "Failed to check address.";
    default:
      return "Failed to check address.";
  }
}
