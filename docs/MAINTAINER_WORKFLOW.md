# Maintainer Workflow

This guide documents operational workflows for TrustBridge maintainers and treasurers, including the `trustbridge-dash` CLI, wave freeze windows, and payout verification.

---

## 1. CLI (`trustbridge-dash`)

The `trustbridge-dash` CLI allows maintainers and automated scripts to export payout data and initiate address rechecks without relying on browser UI sessions.

### Installation & Local Usage

The CLI is registered in `package.json` under `"bin"`:

```bash
# Direct execution via npm/npx or node
./scripts/cli/index.mjs --help
npx trustbridge-dash --help
```

### Commands

#### 1. Login / Credential Setup
Save the target URL and API key locally (stored in `~/.trustbridge/config.json` with `0600` permissions):
```bash
trustbridge-dash login --url https://dashboard.trustbridge.org --api-key <YOUR_API_KEY>
```

Alternatively, provide configuration via environment variables:
```bash
export TRUSTBRIDGE_API_URL="https://dashboard.trustbridge.org"
export TRUSTBRIDGE_API_KEY="<YOUR_API_KEY>"
```

#### 2. Treasury Export
Export contributor readiness and Stellar addresses in CSV (default) or JSON format:
```bash
# Export CSV to stdout or file
trustbridge-dash export --format csv --out ./treasury-export.csv

# Export JSON
trustbridge-dash export --format json --out ./treasury-export.json
```

API clients can request the same formats by POSTing `{"format":"csv"}` or
`{"format":"json"}` to `/api/treasury/export`. The endpoint requires an
operator session or an API key with the `export:read` scope and applies its
same-origin request check.

#### 3. Recheck
Trigger an address verification / readiness check:
```bash
# Batch recheck all contributors (asynchronous background queue)
trustbridge-dash recheck --all

# Recheck a single contributor
trustbridge-dash recheck --username octocat
```

### Batch recheck progress stream

`POST /api/contributors` enqueues a `recheck.batch` job; monitor it with
`GET /api/contributors/queue/progress?jobId=<id>` (maintainer session required,
`text/event-stream`). Events arrive in this order:

1. `status` — initial snapshot (`jobId`, `status`, `createdAt`, `startedAt`).
2. `progress` — zero or more snapshots while the job is processing.
3. `processing` — heartbeat on each poll while still running.
4. `completed` or `failed` — terminal event (or `error` for a missing/foreign job).

Jobs with no persisted progress produce only `status` → `processing` → terminal
events, so existing consumers are unaffected. Snapshots are deduplicated by
`updatedAt`; only strictly newer timestamps are emitted.

The stable progress payload is:

```json
{
  "type": "progress",
  "jobId": "job-42",
  "processed": 12,
  "total": 40,
  "errors": 1,
  "done": false,
  "updatedAt": "2026-10-01T00:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `type` | Always `"progress"` |
| `jobId` | Id of the background queue job |
| `processed` | Number of contributor checks completed so far |
| `total` | Total contributor checks in the batch |
| `errors` | Number of checks that failed (counted from results) |
| `done` | `true` once every check has been recorded |
| `updatedAt` | Monotonic ISO-8601 timestamp, used for dedupe/reconnect |

The worker persists each snapshot in the queue job's existing `result` column
under `result.progress` while the job is `processing`. The final `result`
overwrites that field entirely, so the completed-job result shape is unchanged.
`useJobProgress()` (`src/lib/use-job-progress.ts`) exposes the event fields to
the dashboard without closing the stream on `progress`.

### Security & Protocol Constraints
- **HTTPS Enforcement**: Unencrypted HTTP (`http://`) endpoints are strictly rejected by the CLI to protect API keys and contributor information.
- **Log Masking**: API keys and tokens are never printed in full to logs or error outputs.

---

## 2. Wave Roster Freeze Window

To prevent roster changes or rechecks from shuffling readiness states immediately prior to wave payout settlement:

- **Configuration**:
  - `FREEZE_WINDOW_START` (ISO 8601, e.g. `2026-08-30T00:00:00Z`).
  - `FREEZE_WINDOW_END` (ISO 8601, e.g. `2026-09-02T00:00:00Z`).
  - `FREEZE_WINDOW_ENABLED=true` (or `false` to disable).
- **Behavior**:
  - Mutating operations (`POST /api/register/recheck`, address updates in `POST /api/register`) are blocked during an active freeze window with HTTP `423 Locked` (`code: WAVE_FREEZE_ACTIVE`).
  - Read operations (`GET /api/register`, dashboard viewing) remain fully operational.
  - Blocked attempts are logged in the audit log as `recheck.freeze_blocked` / `address_change.freeze_blocked`.
- **Maintainer Override**:
  - Maintainers can bypass an active freeze window when necessary by supplying header `x-freeze-override: true` or query param `overrideFreeze=true`.
  - Override operations are recorded in the audit log as `recheck.freeze_override` / `address_change.freeze_override`.

---

## 3. Horizon Latency Metrics

- The maintainer metrics dashboard aggregates `horizonLatencyMs` from Horizon address checks.
- Visualizes average latency, median (p50), p95 latency, and sample counts.
- Displays an empty state banner when no samples exist.

---

## 4. Contributor Ban & Unban Management

- Maintainers can ban an abusive or compromised contributor via the maintainer dashboard or `POST /api/maintainer/ban` (`action: "ban"`, `githubUsername: "<username>"`, `reason: "<mandatory reason>"`).
- Banning requires a non-empty reason and applies case-insensitively across current and future account re-registrations.
- Unban via `POST /api/maintainer/ban` (`action: "unban"`, `githubUsername: "<username>"`).
- All actions record audit trail events (`contributor.banned`, `contributor.unbanned`).

---

## 5. Soroban Event Cursor Reset

When operators need to re-index or re-sync Soroban events from a specific ledger or genesis:

1. **Inspect existing cursors**:
   ```sql
   SELECT "maintainerOrgId", "eventType", "cursor", "lastPagingToken", "lastSyncedAt"
   FROM "SorobanEventCursor"
   WHERE "maintainerOrgId" = '<maintainer_org>';
   ```

2. **Reset to a previous ledger/token**:
   ```sql
   UPDATE "SorobanEventCursor"
   SET "cursor" = '<target_ledger_or_token>',
       "lastPagingToken" = NULL,
       "lastSyncedAt" = NOW()
   WHERE "maintainerOrgId" = '<maintainer_org>' AND "eventType" = 'contract';
   ```

3. **Full re-sync from scratch**:
   Delete the cursor record to let the backfill worker start from genesis or the contract inception ledger:
   ```sql
   DELETE FROM "SorobanEventCursor"
   WHERE "maintainerOrgId" = '<maintainer_org>' AND "eventType" = 'contract';
   ```
