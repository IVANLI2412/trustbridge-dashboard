import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Notification preferences are stored without a schema migration inside the
 * existing `User.checklistCompleted` JSON column, under a namespaced key.
 */
export const NOTIFICATION_PREFERENCES_KEY = "__notificationPreferences";

// Flat boolean mirrors survive onboarding-checklist rewrites, which parse the
// same JSON column through `parseChecklistState` and keep only boolean values.
const DIGEST_MIRROR_KEY = `${NOTIFICATION_PREFERENCES_KEY}.digest`;
const DISPUTE_MIRROR_KEY = `${NOTIFICATION_PREFERENCES_KEY}.dispute`;

export interface NotificationPreferences {
  digest: boolean;
  dispute: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  digest: true,
  dispute: true,
};

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readBoolean(
  root: Record<string, unknown>,
  nestedValue: unknown,
  mirrorKey: string,
  fallback: boolean
): boolean {
  if (typeof nestedValue === "boolean") return nestedValue;
  if (typeof root[mirrorKey] === "boolean") return root[mirrorKey] as boolean;
  return fallback;
}

/** Parse preferences out of a raw `User.checklistCompleted` JSON value. */
export function parseNotificationPreferences(raw: unknown): NotificationPreferences {
  const root = asJsonObject(raw);
  const stored = asJsonObject(root[NOTIFICATION_PREFERENCES_KEY]);

  return {
    digest: readBoolean(
      root,
      stored.digest,
      DIGEST_MIRROR_KEY,
      DEFAULT_NOTIFICATION_PREFERENCES.digest
    ),
    dispute: readBoolean(
      root,
      stored.dispute,
      DISPUTE_MIRROR_KEY,
      DEFAULT_NOTIFICATION_PREFERENCES.dispute
    ),
  };
}

/** Merge preferences back into the checklist JSON, preserving other keys. */
export function withNotificationPreferences(
  raw: unknown,
  preferences: NotificationPreferences
): Prisma.InputJsonValue {
  const next: Record<string, unknown> = { ...asJsonObject(raw) };
  delete next[NOTIFICATION_PREFERENCES_KEY];
  delete next[DIGEST_MIRROR_KEY];
  delete next[DISPUTE_MIRROR_KEY];

  next[NOTIFICATION_PREFERENCES_KEY] = {
    digest: preferences.digest,
    dispute: preferences.dispute,
  };
  next[DIGEST_MIRROR_KEY] = preferences.digest;
  next[DISPUTE_MIRROR_KEY] = preferences.dispute;

  return next as Prisma.InputJsonValue;
}

/** Read the authenticated user's preferences, defaulting both categories on. */
export async function getNotificationPreferences(
  userId: string
): Promise<NotificationPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { checklistCompleted: true },
  });
  return parseNotificationPreferences(user?.checklistCompleted);
}

/** Apply a partial update without replacing unrelated checklist entries. */
export async function updateNotificationPreferences(
  userId: string,
  updates: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { checklistCompleted: true },
  });

  const current = parseNotificationPreferences(user?.checklistCompleted);
  const next: NotificationPreferences = { ...current, ...updates };

  await prisma.user.update({
    where: { id: userId },
    data: {
      checklistCompleted: withNotificationPreferences(
        user?.checklistCompleted,
        next
      ),
    },
  });

  return next;
}
