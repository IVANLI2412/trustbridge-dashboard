import { describe, expect, it } from "vitest";

import {
  batchVerify,
  calculateVerificationSummary,
  filterByStatus,
  parseJobProgressEvent,
  sortByReadiness,
  type BatchVerificationProgressEvent,
  type VerificationCheckResult,
} from "@/lib/batch-verify";

function result(
  status: VerificationCheckResult["status"],
  username: string = status
): VerificationCheckResult {
  return {
    username,
    stellar_address: `G_${username}`,
    status,
    checks: { funded: true, trustline: true, reserve: true },
  };
}

describe("calculateVerificationSummary", () => {
  it("aggregates counts and percentages", () => {
    const summary = calculateVerificationSummary([
      result("ready"),
      result("ready"),
      result("low_reserve"),
      result("error"),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.ready).toBe(2);
    expect(summary.readyPercentage).toBe(50);
    expect(summary.succeededPercentage).toBe(75);
  });

  it("avoids divide-by-zero for empty input", () => {
    expect(calculateVerificationSummary([]).readyPercentage).toBe(0);
  });
});

describe("sortByReadiness / filterByStatus", () => {
  it("orders ready first and errors last", () => {
    const sorted = sortByReadiness([
      result("error"),
      result("ready"),
      result("not_ready"),
    ]);
    expect(sorted.map((r) => r.status)).toEqual([
      "ready",
      "not_ready",
      "error",
    ]);
  });

  it("filters by a single status", () => {
    const filtered = filterByStatus(
      [result("ready"), result("error")],
      "error"
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].status).toBe("error");
  });
});

describe("batchVerify progress", () => {
  it("emits ordered snapshots with processed, error counts and completion", async () => {
    const events: BatchVerificationProgressEvent[] = [];
    const results = await batchVerify(
      [
        { username: "a", stellar_address: "G_a" },
        { username: "b", stellar_address: "G_b" },
        { username: "c", stellar_address: "G_c" },
      ],
      async (address) => {
        if (address === "G_b") throw new Error("horizon down");
        return result("ready", "ok");
      },
      {
        concurrency: 1,
        jobId: "job-42",
        onProgress: (event) => {
          events.push(event);
        },
      }
    );

    expect(results).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual([
      "progress", "progress", "progress",
    ]);
    expect(events.map((event) => event.jobId)).toEqual([
      "job-42", "job-42", "job-42",
    ]);
    expect(events.map((event) => event.processed)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.total)).toEqual([3, 3, 3]);
    expect(events.map((event) => event.errors)).toEqual([0, 1, 1]);
    expect(events.map((event) => event.done)).toEqual([false, false, true]);
    expect(new Set(events.map((event) => event.updatedAt)).size).toBe(3);
    expect(
      events.map((event) => Date.parse(event.updatedAt)).every(
        (timestamp, index, all) => index === 0 || timestamp > all[index - 1]
      )
    ).toBe(true);
  });

  it("emits a done snapshot with zero processed for an empty batch", async () => {
    const events: BatchVerificationProgressEvent[] = [];
    await batchVerify([], async () => result("ready"), {
      jobId: "empty",
      onProgress: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "progress",
      jobId: "empty",
      processed: 0,
      total: 0,
      errors: 0,
      done: true,
    });
  });

  it("awaits async progress callbacks before resolving", async () => {
    const seen: number[] = [];
    await batchVerify(
      [{ username: "a", stellar_address: "G_a" }],
      async () => result("ready"),
      {
        jobId: "async",
        onProgress: async (event) => {
          await Promise.resolve();
          seen.push(event.processed);
        },
      }
    );
    expect(seen).toEqual([1]);
  });
});

describe("parseJobProgressEvent", () => {
  it("accepts a valid snapshot and rejects malformed ones", () => {
    const valid = {
      type: "progress",
      jobId: "job-1",
      processed: 2,
      total: 3,
      errors: 1,
      done: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(parseJobProgressEvent(valid)).toEqual(valid);
    expect(parseJobProgressEvent(null)).toBeNull();
    expect(parseJobProgressEvent({ ...valid, type: "status" })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, processed: -1 })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, done: "yes" })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, updatedAt: 123 })).toBeNull();
  });
});

describe("batchVerify", () => {
  it("runs all verifications and captures thrown errors", async () => {
    const results = await batchVerify(
      [
        { username: "a", stellar_address: "G_a" },
        { username: "b", stellar_address: "G_b" },
      ],
      async (address) => {
        if (address === "G_b") throw new Error("horizon down");
        return result("ready", "a");
      },
      { concurrency: 2 }
    );

    expect(results).toHaveLength(2);
    const b = results.find((r) => r.username === "b");
    expect(b?.status).toBe("error");
    expect(b?.error_message).toBe("horizon down");
  });
});
