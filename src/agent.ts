// ReviewAgent: one instance per isolated browser workspace (see worker.ts
// for how the instance identity is derived). Holds review history and chat
// as SQLite-backed state that survives reload/reconnect — the "memory or
// state" requirement, and it is load-bearing: reconnecting reads this
// state, not an in-memory stream (PLAN.md §5).

import { Agent, type Connection, type WSMessage } from "agents";
import { analyzePlan } from "./core/analyze.js";
import { PlanParseError } from "./core/parse.js";
import type { AnalysisResult } from "./core/types.js";
import { askAboutReview, summarizeReview } from "./ai/chat.js";

const MAX_INPUT_BYTES = 1_048_576; // 1 MiB, per PLAN.md §7
const MAX_CHANGED_RESOURCES = 200;
const MAX_RETAINED_REVIEWS = 20;
const MAX_CHAT_MESSAGE_CHARS = 2000;

export interface ReviewSummary {
  id: string;
  label: string;
  createdAt: string;
  highCount: number;
  notableCount: number;
  resourceCount: number;
}

export interface AgentPublicState {
  reviews: ReviewSummary[];
  activeReviewId: string | null;
}

interface ReviewRow {
  id: string;
  created_at: string;
  label: string;
  result_json: string;
}

interface MessageRow {
  id: string;
  review_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

function severityCounts(result: AnalysisResult): { high: number; notable: number } {
  let high = 0;
  let notable = 0;
  for (const f of result.findings) {
    if (f.severity === "high") high++;
    else if (f.severity === "notable") notable++;
  }
  return { high, notable };
}

export class ReviewAgent extends Agent<Env, AgentPublicState> {
  override initialState: AgentPublicState = { reviews: [], activeReviewId: null };

  private ensureSchema() {
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      label TEXT NOT NULL,
      result_json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }

  override onStart() {
    this.ensureSchema();
  }

  private getReviewResult(reviewId: string): AnalysisResult | null {
    const rows = this.sql<ReviewRow>`SELECT * FROM reviews WHERE id = ${reviewId}`;
    const row = rows[0];
    if (!row) return null;
    return JSON.parse(row.result_json) as AnalysisResult;
  }

  private syncSummaryState() {
    const rows = this.sql<ReviewRow>`SELECT * FROM reviews ORDER BY created_at DESC`;
    const reviews: ReviewSummary[] = rows.map((row) => {
      const result = JSON.parse(row.result_json) as AnalysisResult;
      const counts = severityCounts(result);
      return {
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        highCount: counts.high,
        notableCount: counts.notable,
        resourceCount: result.facts.length,
      };
    });
    const activeReviewId = this.state.activeReviewId && reviews.some((r) => r.id === this.state.activeReviewId)
      ? this.state.activeReviewId
      : (reviews[0]?.id ?? null);
    this.setState({ reviews, activeReviewId });
  }

  /** POST /review — idempotent on `idempotencyKey`: resubmitting the same
   *  key returns the existing review instead of creating a duplicate. */
  private async handleSubmitReview(request: Request): Promise<Response> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_INPUT_BYTES) {
      return Response.json({ error: `Input exceeds ${MAX_INPUT_BYTES} byte limit.` }, { status: 413 });
    }

    let body: { plan?: unknown; idempotencyKey?: string; label?: string };
    try {
      const text = await request.text();
      if (text.length > MAX_INPUT_BYTES) {
        return Response.json({ error: `Input exceeds ${MAX_INPUT_BYTES} byte limit.` }, { status: 413 });
      }
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Request body must be JSON: { plan, idempotencyKey, label }." }, { status: 400 });
    }

    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : crypto.randomUUID();
    const existing = this.getReviewResult(idempotencyKey);
    if (existing) {
      return Response.json({ reviewId: idempotencyKey, result: existing, deduped: true });
    }

    let result: AnalysisResult;
    try {
      result = analyzePlan(body.plan);
    } catch (err) {
      if (err instanceof PlanParseError) {
        return Response.json({ error: err.message, issues: err.issues }, { status: 422 });
      }
      throw err;
    }

    if (result.facts.length > MAX_CHANGED_RESOURCES) {
      return Response.json(
        { error: `Plan has ${result.facts.length} changed resources; this deployment's limit is ${MAX_CHANGED_RESOURCES}.` },
        { status: 413 },
      );
    }

