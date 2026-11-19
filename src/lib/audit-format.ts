import type { AuditLogEntry } from "@/types";

/** Human-readable labels for known audit actions. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "recheck.single": "Re-checked a contributor",
  "recheck.batch": "Re-checked all contributors",
  "registration.create": "Registered a Stellar address",
  "registration.update": "Updated a Stellar address",
  "registration.delete": "Soft-deleted a registration",
  "registration.restore": "Restored a registration",
  network_config_mismatch_detected: "Detected a Horizon/Soroban network mismatch",
  "contract.sync": "Synced Soroban contract registrations",
  "soroban.outbox.replayed": "Replayed a Soroban outbox item",
  "export.csv": "Exported contributors CSV",
  "export.csv.failed": "Failed to export contributors CSV",
  "export.cron": "Automated nightly treasury CSV export",
  "export.cron.failed": "Automated nightly treasury CSV export failed",
  "export.json": "Exported contributors JSON",
  "export.json.failed": "Failed to export contributors JSON",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "api_key.use_rejected": "API key use rejected",
  "digest.cron": "Scheduled contributor readiness digest sent",
  "digest.cron.failed": "Scheduled contributor readiness digest failed",
};

export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * Shape of a persisted audit row (a subset of the Prisma model). Kept local so
 * this module stays free of `server-only`/Prisma imports and remains testable.
 */
export interface AuditLogRowLike {
  id: string;
  actorId: string | null;
  actorLogin: string | null;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: Date | string;
}

/** Map a persisted row to the serializable API entry. */
export function toAuditLogEntry(row: AuditLogRowLike): AuditLogEntry {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();

  return {
    id: row.id,
    actorId: row.actorId,
    actorLogin: row.actorLogin,
    action: row.action,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt,
  };
}

export interface AuditLogSummary {
  total: number;
  byAction: Record<string, number>;
}

export function summarizeAuditLog(entries: AuditLogEntry[]): AuditLogSummary {
  const byAction: Record<string, number> = {};
  for (const entry of entries) {
    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
  }
  return { total: entries.length, byAction };
}

/**
 * Fixed wire order for an exportable audit entry. Kept explicit so a verifier
 * in another runtime can reproduce the hash without guessing key order.
 */
export const AUDIT_ENTRY_FIELD_ORDER = [
  "id",
  "actorId",
  "actorLogin",
  "action",
  "targetId",
  "targetLabel",
  "metadata",
  "createdAt",
] as const;

/**
 * Recursively sorts object keys so JSON.stringify is stable regardless of the
 * insertion order used by the database driver or the caller.
 */
function stableJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        sorted[key] = stableJsonValue(source[key]);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical, JSON-serializable form of one audit entry.
 *
 * - fields are emitted in {@link AUDIT_ENTRY_FIELD_ORDER}
 * - `createdAt` is normalized to an ISO-8601 UTC string
 * - `metadata` keys are sorted recursively; arrays keep their order
 *
 * @throws if `createdAt` cannot be parsed as a date.
 */
export function canonicalizeAuditEntry(
  entry: AuditLogEntry
): Record<string, unknown> {
  const rawDate: unknown = entry.createdAt;
  const date = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid audit entry createdAt: not a parseable date");
  }

  return {
    id: entry.id,
    actorId: entry.actorId,
    actorLogin: entry.actorLogin,
    action: entry.action,
    targetId: entry.targetId,
    targetLabel: entry.targetLabel,
    metadata:
      entry.metadata === null || entry.metadata === undefined
        ? null
        : stableJsonValue(entry.metadata),
    createdAt: date.toISOString(),
  };
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Pure-JS FNV-1a 32-bit hash; no Node crypto import (client-safe). */
function fnv1a32Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic digest for an exportable audit bundle.
 *
 * This is an integrity checksum, not a cryptographic signature. Entry order is
 * preserved (it is part of the bundle), while key order, date format and
 * metadata key order are canonicalized first.
 */
export function hashAuditBundle(entries: AuditLogEntry[]): string {
  const canonical = entries.map(canonicalizeAuditEntry);
  return fnv1a32Hex(JSON.stringify(canonical));
}
