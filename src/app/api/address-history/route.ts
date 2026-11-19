import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import {
  getAddressHistoryPage,
  projectAddressHistoryEntry,
} from "@/lib/address-history";
import { recordAuditLog } from "@/lib/audit";
import { validateCsrfToken } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/address-history — a contributor's own AddressHistoryRecord timeline.
 *
 * Self-only by default: the session user's own history is always returned.
 * Maintainers may pass `?userId=<id>` to look up another user's history (for
 * future maintainer tooling); non-maintainers passing that param are silently
 * ignored and always get their own history back — never another user's
 * (IDOR prevention).
 *
 * Responses are paginated (`?cursor=`, `?limit=`) and field-projected: a
 * maintainer looking at another user never receives raw addresses. The
 * response is never cached, and maintainer lookups are audited without
 * recording any address values.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const csrfToken =
    request.headers.get("x-csrf-token") ??
    request.nextUrl.searchParams.get("csrfToken");
  if (!csrfToken || !validateCsrfToken(session.user.id, csrfToken)) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const requestedUserId = request.nextUrl.searchParams.get("userId");
  const targetUserId =
    session.user.isMaintainer && requestedUserId
      ? requestedUserId
      : session.user.id;
  const isMaintainerLookup = targetUserId !== session.user.id;

  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
  const limit =
    rawLimit !== null && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

  const page = await getAddressHistoryPage(targetUserId, { cursor, limit });
  const history = page.history.map((record) =>
    projectAddressHistoryEntry(record, {
      isSelf: targetUserId === session.user.id,
      isMaintainer: Boolean(session.user.isMaintainer),
    })
  );

  if (isMaintainerLookup) {
    await recordAuditLog({
      action: "address_history.maintainer_lookup",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: targetUserId,
      targetLabel: "address-history",
      metadata: {
        resultCount: history.length,
        hasMore: page.hasMore,
        cursorProvided: Boolean(cursor),
      },
    });
  }

  return NextResponse.json(
    {
      history,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
