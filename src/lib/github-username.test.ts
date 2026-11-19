import { describe, expect, it } from "vitest";

import { canonicalizeGithubUsername } from "@/lib/github-username";

describe("canonicalizeGithubUsername", () => {
  it("strips one leading @ after trimming and lowercasing", () => {
    expect(canonicalizeGithubUsername("@Alice")).toBe("alice");
    expect(canonicalizeGithubUsername(" Alice ")).toBe("alice");
    expect(canonicalizeGithubUsername("ALICE")).toBe("alice");
    expect(canonicalizeGithubUsername(" @ALICE ")).toBe("alice");
  });

  it("preserves hyphens and underscores and allows 39 characters", () => {
    expect(canonicalizeGithubUsername("alice-smith_42")).toBe("alice-smith_42");
    expect(canonicalizeGithubUsername("a".repeat(39))).toBe("a".repeat(39));
  });

  it("rejects more than one leading @", () => {
    expect(canonicalizeGithubUsername("@@alice")).toBeNull();
    expect(canonicalizeGithubUsername(" @ @alice")).toBeNull();
  });

  it("rejects empty, 40-character, and non-string values", () => {
    expect(canonicalizeGithubUsername("")).toBeNull();
    expect(canonicalizeGithubUsername("   ")).toBeNull();
    expect(canonicalizeGithubUsername("a".repeat(40))).toBeNull();
    expect(canonicalizeGithubUsername(undefined)).toBeNull();
    expect(canonicalizeGithubUsername(null)).toBeNull();
    expect(canonicalizeGithubUsername(123)).toBeNull();
  });

  it("rejects non-ASCII and homoglyph input without NFKC folding", () => {
    expect(canonicalizeGithubUsername("alice\u00e9")).toBeNull();
    expect(canonicalizeGithubUsername("\u0430lice")).toBeNull();
    expect(canonicalizeGithubUsername("ＡＬＩＣＥ")).toBeNull();
    expect(canonicalizeGithubUsername("alice\u200b")).toBeNull();
  });
});
