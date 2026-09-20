// Regression test for a real bug found via adversarial review: the browser
// client's fetchWorkspaceState() called selectReview() whenever an active
// review existed, and selectReview() called fetchWorkspaceState() again at
// the end — unbounded mutual recursion that never settled once any review
// existed. Fixed in ui/app.js (see hydrateWorkspace/refreshReviewList/
// selectReview and the comment above selectionToken). This test loads the
// real ui/app.js source (not a reimplementation) against stubbed
// fetch/DOM/WebSocket and asserts the number of network calls stays
// bounded during initial hydration.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stubbedDocument() {
  const elements: Record<string, any> = {};
  const makeEl = () => ({
    textContent: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    files: [] as unknown[],
    scrollTop: 0,
    scrollHeight: 0,
    classList: { add() {} },
    appendChild() {},
    addEventListener() {},
    querySelectorAll: () => [],
  });
  return {
    getElementById: (id: string) => (elements[id] ??= makeEl()),
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, classList: { add() {} } }),
  };
}

class StubWebSocket {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() {}
  addEventListener(evt: string, fn: any) {
    (this as any)["on" + evt] = fn;
  }
}

describe("ui/app.js — bounded hydration (no infinite fetch loop)", () => {
  it("performs a small, bounded number of fetch() calls to hydrate the workspace and select the active review", async () => {
    let fetchCount = 0;
    const MAX_ALLOWED = 20; // generous bound; a correctly bounded flow needs well under this

    const fetchStub = vi.fn(async (url: string) => {
      fetchCount++;
      if (fetchCount > MAX_ALLOWED) {
        throw new Error(`possible infinite loop: exceeded ${MAX_ALLOWED} fetch() calls (url=${url})`);
      }
      if (url.includes("/reviews")) {
        return {
          ok: true,
          json: async () => ({ reviews: [{ id: "r1", label: "x", highCount: 0, notableCount: 0 }], activeReviewId: "r1" }),
        };
      }
      if (url.includes("/review/r1")) {
        return {
          ok: true,
          json: async () => ({
            result: { facts: [], findings: [], coverage: [], dependents: {}, warnings: [] },
            messages: [],
            policyFindings: [],
          }),
        };
      }
      if (url.includes("/policies")) {
        return { ok: true, json: async () => ({ policies: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    (globalThis as any).fetch = fetchStub;
    (globalThis as any).WebSocket = StubWebSocket;
    (globalThis as any).document = stubbedDocument();
    (globalThis as any).location = { protocol: "https:", host: "example.workers.dev" };

    const source = readFileSync(join(__dirname, "..", "ui", "app.js"), "utf-8");
    await import(/* @vite-ignore */ "data:text/javascript," + encodeURIComponent(source));

    // Let the async hydration chain (and anything it schedules) settle.
    await new Promise((r) => setTimeout(r, 300));

    expect(fetchCount).toBeGreaterThan(0); // sanity: it actually did something
    expect(fetchCount).toBeLessThan(10); // bounded — the old code never converged at all
  });
});
