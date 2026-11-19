import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const SCRIPT_PATH = "scripts/k6/registration-open-day-load.js";
const DOCS_PATH = "docs/PERFORMANCE_TESTING.md";

const script = read(SCRIPT_PATH);
const docs = read(DOCS_PATH);
const packageJson = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};

function requireAll(source: string, needles: string[], label: string): void {
  for (const needle of needles) {
    if (!source.includes(needle)) {
      throw new Error(`${label} is missing ${JSON.stringify(needle)}`);
    }
  }
}

function assertScriptWiring(source: string): void {
  requireAll(
    source,
    [
      "registration_spike",
      "contributors_paginated",
      "/api/register",
      "/api/contributors/paginated?limit=",
      "TEST_SESSION_COOKIE",
      "TEST_MAINTAINER_SESSION_COOKIE",
      "TEST_CSRF_ORIGIN",
      "TEST_CSRF_REFERER",
      "Origin: CSRF_ORIGIN",
      "Referer: CSRF_REFERER",
      "http.expectedStatuses(200, 201, 409, 429)",
      "uniqueStellarAddress",
      "vus: VUS",
      "duration: DURATION",
    ],
    SCRIPT_PATH
  );
}

function assertThresholds(source: string): void {
  requireAll(
    source,
    [
      "'http_req_failed{scenario:registration_spike}': ['rate<0.05']",
      "'http_req_duration{scenario:registration_spike}': ['p(95)<3000']",
      "'registration_accepted{scenario:registration_spike}': ['rate>0.90']",
      "'registration_conflict{scenario:registration_spike}': ['rate<0.50']",
      "'registration_rate_limited{scenario:registration_spike}': ['rate<0.50']",
      "'http_req_failed{scenario:contributors_paginated}': ['rate<0.02']",
      "'http_req_duration{scenario:contributors_paginated}': ['p(95)<1500']",
      "'contributors_read_ok{scenario:contributors_paginated}': ['rate>0.95']",
      "checks: ['rate>0.95']",
    ],
    "k6 thresholds"
  );
}

function assertNpmWiring(pkg: { scripts: Record<string, string> }): void {
  const command = pkg.scripts["test:k6:registration"];
  if (!command) throw new Error("package.json is missing test:k6:registration");
  requireAll(
    command,
    ["BASE_URL", "TEST_SESSION_COOKIE", "TEST_CSRF_ORIGIN", "VUS", "DURATION", SCRIPT_PATH],
    "package.json test:k6:registration"
  );
}

function assertDocsWiring(source: string): void {
  requireAll(
    source,
    [
      "registration-open-day-load.js",
      "npm run test:k6:registration",
      "TEST_MAINTAINER_SESSION_COOKIE",
      "TEST_CSRF_REFERER",
      "VUS",
      "DURATION",
      "rate<0.05",
      "p(95)<1500",
      "registration_accepted",
      "How to read k6 metrics",
      "freeze window",
      "process-local",
      "non-public Horizon",
      "authenticated contributor session",
    ],
    DOCS_PATH
  );
}

describe("registration load-test script wiring", () => {
  it("defines both named scenarios with session and CSRF configuration", () => {
    expect(() => assertScriptWiring(script)).not.toThrow();
    expect(script).toContain("exec: 'registrationSpike'");
    expect(script).toContain("exec: 'contributorsPaginated'");
  });

  it("declares scenario-tagged thresholds matching the documented criteria", () => {
    expect(() => assertThresholds(script)).not.toThrow();
    expect(docs).toContain("`registration_accepted{scenario:registration_spike}`");
    expect(docs).toContain("`contributors_read_ok{scenario:contributors_paginated}`");
  });

  it("wires the npm script with VUS, DURATION and the required env vars", () => {
    expect(() => assertNpmWiring(packageJson)).not.toThrow();
  });

  it("documents commands, env vars, thresholds, and metric interpretation", () => {
    expect(() => assertDocsWiring(docs)).not.toThrow();
    expect(docs).toContain("contributors-check-load.js");
    expect(docs).toContain("treasury-export-load.js");
  });
});

describe("registration load-test wiring failure paths", () => {
  it("fails when the npm script is missing from package.json", () => {
    expect(() =>
      assertNpmWiring({ scripts: { ...packageJson.scripts, "test:k6:registration": "" } })
    ).toThrowError(/missing test:k6:registration/);
  });

  it("fails when the npm script drops VUS/DURATION passthrough", () => {
    const scripts = {
      ...packageJson.scripts,
      "test:k6:registration": `BASE_URL=http://localhost:3000 TEST_SESSION_COOKIE=x TEST_CSRF_ORIGIN=x k6 run ${SCRIPT_PATH}`,
    };
    expect(() => assertNpmWiring({ scripts })).toThrowError(/is missing "VUS"/);
  });

  it("fails when a scenario threshold is removed from the script", () => {
    const withoutThreshold = script.replace(
      "'http_req_duration{scenario:contributors_paginated}': ['p(95)<1500'],\n",
      ""
    );
    expect(withoutThreshold).not.toBe(script);
    expect(() => assertThresholds(withoutThreshold)).toThrowError(/k6 thresholds/);
  });

  it("fails when the docs omit the freeze-window requirement", () => {
    const withoutFreeze = docs.replace(/freeze window/gi, "maintenance break");
    expect(() => assertDocsWiring(withoutFreeze)).toThrowError(/freeze window/);
  });
});
