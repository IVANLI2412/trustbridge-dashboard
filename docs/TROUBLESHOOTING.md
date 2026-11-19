# Troubleshooting

Stable user-visible messages, their causes, and the action to take. The copy in
`src/lib/check-api-client.ts` (`describeCheckOutcome()`) and `AddressInput` is
shared so support staff can search this page by the exact words a contributor
or maintainer saw.

## Address check messages

| Message shown | Cause | What to do |
|---|---|---|
| `Checking this address with Horizon…` | Debounced check is in flight (`aria-busy=true`). | Wait for it to finish. No action needed. |
| `Check completed.` | Normal successful check; the readiness result block renders alongside it. | Review the readiness badge and "What to do next" copy. |
| `Too many requests. Please retry in Ns.` | `POST /api/check` returned HTTP 429 with `Retry-After`. The client retried up to `CHECK_MAX_ATTEMPTS` times. | Wait `N` seconds, then retry. For repeated 429s, check `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` and the process-local caveat in [Environment Variables](./ENVIRONMENT.md#rate-limiting). |
| `Too many requests. Please try again shortly.` | HTTP 429 without a parseable `Retry-After` header. | Wait a moment and retry; verify a proxy is not stripping `Retry-After`. |
| `Stellar services are temporarily unavailable. Please try again in a moment.` | HTTP 200 result whose `errors` contain the circuit-breaker / Horizon transient-error convention. | Retry shortly. If it persists, check `/api/health`, Horizon status, and the circuit breaker state in `/api/metrics`. |
| `The check timed out. Please try again.` | The client's internal 10 s abort fired before `/api/check` responded. | Retry; investigate slow Horizon responses, RPC latency, and upstream timeouts if repeated. This is **not** caused by the user leaving the page. |
| `Check cancelled.` | The caller aborted the check (address changed during debounce, a newer check started, or the component unmounted). | None — the UI suppresses cancelled results so they never overwrite fresher state. |
| `Network error while checking the address. Please check your connection and retry.` | Fetch failed without an abort (DNS, offline, TLS, or a non-abort network exception). | Check connectivity and `/api/health`; retry. |
| `<first server error>` | Non-2xx response other than 429, with an `errors` array from `/api/check`. | Read the specific error (for example, "Address is required"). Check the request payload and server logs. |
| `Failed to check address.` | Generic fallback when the server returned an error without errors array. | Check server logs and retry. |
| `Enter a full checksum-valid G-address (56 characters)…` | The typed value fails `isValidGAddress()`. | Paste the public G-address only; never paste the S-prefixed secret key. |
| `Could not reach the clipboard. Select the address above and copy it manually.` | Clipboard permission or API failure. | Select the address text manually and copy it. |

The status paragraph uses `data-testid="address-check-status"`, `role="status"`
and `aria-live="polite"`, so assistive technology announces the same stable
copy. Cancelled checks leave it empty rather than showing stale error text.

## Network configuration

| Symptom | Cause | What to do |
|---|---|---|
| "Network paused — Horizon and Soroban RPC disagree" | `NEXT_PUBLIC_HORIZON_URL` and `SOROBAN_RPC_URL` resolve to different known networks. | Follow the [network switching checklist](./ENVIRONMENT.md#network-switching-checklist). The panel is read-only; there is no dashboard switch action. |
| `network_config_mismatch_detected` in `/api/audit` | A maintainer requested `GET /api/settings/network` while the networks were mismatched. | Fix the environment, redeploy, and confirm both badges agree. |

## Address history

| Symptom | Cause | What to do |
|---|---|---|
| `Invalid CSRF token` (403) from `GET /api/address-history` | Missing, expired, or user-mismatched `x-csrf-token`. | Refresh the page so the client obtains a fresh token. See [CSRF protection](./CSRF.md#sensitive-read-routes-double-submit-csrf-token-required). |
| A maintainer sees `redacted:<hash>` instead of a G-address | Maintainer lookup of another user's history projects addresses into a pseudonym by design. | Use the self-service export on the contributor's own session when the raw address is genuinely required. |
