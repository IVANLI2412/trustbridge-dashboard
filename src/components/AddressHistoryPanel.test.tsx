import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddressHistoryPanel } from "@/components/AddressHistoryPanel";

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddressHistoryPanel", () => {
  it("shows a loading state before the fetch resolves", () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
      )
    );

    renderWithClient(<AddressHistoryPanel />);

    expect(screen.getByTestId("address-history-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("address-history-empty")).not.toBeInTheDocument();

    // Avoid an unhandled promise dangling after the test ends.
    resolveFetch({ ok: true, json: async () => ({ history: [] }) });
  });

  it("shows an explicit empty state when there is no history", async () => {
    mockFetchOnce({ history: [] });

    renderWithClient(<AddressHistoryPanel />);

    const emptyState = await screen.findByTestId("address-history-empty");
    expect(emptyState).toHaveTextContent(/No address history yet/i);
    expect(screen.queryByTestId("address-history-list")).not.toBeInTheDocument();
  });

  it("renders history entries newest-first as returned by the API", async () => {
    mockFetchOnce({
      history: [
        {
          stellarAddress: "GBSX" + "X".repeat(52),
          changeType: "updated",
          recordedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          stellarAddress: "GAAA" + "A".repeat(52),
          changeType: "initial",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<AddressHistoryPanel />);

    const entries = await screen.findAllByTestId("address-history-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent(/Address updated/i);
    expect(entries[1]).toHaveTextContent(/Initial registration/i);
  });

  it("shows an error state when the fetch fails", async () => {
    mockFetchOnce({ error: "boom" }, false);

    renderWithClient(<AddressHistoryPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("address-history-error")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("address-history-empty")).not.toBeInTheDocument();
  });

  it("attaches x-csrf-token header when csrfToken is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<AddressHistoryPanel csrfToken="test-csrf-token-123" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/address-history",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-csrf-token": "test-csrf-token-123",
          }),
        })
      );
    });
  });

  it("loads the next page with the returned cursor and hides the button at the end", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          history: [
            {
              stellarAddress: "GBSX" + "X".repeat(52),
              changeType: "updated",
              recordedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          nextCursor: "aGlzdC0y",
          hasMore: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          history: [
            {
              stellarAddress: "GAAA" + "A".repeat(52),
              changeType: "initial",
              recordedAt: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<AddressHistoryPanel />);

    await screen.findByTestId("address-history-load-more");
    expect(await screen.findAllByTestId("address-history-entry")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("address-history-load-more"));

    await waitFor(() =>
      expect(screen.getAllByTestId("address-history-entry")).toHaveLength(2)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/address-history?cursor=aGlzdC0y",
      expect.anything()
    );
    expect(
      screen.queryByTestId("address-history-load-more")
    ).not.toBeInTheDocument();
  });

  it("renders a redacted address as-is instead of shortening it twice", async () => {
    const redacted = "redacted:0123456789ab";
    mockFetchOnce({
      history: [
        {
          stellarAddress: redacted,
          changeType: "updated",
          recordedAt: "2026-08-01T00:00:00.000Z",
          addressRedacted: true,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });

    renderWithClient(<AddressHistoryPanel />);

    const entry = await screen.findByTestId("address-history-entry");
    expect(entry).toHaveTextContent(redacted);
    expect(entry).not.toHaveTextContent("redacte…");
    expect(entry.querySelector("p")).not.toHaveAttribute("title");
  });
});

