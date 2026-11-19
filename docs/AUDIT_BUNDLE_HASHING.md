# Audit bundle hashing (#685)

`GET /api/audit` returns `{ entries, summary, hash }`. The `hash` is an 8-character
lowercase hex **FNV-1a 32-bit** digest over the canonical serialization of the
exported `entries` array. It lets a reviewer verify that an offline copy of a
bundle matches what the dashboard served, without any secret or crypto library.

This is an integrity checksum, not a signature: anyone who can edit the entries
can recompute it. Keep the original response alongside the bundle when
archiving for compliance.

## Canonical form

Each entry is emitted with this fixed key order
(`src/lib/audit-format.ts` → `AUDIT_ENTRY_FIELD_ORDER`):

1. `id`
2. `actorId`
3. `actorLogin`
4. `action`
5. `targetId`
6. `targetLabel`
7. `metadata`
8. `createdAt`

Normalization rules:

- `createdAt` is parsed and emitted as an ISO-8601 UTC string
  (`new Date(value).toISOString()`). Invalid dates throw with a stable error
  instead of producing a misleading hash.
- `metadata` is recursively key-sorted (`Object.keys(...).sort()`); arrays keep
  their order; `undefined` object values are omitted; `null` metadata stays
  `null`.
- `null` fields stay `null`; no field is dropped or renamed.
- Entry order in the bundle is **significant** and preserved as received.
- The canonical objects are serialized with `JSON.stringify` and fed to FNV-1a
  over UTF-16 code units (`charCodeAt`), seeded with `0x811c9dc5` and multiplied
  by `0x01000193` per byte with `Math.imul`.

## Verifier steps

1. Save the API response as `bundle.json` (entries in the exact order returned).
2. Import `hashAuditBundle` from `src/lib/audit-format.ts`, or reimplement the
   rules above in the verifier's language.
3. Compute `hashAuditBundle(bundle.entries)`.
4. Compare the lowercase hex string with `bundle.hash`. A mismatch means the
   entries were changed, reordered, or normalized differently — do not treat
   the bundle as verified.

Illustrative (non-test) snippet:

```ts
import { hashAuditBundle } from "./src/lib/audit-format";

const bundle = JSON.parse(fs.readFileSync("bundle.json", "utf8"));
const ok = hashAuditBundle(bundle.entries) === bundle.hash;
```

## Node-version stability

The implementation uses only pure JavaScript: `Math.imul`, `charCodeAt`,
`JSON.stringify`, `Date#toISOString()` and `Array#sort()`. It does **not** import
`node:crypto`, so it works in the client bundle as well as on the server. FNV-1a
over UTF-16 code units, ISO date formatting, and lexicographic key sorting are
stable across Node 18, 20 and 22; no locale-dependent comparison or
`Intl` formatting is involved. A 32-bit hash has collision limits — use it to
detect accidental drift, not to adjudicate adversarial tampering.
