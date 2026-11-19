import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { DELETE } from "@/app/api/registrations/[id]/route";
import { POST } from "@/app/api/registrations/[id]/restore/route";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { registration: { findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));

import { requireMaintainerSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

const headers = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
};

function request(url: string, method: string) {
  return new NextRequest(url, { method, headers });
}

const session = {
  user: { id: "maintainer-1", githubUsername: "maintainer" },
};

describe("registration lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("soft-deletes an active registration and audits it", async () => {
    const active = {
      id: "reg-1",
      stellarAddress: "GADDRESS",
      deletedAt: null,
    };
    const deleted = { ...active, deletedAt: new Date("2026-08-28T00:00:00Z") };
    vi.mocked(requireMaintainerSession).mockResolvedValue(session as any);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(active as any);
    vi.mocked(prisma.registration.update).mockResolvedValue(deleted as any);

    const response = await DELETE(
      request("http://localhost:3000/api/registrations/reg-1", "DELETE"),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(200);
    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "registration.delete", targetId: "reg-1" })
    );
  });

  it("restores a deleted registration and audits it", async () => {
    const deleted = {
      id: "reg-1",
      stellarAddress: "GADDRESS",
      deletedAt: new Date("2026-08-28T00:00:00Z"),
    };
    const restored = { ...deleted, deletedAt: null };
    vi.mocked(requireMaintainerSession).mockResolvedValue(session as any);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(deleted as any);
    vi.mocked(prisma.registration.update).mockResolvedValue(restored as any);

    const response = await POST(
      request(
        "http://localhost:3000/api/registrations/reg-1/restore",
        "POST"
      ),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(200);
    expect(prisma.registration.findFirst).toHaveBeenCalledWith({
      where: { id: "reg-1", deletedAt: { not: null } },
    });
    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { deletedAt: null },
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registration.restore",
        targetId: "reg-1",
        targetLabel: "GADDRESS",
        actorId: "maintainer-1",
      })
    );
  });

  it("returns 403 for a non-maintainer without touching the database or audit log", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);

    const response = await POST(
      request("http://localhost:3000/api/registrations/reg-1/restore", "POST"),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin restore without touching the database", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(session as any);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/registrations/reg-1/restore", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          host: "localhost:3000",
        },
      }),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(403);
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when the registration is not soft-deleted", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(session as any);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);

    const response = await POST(
      request("http://localhost:3000/api/registrations/reg-1/restore", "POST"),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Deleted registration not found" });
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 when another active registration already uses the address", async () => {
    const deleted = {
      id: "reg-1",
      stellarAddress: "GADDRESS",
      deletedAt: new Date("2026-08-28T00:00:00Z"),
    };
    vi.mocked(requireMaintainerSession).mockResolvedValue(session as any);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(deleted as any);
    vi.mocked(prisma.registration.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const response = await POST(
      request("http://localhost:3000/api/registrations/reg-1/restore", "POST"),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This Stellar address is already actively registered",
    });
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the maintainer's org and denies cross-org restores", async () => {
    const orgSession = {
      user: { id: "maintainer-2", githubUsername: "other-org", maintainerOrgId: "org-a" },
    };
    vi.mocked(requireMaintainerSession).mockResolvedValue(orgSession as any);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);

    const response = await POST(
      request("http://localhost:3000/api/registrations/reg-1/restore", "POST"),
      { params: { id: "reg-1" } }
    );

    expect(response.status).toBe(404);
    expect(prisma.registration.findFirst).toHaveBeenCalledWith({
      where: {
        id: "reg-1",
        deletedAt: { not: null },
        maintainerOrgId: "org-a",
      },
    });
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});