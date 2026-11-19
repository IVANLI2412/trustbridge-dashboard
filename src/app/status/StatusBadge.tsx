import { Badge } from "@/components/ui/badge";
import type { HealthStatus } from "@/lib/health";
import { StatusIcon } from "./StatusIcon";

const variants: Record<HealthStatus, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300 border-emerald-600 dark:border-emerald-600",
  degraded:
    "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 border-amber-700 dark:border-amber-600",
  error: "bg-destructive/15 text-destructive border-red-600 dark:border-red-600",
};

const labels: Record<HealthStatus, string> = {
  ok: "Operational",
  degraded: "Degraded",
  error: "Outage",
};

export function StatusBadge({ status }: { status: HealthStatus }) {
  return (
    <Badge className={`gap-1.5 ${variants[status]}`}>
      <StatusIcon status={status} />
      {labels[status]}
    </Badge>
  );
}
