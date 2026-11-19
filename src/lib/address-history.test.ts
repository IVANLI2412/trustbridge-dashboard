import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findUnique: vi.fn(),
    },
    addressHistoryRecord: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  recordInitialAddress,
  recordAddressChange,
  getAddressHistory,
  getAddressHistoryPage,
  projectAddressHistoryEntry,
  getLatestAddress,
} from "@/lib/address-history";
import { encodeCursor } from "@/lib/cursor-pagination";

describe("Address History", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordInitialAddress", () => {
    it("records initial address for a new registration", async () => {
      const userId = "user-1";
      const address = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTGSNLAYWBEJCLLWTG5V5TGO7Z";

      vi.mocked(prisma.registration.findUnique).mockResolvedValueOnce({
        id: "reg-1",
        userId,
        stellarAddress: address,
      } as any);

      vi.mocked(prisma.addressHistoryRecord.create).mockResolvedValueOnce({
        id: "hist-1",
        userId,
        previousAddress: null,
        newAddress: address,
        changeType: "initial",
        recordedAt: new Date(),
      } as any);

      await recordInitialAddress(userId, address);

      expect(prisma.addressHistoryRecord.create).toHaveBeenCalledWith({
        data: {
          userId,
          previousAddress: null,
          newAddress: address,
          changeType: "initial",
        },
      });
    });

    it("skips recording if no registration exists", async () => {
      const userId = "user-1";
      const address = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTGSNLAYWBEJCLLWTG5V5TGO7Z";

      vi.mocked(prisma.registration.findUnique).mockResolvedValueOnce(null);

      await recordInitialAddress(userId, address);

      expect(prisma.addressHistoryRecord.create).not.toHaveBeenCalled();
    });
  });

  describe("recordAddressChange", () => {
    it("records address change with previous address", async () => {
      const userId = "user-1";
      const previousAddress =
        "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTGSNLAYWBEJCLLWTG5V5TGO7Z";
      const newAddress = "GBBD47UZM2HCF4DAELFSWHYQES7JJLSOHSZTW6YCHLYGUYMPLQMZCSSD";

      vi.mocked(prisma.addressHistoryRecord.create).mockResolvedValueOnce({
        id: "hist-2",
        userId,
        previousAddress,
        newAddress,
        changeType: "updated",
        recordedAt: new Date(),
      } as any);

      await recordAddressChange(userId, previousAddress, newAddress);

      expect(prisma.addressHistoryRecord.create).toHaveBeenCalledWith({
        data: {
          userId,
          previousAddress,
          newAddress,
          changeType: "updated",
        },
      });
    });
  });

  describe("getAddressHistory", () => {
    it("returns address history ordered by most recent first", async () => {
      const userId = "user-1";
      const now = new Date();
      const earlier = new Date(now.getTime() - 86400000); // 1 day earlier

      vi.mocked(prisma.addressHistoryRecord.findMany).mockResolvedValueOnce([
        {
          newAddress: "GBBD47UZM2HCF4DAELFSWHYQES7JJLSOHSZTW6YCHLYGUYMPLQMZCSSD",
          changeType: "updated",
          recordedAt: now,
        },
        {
          newAddress: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTGSNLAYWBEJCLLWTG5V5TGO7Z",
          changeType: "initial",
          recordedAt: earlier,
        },
      ] as any);

      const history = await getAddressHistory(userId);

      expect(history).toHaveLength(2);
      expect(history[0].stellarAddress).toBe(
        "GBBD47UZM2HCF4DAELFSWHYQES7JJLSOHSZTW6YCHLYGUYMPLQMZCSSD"
      );
      expect(history[0].changeType).toBe("updated");
      expect(history[1].changeType).toBe("initial");
    });

    it("returns empty array when no history exists", async () => {
      const userId = "user-1";

      vi.mocked(prisma.addressHistoryRecord.findMany).mockResolvedValueOnce([]);

      const history = await getAddressHistory(userId);

      expect(history).toEqual([]);
    });
  });

  describe("getAddressHistoryPage", () => {
    const rows = [
      {
        id: "hist-3",
        newAddress: "GAAA",
        changeType: "updated",
        recordedAt: new Date("2026-08-03T00:00:00.000Z"),
      },
      {
        id: "hist-2",
        newAddress: "GBBB",
        changeType: "updated",
        recordedAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      {
        id: "hist-1",
        newAddress: "GCCC",
        changeType: "initial",
        recordedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ];

    it("fetches limit+1 rows, orders by recordedAt then id, and returns a cursor", async () => {
      vi.mocked(prisma.addressHistoryRecord.findMany).mockResolvedValueOnce(
        rows.slice(0, 3) as any
      );

      const page = await getAddressHistoryPage("user-1", { limit: 2 });

      expect(prisma.addressHistoryRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1" },
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          take: 3,
        })
      );
      expect(page.history).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe(encodeCursor("hist-2"));
    });

    it("follows a valid id cursor with skip 1 and caps the limit at 100", async () => {
      vi.mocked(prisma.addressHistoryRecord.findMany).mockResolvedValueOnce([
        rows[2],
      ] as any);

      const page = await getAddressHistoryPage("user-1", {
        cursor: encodeCursor("hist-1"),
        limit: 500,
      });

      expect(prisma.addressHistoryRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: "hist-1" },
          skip: 1,
          take: 101,
        })
      );
      expect(page.history).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("degrades an invalid cursor to the first page", async () => {
      vi.mocked(prisma.addressHistoryRecord.findMany).mockResolvedValueOnce(
        rows.slice(0, 2) as any
      );

      await getAddressHistoryPage("user-1", { cursor: "not-base64!!" });

      expect(prisma.addressHistoryRecord.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ cursor: expect.anything() })
      );
      expect(prisma.addressHistoryRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 51 })
      );
    });
  });

  describe("projectAddressHistoryEntry", () => {
    const record = {
      stellarAddress: "GBSX" + "X".repeat(52),
      changeType: "updated",
      recordedAt: new Date("2026-08-01T00:00:00.000Z"),
    };

    it("shows the raw address to the owner", () => {
      expect(
        projectAddressHistoryEntry(record, { isSelf: true, isMaintainer: false })
      ).toEqual({
        ...record,
        addressRedacted: false,
      });
    });

    it("never shows a maintainer a raw address or the previous address", () => {
      const projected = projectAddressHistoryEntry(record, {
        isSelf: false,
        isMaintainer: true,
      });

      expect(projected.stellarAddress).not.toContain(record.stellarAddress);
      expect(projected.stellarAddress).toMatch(/^redacted:[0-9a-f]{12}$/);
      expect(projected).not.toHaveProperty("previousAddress");
      expect(projected.addressRedacted).toBe(true);
    });

    it("is stable for the same address and hides it from unprivileged viewers", () => {
      const viewer = { isSelf: false, isMaintainer: true };
      expect(
        projectAddressHistoryEntry(record, viewer).stellarAddress
      ).toBe(projectAddressHistoryEntry(record, viewer).stellarAddress);
      expect(
        projectAddressHistoryEntry(record, {
          isSelf: false,
          isMaintainer: false,
        }).stellarAddress
      ).toBe("[unavailable]");
    });
  });

  describe("getLatestAddress", () => {
    it("returns the most recent address", async () => {
      const userId = "user-1";
      const latestAddress =
        "GBBD47UZM2HCF4DAELFSWHYQES7JJLSOHSZTW6YCHLYGUYMPLQMZCSSD";

      vi.mocked(prisma.addressHistoryRecord.findFirst).mockResolvedValueOnce({
        newAddress: latestAddress,
      } as any);

      const address = await getLatestAddress(userId);

      expect(address).toBe(latestAddress);
      expect(prisma.addressHistoryRecord.findFirst).toHaveBeenCalledWith({
        where: { userId },
        select: { newAddress: true },
        orderBy: { recordedAt: "desc" },
      });
    });

    it("returns null when no address history exists", async () => {
      const userId = "user-1";

      vi.mocked(prisma.addressHistoryRecord.findFirst).mockResolvedValueOnce(
        null
      );

      const address = await getLatestAddress(userId);

      expect(address).toBeNull();
    });
  });
});