    const reviewId = idempotencyKey;
    const label = typeof body.label === "string" && body.label ? body.label : `Review ${new Date().toISOString()}`;
    const createdAt = new Date().toISOString();

    this.sql`INSERT INTO reviews (id, created_at, label, result_json) VALUES (${reviewId}, ${createdAt}, ${label}, ${JSON.stringify(result)})`;

    // Evict oldest reviews beyond the retention limit for this workspace.
    const all = this.sql<{ id: string }>`SELECT id FROM reviews ORDER BY created_at DESC`;
    for (const row of all.slice(MAX_RETAINED_REVIEWS)) {
      this.sql`DELETE FROM reviews WHERE id = ${row.id}`;
      this.sql`DELETE FROM messages WHERE review_id = ${row.id}`;
    }

    this.setState({ ...this.state, activeReviewId: reviewId });
    this.syncSummaryState();

    // Fire-and-forget the opening AI summary; the HTTP response already
    // carries the complete deterministic result, so a slow or failed model
    // call never blocks or removes findings.
    this.enrichWithSummary(reviewId, result).catch(() => {});

    return Response.json({ reviewId, result, deduped: false });
  }

  private async enrichWithSummary(reviewId: string, result: AnalysisResult) {
    const answer = await summarizeReview(this.env.AI, result);
    this.appendMessage(reviewId, "assistant", answer.note ? `${answer.text}\n\n${answer.note}` : answer.text);
  }

  private appendMessage(reviewId: string, role: "user" | "assistant", content: string) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.sql`INSERT INTO messages (id, review_id, role, content, created_at) VALUES (${id}, ${reviewId}, ${role}, ${content}, ${createdAt})`;
    this.broadcast(JSON.stringify({ type: "message", reviewId, message: { id, role, content, createdAt } }));
  }

  private handleGetReview(reviewId: string): Response {
    const result = this.getReviewResult(reviewId);
    if (!result) return Response.json({ error: "Review not found in this workspace." }, { status: 404 });
    const messages = this.sql<MessageRow>`SELECT * FROM messages WHERE review_id = ${reviewId} ORDER BY created_at ASC`;
    return Response.json({ reviewId, result, messages });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Path after the agent/instance prefix, e.g. "/review" or "/review/<id>".
    const segments = url.pathname.split("/").filter(Boolean);
    const tail = segments.slice(3); // ["agents", "review-agent", "<id>", ...tail]

    if (request.method === "POST" && tail[0] === "review") {
      return this.handleSubmitReview(request);
    }
    if (request.method === "GET" && tail[0] === "review" && tail[1]) {
      return this.handleGetReview(tail[1]);
    }
    if (request.method === "GET" && tail[0] === "reviews") {
      this.syncSummaryState();
      return Response.json(this.state);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  override async onConnect(_connection: Connection) {
    this.syncSummaryState();
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    let parsed: { type?: string; reviewId?: string; text?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      connection.send(JSON.stringify({ type: "error", error: "Message must be JSON." }));
      return;
    }

    if (parsed.type === "chat" && parsed.reviewId && typeof parsed.text === "string") {
      const text = parsed.text.slice(0, MAX_CHAT_MESSAGE_CHARS);
      const result = this.getReviewResult(parsed.reviewId);
      if (!result) {
        connection.send(JSON.stringify({ type: "error", error: "Unknown review id for this workspace." }));
        return;
      }
      this.appendMessage(parsed.reviewId, "user", text);

      const history = this.sql<MessageRow>`SELECT * FROM messages WHERE review_id = ${parsed.reviewId} ORDER BY created_at ASC`
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }) as const);

      const answer = await askAboutReview(this.env.AI, result, text, { history });
      this.appendMessage(parsed.reviewId, "assistant", answer.note ? `${answer.text}\n\n${answer.note}` : answer.text);
      return;
    }

    if (parsed.type === "set_active" && parsed.reviewId) {
      this.setState({ ...this.state, activeReviewId: parsed.reviewId });
    }
  }
}

export interface Env {
  ReviewAgent: DurableObjectNamespace<ReviewAgent>;
  AI: Ai;
  ASSETS: Fetcher;
}
