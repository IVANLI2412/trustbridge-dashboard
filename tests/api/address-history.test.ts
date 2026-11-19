/**
 * API tests — GET /api/address-history (#137)
 *
 * Self-only access to a contributor's own AddressHistoryRecord timeline.
 * Maintainers may pass ?userId= to look up another user's history; the
 * critical case is that non-maintainers passing that param NEVER leak
 * another user's history (IDOR).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/address-history/route";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/address-history", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/address-history")
  >();
  return { ...actual, getAddressHistoryPage: vi.fn() };
});
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));

import { getServerSession } from "next-auth";
import { getAddressHistoryPage } from "@/lib/address-history";
import { recordAuditLog } from "@/lib/audit";
import { encodeCursor } from "@/lib/cursor-pagination";
import { generateCsrfToken } from "@/lib/csrf";

let currentUserId = "user-1";

function getRequest(query = "", customHeaders?: Record<string, string>) {
  const headers: Record<string, string> =
    customHeaders !== undefined
      ? customHeaders
      : { "x-csrf-token": generateCsrfToken(currentUserId) };
  return new NextRequest(`http://localhost:3000/api/address-history${query}`, {
    headers,
  });
}

function mockSession(
  opts: { id?: string; isMaintainer?: boolean; githubUsername?: string } = {}
) {
  currentUserId = opts.id ?? "user-1";
  vi.mocked(getServerSession).mockResolvedValue({
    user: {
      id: currentUserId,
      isMaintainer: opts.isMaintainer ?? false,
      githubUsername: opts.githubUsername,
    },
  } as never);
}

const SAMPLE_HISTORY = [
  {
    stellarAddress: "GBSX" + "X".repeat(52),
    changeType: "updated",
    recordedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  {
    stellarAddress: "GAAA" + "A".repeat(52),
    changeType: "initial",
    recordedAt: new Date("2026-07-01T00:00:00.000Z"),
  },
];

function page(
  history = SAMPLE_HISTORY,
  hasMore = false,
  nextCursor: string | null = null
) {
  return { history, hasMore, nextCursor };
}

afterEach(() => {
  currentUserId = "user-1";
  vi.clearAllMocks();
});

describe("GET /api/address-history — authentication", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/address-history — CSRF protection", () => {
  it("returns 403 with stable error JSON when CSRF token is missing", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const res = await GET(getRequest("", {}));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token is invalid", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const res = await GET(getRequest("", { "x-csrf-token": "invalid-token" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token was issued for another user", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const otherUserToken = generateCsrfToken("user-2");
    const res = await GET(getRequest("", { "x-csrf-token": otherUserToken }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF token is expired", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    const expiredTimestamp = Date.now() - 25 * 60 * 60 * 1000;
    const salt = "0123456789abcdef";
    const crypto = await import("crypto");
    const secret =
      process.env.NEXTAUTH_SECRET ||
      process.env.CSRF_SECRET ||
      "trustbridge-csrf-default-secret-key-32";
    const hmac = crypto
      .createHmac("sha256", secret)
      .update(`user-1:${expiredTimestamp}:${salt}`)
      .digest("hex");
    const expiredToken = `${expiredTimestamp}.${salt}.${hmac}`;

    const res = await GET(getRequest("", { "x-csrf-token": expiredToken }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ error: "Invalid CSRF token" });
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });

  it("accepts valid CSRF token in csrfToken query parameter", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);
    const token = generateCsrfToken("user-1");
    const res = await GET(
      getRequest(`?csrfToken=${encodeURIComponent(token)}`, {})
    );
    expect(res.status).toBe(200);
    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
  cursor: undefined,
  limit: undefined,
});
  });

  it("rejects maintainer ?userId= lookup when CSRF token is missing", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    const res = await GET(getRequest("?userId=other-user", {}));
    expect(res.status).toBe(403);
    expect(getAddressHistoryPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/address-history — self access", () => {
  it("a signed-in contributor gets their own history back", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
  cursor: undefined,
  limit: undefined,
});
    const json = await res.json();
    expect(json.history).toHaveLength(2);
  });

  it("returns an empty array when the user has no history yet", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page([]) as never);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.history).toEqual([]);
  });
});

describe("GET /api/address-history — maintainer lookup", () => {
  it("a maintainer passing ?userId= gets that other user's history", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    const res = await GET(getRequest("?userId=other-user"));
    expect(res.status).toBe(200);
    expect(getAddressHistoryPage).toHaveBeenCalledWith("other-user", {
  cursor: undefined,
  limit: undefined,
});
  });

  it("a maintainer with no ?userId= still gets their own history", async () => {
    mockSession({ id: "maintainer-1", isMaintainer: true });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page([]) as never);

    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(getAddressHistoryPage).toHaveBeenCalledWith("maintainer-1", {
  cursor: undefined,
  limit: undefined,
});
  });
});

describe("GET /api/address-history — pagination and privacy", () => {
  it("passes cursor and limit through and returns pagination metadata", async () => {
    mockSession({ id: "user-1" });
    const cursor = encodeCursor("hist-2");
    vi.mocked(getAddressHistoryPage).mockResolvedValue(
      page(SAMPLE_HISTORY.slice(0, 1), true, cursor) as never
    );

    const res = await GET(getRequest(`?cursor=${cursor}&limit=25`));

    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
      cursor,
      limit: 25,
    });
    const json = await res.json();
    expect(json.history).toHaveLength(1);
    expect(json.nextCursor).toBe(cursor);
    expect(json.hasMore).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("degrades an invalid cursor to the first page", async () => {
    mockSession({ id: "user-1" });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    await GET(getRequest("?cursor=not-base64!!"));

    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
      cursor: "not-base64!!",
      limit: undefined,
    });
  });

  it("ignores an invalid limit instead of passing NaN to the query", async () => {
    mockSession({ id: "user-1" });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    await GET(getRequest("?limit=abc"));

    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
      cursor: undefined,
      limit: undefined,
    });
  });

  it("returns raw addresses to the owner and never a previousAddress", async () => {
    mockSession({ id: "user-1", isMaintainer: true });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    const res = await GET(getRequest());
    const json = await res.json();

    expect(json.history[0].stellarAddress).toBe(SAMPLE_HISTORY[0].stellarAddress);
    expect(json.history[0].addressRedacted).toBe(false);
    expect(json.history[0]).not.toHaveProperty("previousAddress");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("pseudonymizes addresses and audits a maintainer lookup without storing addresses", async () => {
    mockSession({
      id: "maintainer-1",
      isMaintainer: true,
      githubUsername: "octocat",
    });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    const res = await GET(getRequest("?userId=other-user"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.history).toHaveLength(2);
    for (const entry of json.history) {
      expect(entry.stellarAddress).toMatch(/^redacted:[0-9a-f]{12}$/);
      expect(entry.addressRedacted).toBe(true);
      expect(entry).not.toHaveProperty("previousAddress");
    }
    expect(recordAuditLog).toHaveBeenCalledWith({
      action: "address_history.maintainer_lookup",
      actorId: "maintainer-1",
      actorLogin: "octocat",
      targetId: "other-user",
      targetLabel: "address-history",
      metadata: {
        resultCount: 2,
        hasMore: false,
        cursorProvided: false,
      },
    });
    expect(JSON.stringify(vi.mocked(recordAuditLog).mock.calls)).not.toContain(
      SAMPLE_HISTORY[0].stellarAddress
    );
  });
});

describe("GET /api/address-history — IDOR prevention", () => {
  it("a non-maintainer passing ?userId=<other-user-id> only gets their OWN history back", async () => {
    mockSession({ id: "user-1", isMaintainer: false });
    vi.mocked(getAddressHistoryPage).mockResolvedValue(page() as never);

    const res = await GET(getRequest("?userId=attacker-target-user"));

    expect(res.status).toBe(200);
    // Never called with the attacker-supplied userId.
    expect(getAddressHistoryPage).not.toHaveBeenCalledWith("attacker-target-user");
    // Always called with the session user's own id.
    expect(getAddressHistoryPage).toHaveBeenCalledWith("user-1", {
  cursor: undefined,
  limit: undefined,
});
    expect(getAddressHistoryPage).toHaveBeenCalledTimes(1);
  });
});
