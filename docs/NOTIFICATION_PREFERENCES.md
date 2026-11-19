# Notification preferences (#684)

Contributors can control two **email** categories without a schema migration:

| Category | Meaning | Default |
|----------|---------|---------|
| `digest` | Scheduled readiness digest mail | `true` |
| `dispute` | Dispute-related mail | `true` |

Both categories default to enabled. A missing or malformed stored value reads
back as the default; only explicit booleans override it. In-app notifications
and the existing mark-read behavior are unaffected.

## Storage

Preferences live in the existing `User.checklistCompleted` JSON column under
the namespaced key `__notificationPreferences`:

```json
{
  "profileComplete": true,
  "__notificationPreferences": { "digest": false, "dispute": true },
  "__notificationPreferences.digest": false,
  "__notificationPreferences.dispute": true
}
```

The two flat boolean keys are mirrors: onboarding checklist updates rewrite the
same column through `parseChecklistState()`, which retains only boolean values.
The mirrors ensure a preference is not silently lost when a user completes a
checklist. `src/lib/notification-preferences.ts` is the only module that reads
or writes these keys; it preserves all unrelated checklist entries.

## Endpoints

Both endpoints require an authenticated NextAuth session.

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/notifications?scope=preferences` | — | `{ "preferences": { "digest": true, "dispute": true } }` |
| PATCH | `/api/notifications?scope=preferences` | Partial object, e.g. `{ "digest": false }` | `{ "success": true, "preferences": { ... } }` |

Writes use the existing `assertSameOrigin` CSRF guard on
`PATCH /api/notifications` (Origin/Referer must match the app host); unauthenticated
writes return 401 and rejected origins return 403. The body is validated with
zod: each supplied value must be a boolean, unknown keys are rejected, and an
empty object is a 400. Ordinary `GET /api/notifications` and `PATCH
/api/notifications` (mark-read) keep their existing request and response shapes.

## Scope note

This change provides storage and the preference API. It does not add a settings
UI or change the existing digest/export mail senders, which are addressed to
environment-configured recipients rather than per-user addresses. Any future
per-user mail sender should consult `getNotificationPreferences(userId)` before
sending so the `digest` / `dispute` toggles take effect.
