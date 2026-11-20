# Registration Data Retention

This document describes how TrustBridge Dashboard handles registration payloads,
including validation, storage, and retention of the fields collected during the
registration flow (`src/app/register/RegisterClient.tsx` → `src/app/api/register/route.ts`).

## Registration payload fields

Registration requests are validated against shared Zod schemas defined in
`src/lib/` so that the API route and the client form enforce identical rules.
The validated fields are:

| Field           | Validation summary                                              |
| --------------- | -------------------------------------------------------------- |
| `email`         | Required, trimmed, lowercased, valid email format, max length. |
| `username`      | Required, trimmed, allowed characters, min/max length.         |
| `walletAddress` | Required, trimmed, expected address format.                    |
| `inviteCode`    | Optional, trimmed, expected format when provided.              |

Invalid payloads are rejected by the API with a `400` response containing
field-level error messages. Auth, CSRF, and rate-limit gates run before payload
validation and are unaffected by these checks.

## Retention

- Registration payloads are retained only as long as needed to provision the
  account and satisfy audit requirements.
- Rejected (invalid) payloads are not persisted; validation errors are returned
  to the caller and not stored.
- Operators should not log raw payload contents (email, wallet address, invite
  code) outside of the standard structured error reporting.

## Retention job dry-run reports

The retention/deletion cron supports a **dry-run** mode that reports what would
be purged without deleting anything. Dry-run is the default; a real purge must
be explicitly requested. Dry-run reports are produced in two formats, JSON and
CSV, and both apply the existing redaction policy (see below) so no secrets,
tokens, or unmasked sensitive addresses leak.

### JSON report shape

```jsonc
{
  "generatedAt": "2024-01-01T00:00:00.000Z", // ISO-8601 timestamp
  "dryRun": true,                            // always true for dry-run reports
  "cutoff": "2023-01-01T00:00:00.000Z",      // records older than this are candidates
  "total": 2,                                // number of candidate records
  "records": [
    {
      "id": "reg_123",                       // opaque record id
      "createdAt": "2022-06-01T00:00:00.000Z",
      "email": "j***@example.com",           // redacted per policy
      "username": "j***e",                    // redacted per policy
      "walletAddress": "0x12…ab"             // redacted per policy
    }
  ]
}
```

### CSV report shape

CSV reports use a fixed header row and one row per candidate record. Fields are
quoted per RFC 4180 and values are redacted identically to the JSON report:

```csv
id,createdAt,email,username,walletAddress
reg_123,2022-06-01T00:00:00.000Z,j***@example.com,j***e,0x12…ab
```

### Redaction policy

- `email`: local part reduced to its first character plus `***`, domain kept.
- `username`: first and last character kept, middle replaced with `***`.
- `walletAddress`: first and last two characters kept, middle replaced with `…`.
- Any field not listed above is omitted from reports rather than emitted raw.

### Reason codes

Dry-run report generation fails with stable, documented reason codes:

| Reason code            | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `invalid_format`       | Requested report format is not `json` or `csv`.                |
| `invalid_cutoff`       | Cutoff timestamp is missing or malformed.                      |
| `payload_too_large`    | Candidate set exceeds the configured report size limit.        |
| `permission_denied`    | Caller lacks the operator scope required for retention jobs.   |
| `dependency_failure`   | Underlying data store or dependency failed; nothing was purged.|

Failures never report silent success: a non-`ok` result always carries one of
the reason codes above. Dry-run never deletes records, so repeated or
concurrent invocations are idempotent and leave no partial privileged state.

## Operator notes

- Validation rules live in the shared schemas under `src/lib/`; update them in
  one place to keep the API and client consistent.
- If a new registration field is added, extend the shared schema and update the
  table above so retention expectations remain documented.
- Always rehearse a purge with a dry-run report (JSON or CSV) before running a
  real deletion, and archive the report for audit purposes.
