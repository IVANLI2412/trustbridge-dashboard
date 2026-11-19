import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/registrations", () => ({
  refreshAllContributors: vi.fn(),
  getContributors: vi.fn(),
  refreshContributor: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({
  createNotification: vi.fn(),
}));

import { backgroundQueue, type Job } from "@/lib/background-queue";
import { createNotification } from "@/lib/notifications";
import { getContributors, refreshAllContributors } from "@/lib/registrations";
import "@/lib/queue-worker";

const mockRefreshAllContributors = vi.mocked(refreshAllContributors);
const mockGetContributors = vi.mocked(getContributors);
const mockCreateNotification = vi.mocked(createNotification);

describe("queue-worker recheck.batch handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContributors.mockResolvedValue({
      contributors: [
        { id: "reg-1" },
        { id: "reg-2" },
      ],
    } as never);
  });

  it("persists intermediate progress snapshots without changing the final result", async () => {
    const handler = (backgroundQueue as unknown as { jobHandlers: Map<string, (job: Job) => Promise<void>> }).jobHandlers.get("recheck.batch");
    const updateProgress = vi
      .spyOn(backgroundQueue, "updateJobProgress")
      .mockResolvedValue(undefined);

    mockRefreshAllContributors.mockImplementation(async (onProgress) => {
      await onProgress?.({ registrationId: "reg-1" });
      await onProgress?.({ registrationId: "reg-2", error: "horizon down" });
      return {
        refreshed: 1,
        changed: 0,
        diffs: [],
        errors: [{ registrationId: "reg-2", message: "horizon down" }],
      };
    });

    const fakeJob: Job = {
      id: "job-42",
      type: "recheck.batch",
      data: {},
      status: "processing",
      createdAt: new Date(),
      ownerId: "user-456",
    };

    await handler!(fakeJob);

    const events = updateProgress.mock.calls.map(([, event]) => event);
    updateProgress.mockRestore();

    expect(events.map((event) => event.processed)).toEqual([1, 2]);
    expect(events.map((event) => event.total)).toEqual([2, 2]);
    expect(events.map((event) => event.errors)).toEqual([0, 1]);
    expect(events[1].done).toBe(true);
    expect(fakeJob.result).toEqual({
      refreshed: 1,
      changed: 0,
      contributorCount: 2,
      errorCount: 1,
      durationMs: expect.any(Number),
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("creates a BATCH_JOB_FAILED notification and rethrows when batch recheck fails", async () => {
    const handler = (backgroundQueue as unknown as { jobHandlers: Map<string, (job: Job) => Promise<void>> }).jobHandlers.get("recheck.batch");
    expect(handler).toBeDefined();

    mockRefreshAllContributors.mockRejectedValue(new Error("Database connection lost"));

    const fakeJob: Job = {
      id: "job-123",
      type: "recheck.batch",
      data: {},
      status: "processing",
      createdAt: new Date(),
      ownerId: "user-456",
    };

    await expect(handler!(fakeJob)).rejects.toThrow("Database connection lost");

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith({
      userId: "user-456",
      type: "BATCH_JOB_FAILED",
      title: "Batch check failed",
      body: "Batch recheck failed: Database connection lost",
      metadata: { jobId: "job-123", error: "Database connection lost" },
    });
  });
});
