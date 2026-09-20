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

function getWorkspaceIdFromCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
  return match ? match[1]! : null;
}

function generateWorkspaceId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

      if (isNew) {
        const withCookie = new Response(finalResponse.body, finalResponse);
        withCookie.headers.append(
          "Set-Cookie",
          `${COOKIE_NAME}=${workspaceId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        );
        return withCookie;
      }
      return finalResponse;
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "cf-ai-blast-radius" });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { ReviewAgent } from "./agent.js";
