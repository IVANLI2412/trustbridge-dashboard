export type WaveStatus = "pass" | "fail" | "skipped" | "frozen";

export type WaveStatusBadgeVariant = "ready" | "danger" | "warning";

export const WAVE_STATUS_BADGE_VARIANT: Record<
  WaveStatus,
  WaveStatusBadgeVariant
> = {
  pass: "ready",
  fail: "danger",
  skipped: "warning",
  frozen: "warning",
};

export const WAVE_STATUS_BADGE_CLASSES: Record<WaveStatus, string> = {
  pass: "border-transparent bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  fail: "border-transparent bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  skipped:
    "border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  frozen:
    "border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};
