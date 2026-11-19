# Badge parity fixtures (#682)

`src/lib/badge-svg.ts` renders the dashboard SVG badge. Its theme table is
shared by readiness statuses and by the Action state aliases so a Wave board
sees the same meaning and color for either badge. Signing
(`src/lib/badge-signing.ts`) and `GET /api/badge/[username]` are unchanged: the
route still renders the computed readiness status, and aliases are available to
any other caller of `renderBadgeSvg`.

## Readiness inputs (existing behavior, unchanged)

| Input | Badge text | Fill color | Shields name (closest) |
|-------|------------|------------|------------------------|
| `ready` | `ready` | `#2ea44f` | green |
| `low_reserve` | `low balance` | `#d97706` | orange |
| `not_ready` | `not ready` | `#dc2626` | red |
| `unknown` (and any unhandled input) | `unknown` | `#6e7681` | grey |

## Action aliases (new parity inputs)

These match `trustbridge-action`'s `getBadgeColor()` / `getBadgeLabel()`
_states_. The hex values are the SVG equivalents of the shields.io color names
the Action puts in its badge URLs.

| Input | Badge text | Shields name | Fill color |
|-------|------------|--------------|------------|
| `pass` | `Ready` | `brightgreen` | `#4c1` |
| `fail` | `Not Ready` | `red` | `#e05d44` |
| `skipped` | `Skipped` | `lightgrey` | `#9f9f9f` |

The Action also defines a `pending` state (`yellow`) for external consumers;
it is not emitted by the normal Action flow and is intentionally not an alias
here. `unknown` remains the dashboard's fallback for unhandled inputs.

## Invariants

- Themes are chosen by exact key; any other string (including an empty value)
  falls back to `unknown` rather than throwing.
- Both the left-hand label and badge text are XML-escaped before interpolation.
- The accessible name is `${label}: ${badge text}` in both `role="img"/aria-label`
  and `<title>`; aliases therefore read e.g. `trustbridge: Skipped`.
- The SVG contains no addresses, balances, tokens, or other PII.
- Widths are derived from the escaped text length, so the new aliases render
  with the same layout rules as existing statuses.

## Illustrative snippet (not an executable test)

```ts
renderBadgeSvg("pass");     // colors: #4c1, text: Ready
renderBadgeSvg("fail");     // colors: #e05d44, text: Not Ready
renderBadgeSvg("skipped");  // colors: #9f9f9f, text: Skipped
```
