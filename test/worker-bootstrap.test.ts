// R2 regression (adversarial review): worker.ts's cookie parsing and the
// bootstrap endpoint. Two things verified against the real exported
// `fetch` handler, not a reimplementation:
//   1. Exact cookie-name matching — a cookie whose name merely ends with
//      "br_workspace" must not be adopted.
//   2. /api/bootstrap issues one workspace id and Set-Cookie; a second
//      request carrying that cookie gets no new Set-Cookie (idempotent).

import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: vi.fn(async () => new Response("agent", { status: 200 })),
  // src/worker.ts imports src/agent.ts (for the ReviewAgent class export
  // and its Env type), which imports `Agent` from "agents" to extend — a
  // minimal no-op base class is enough for these tests, which never
  // instantiate ReviewAgent.
  Agent: class {},
}));

// Minimal Env stub — /api/bootstrap and cookie parsing never touch AI/ASSETS/ReviewAgent.
const fakeEnv = {} as any;

describe("worker.ts — /api/bootstrap and cookie parsing", () => {
  it("issues a workspace cookie on first request with no prior cookie", async () => {
    const worker = (await import("../src/worker.js")).default;
    const res = await worker.fetch(new Request("https://example.workers.dev/api/bootstrap"), fakeEnv);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/br_workspace=[a-f0-9]{64}/);
    expect(setCookie).toContain("HttpOnly");
  });

  it("does not re-issue a cookie when a valid one is already present", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "a".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/api/bootstrap", { headers: { cookie: `br_workspace=${id}` } }),
      fakeEnv,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not adopt a cookie whose name merely ends with br_workspace (exact-name regression)", async () => {
    const worker = (await import("../src/worker.js")).default;
    const impostorId = "b".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/api/bootstrap", {
        headers: { cookie: `other_br_workspace=${impostorId}` },
      }),
      fakeEnv,
    );
    // No real br_workspace cookie was present, so a NEW one must be issued —
    // the impostor value must not have been treated as the real cookie.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/br_workspace=[a-f0-9]{64}/);
    expect(setCookie).not.toContain(impostorId);
  });

  it("parses the real cookie correctly when other cookies are present alongside it", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "c".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/api/bootstrap", {
        headers: { cookie: `foo=bar; br_workspace=${id}; baz=qux` },
      }),
      fakeEnv,
    );
    expect(res.headers.get("set-cookie")).toBeNull(); // recognized the existing valid cookie, didn't reissue
  });
});

describe("worker.ts — cross-origin rejection on state-changing agent requests (R8)", () => {
  it("rejects a POST to /agents/* whose Origin header doesn't match this Worker's own origin", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "d".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/agents/review-agent/x/review", {
        method: "POST",
        headers: { cookie: `br_workspace=${id}`, origin: "https://attacker.example" },
        body: "{}",
      }),
      fakeEnv,
    );
    expect(res.status).toBe(403);
  });

  it("allows a same-origin POST to /agents/* through to routing", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "e".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/agents/review-agent/x/review", {
        method: "POST",
        headers: { cookie: `br_workspace=${id}`, origin: "https://example.workers.dev" },
        body: "{}",
      }),
      fakeEnv,
    );
    expect(res.status).not.toBe(403);
  });

  it("allows a POST with no Origin header (not a cross-origin fetch)", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "f".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/agents/review-agent/x/review", {
        method: "POST",
        headers: { cookie: `br_workspace=${id}` },
        body: "{}",
      }),
      fakeEnv,
    );
    expect(res.status).not.toBe(403);
  });

  it("does not block a GET to /agents/* (reads, and the WebSocket upgrade, are also GET)", async () => {
    const worker = (await import("../src/worker.js")).default;
    const id = "0".repeat(64);
    const res = await worker.fetch(
      new Request("https://example.workers.dev/agents/review-agent/x/reviews", {
        headers: { cookie: `br_workspace=${id}`, origin: "https://attacker.example" },
      }),
      fakeEnv,
    );
    expect(res.status).not.toBe(403);
  });
});
