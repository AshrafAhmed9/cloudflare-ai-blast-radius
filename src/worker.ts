// Worker entry: derives a per-browser workspace identity server-side from
// an HttpOnly cookie (never from a client-supplied instance id in the URL),
// routes /agents/* to that workspace's ReviewAgent instance, and serves the
// static UI for everything else.
//
// Identity model: a 256-bit random value in an HttpOnly, Secure, SameSite=Lax
// cookie. This is a capability-URL-style protection, not HMAC-signed — see
// docs/decisions.md for why that tradeoff is acceptable here and what it
// does not protect against (cookie theft = workspace theft, same as most
// session cookies).

import { routeAgentRequest } from "agents";
import type { Env } from "./agent.js";

const COOKIE_NAME = "br_workspace";
const AGENT_PATH_PREFIX = "/agents/review-agent/";

/** Exact cookie-name parsing: split on "; " and match the key precisely,
 *  rather than a bare substring regex. R2 (adversarial review) — the
 *  earlier `cookie.match(/NAME=(...)/)` would also match a cookie whose
 *  name merely ENDS with "br_workspace" (e.g. a hypothetical
 *  "other_br_workspace=<64 hex chars>" from some other script on the same
 *  origin), silently adopting the wrong value. */
function getWorkspaceIdFromCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === COOKIE_NAME && /^[a-f0-9]{64}$/.test(value)) return value;
  }
  return null;
}

function generateWorkspaceId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function withWorkspaceCookie(response: Response, workspaceId: string): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${workspaceId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
  );
  return wrapped;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // R2 (adversarial review): the client used to open its WebSocket and
    // fire /reviews + /policies fetches in parallel with no prior request,
    // so each could independently land cookie-less at the origin and each
    // generate its OWN random workspace id — splitting one browser session
    // across multiple Durable Object instances. `/api/bootstrap` exists so
    // the client can await exactly one request first, guaranteeing the
    // Set-Cookie round-trip completes before anything else fires. See
    // ui/app.js's hydrateWorkspace().
    if (url.pathname === "/api/bootstrap") {
      const existing = getWorkspaceIdFromCookie(request);
      const workspaceId = existing ?? generateWorkspaceId();
      const response = Response.json({ ok: true });
      return existing ? response : withWorkspaceCookie(response, workspaceId);
    }

    if (url.pathname.startsWith(AGENT_PATH_PREFIX)) {
      let workspaceId = getWorkspaceIdFromCookie(request);
      const isNew = !workspaceId;
      if (!workspaceId) workspaceId = generateWorkspaceId();

      // Overwrite whatever instance segment the client sent with the
      // server-derived id, so a client can never choose another workspace's
      // Agent instance by editing the URL.
      const segments = url.pathname.split("/");
      segments[3] = workspaceId; // ["", "agents", "review-agent", "<id>", ...]
      const routedUrl = new URL(segments.join("/") + url.search, url.origin);
      const routedRequest = new Request(routedUrl, request);

      const response = await routeAgentRequest(routedRequest, env);
      const finalResponse = response ?? Response.json({ error: "Not found" }, { status: 404 });
      // Set-Cookie on a WebSocket upgrade response (status 101) is preserved
      // by `new Response(body, response)` the same way as any other status —
      // verified via the live WS handshake in docs/decisions.md's live
      // verification notes. Still, the client's bootstrap-first sequencing
      // means the WS path should already have a cookie by the time it
      // connects, so `isNew` here should be rare in practice, not load-bearing.
      return isNew ? withWorkspaceCookie(finalResponse, workspaceId) : finalResponse;
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "cf-ai-blast-radius" });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { ReviewAgent } from "./agent.js";
