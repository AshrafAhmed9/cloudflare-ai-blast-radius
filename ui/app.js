// Vanilla JS client. No build step, no framework — see PLAN.md §5 ("choose
// the simplest client supported by the current SDK"); a plain WebSocket +
// fetch is simplest here since the UI surface is small.

const AGENT_HTTP_BASE = "/agents/review-agent/workspace"; // "workspace" segment is overwritten server-side (see worker.ts)
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + AGENT_HTTP_BASE;

const el = {
  status: document.getElementById("status"),
  submitBtn: document.getElementById("submitBtn"),
  submitStatus: document.getElementById("submitStatus"),
  planInput: document.getElementById("planInput"),
  fileInput: document.getElementById("fileInput"),
  reviewList: document.getElementById("reviewList"),
  report: document.getElementById("report"),
  chatLog: document.getElementById("chatLog"),
  chatEmpty: document.getElementById("chatEmpty"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatSend: document.getElementById("chatSend"),
};

let ws = null;
let wsReady = false;
let activeReviewId = null;
let activeResult = null;
const reviewCache = new Map(); // reviewId -> { result, messages }

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => {
    wsReady = true;
    el.status.textContent = "connected";
    if (activeReviewId) {
      el.chatInput.disabled = false;
      el.chatSend.disabled = false;
    }
    // R3 (adversarial review): a reconnect used to only flip the status
    // text. Any assistant reply that arrived while the socket was down
    // (e.g. the fire-and-forget opening summary) was never fetched, so the
    // chat looked stuck. Re-pull the canonical message list for whatever
    // review is active so a reconnect can't silently drop messages.
    rehydrateActiveReview();
  });
  ws.addEventListener("close", () => {
    wsReady = false;
    el.status.textContent = "disconnected — retrying…";
    // R3: chat looked usable while disconnected — the form's submit
    // handler silently swallowed the click. Disable it explicitly so the
    // UI matches reality; re-enabled on reconnect above.
    el.chatInput.disabled = true;
    el.chatSend.disabled = true;
    setTimeout(connectWebSocket, 2000);
  });
  ws.addEventListener("error", () => {
    el.status.textContent = "connection error";
  });
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch {
      // ignore malformed frames
    }
  });
}

function handleServerMessage(data) {
  if (data.type === "message" && data.reviewId) {
    const cache = reviewCache.get(data.reviewId);
    if (cache) cache.messages = [...(cache.messages ?? []), data.message];
    if (data.reviewId === activeReviewId) appendChatBubble(data.message);
  }
}

function severityBadge(sev) {
  return `<span class="badge ${sev}">${sev}</span>`;
}

function renderReport(result, policyFindings) {
  if (!result) {
    el.report.innerHTML = `<div class="empty-state">No review selected yet.</div>`;
    return;
  }
  const policyByResource = new Map();
  for (const pf of policyFindings ?? []) {
    const list = policyByResource.get(pf.resourceId) ?? [];
    list.push(pf);
    policyByResource.set(pf.resourceId, list);
  }
  if (result.facts.length === 0) {
    el.report.innerHTML = `<div class="empty-state">Plan parsed successfully — no resource changes present.</div>`;
    return;
  }
  const parts = [];
  if (result.warnings?.length) {
    parts.push(`<div class="finding" style="border-color:var(--notable)">${result.warnings.map(escapeHtml).join("<br/>")}</div>`);
  }
  const findingsByResource = new Map();
  for (const f of result.findings) {
    const list = findingsByResource.get(f.resourceId) ?? [];
    list.push(f);
    findingsByResource.set(f.resourceId, list);
  }
  const coverageByResource = new Map(result.coverage.map((c) => [c.resourceId, c]));
  const dependents = result.dependents ?? {};

  // R12 (adversarial review): resources rendered in plan order, so the one
  // high-severity finding in a 40-resource plan could be scrolled past
  // entirely. Sort by worst finding first (high, then notable, then none),
  // stable otherwise so unrelated resources keep their original order.
  const severityRank = { high: 0, notable: 1 };
  const sortedFacts = [...result.facts].sort((a, b) => {
    const rank = (id) => {
      const fs = findingsByResource.get(id) ?? [];
      const worst = fs.reduce((acc, f) => Math.min(acc, severityRank[f.severity] ?? 2), 2);
      return worst;
    };
    return rank(a.id) - rank(b.id);
  });

  for (const fact of sortedFacts) {
    const findings = findingsByResource.get(fact.id) ?? [];
    const cov = coverageByResource.get(fact.id);
    const deps = dependents[fact.id] ?? [];
    const topSeverity = findings.some((f) => f.severity === "high") ? "high" : findings.some((f) => f.severity === "notable") ? "notable" : null;

    parts.push(`
      <div class="resource" role="listitem">
        <div class="addr">${escapeHtml(fact.address)}
          <span class="badge info">${escapeHtml(fact.plannedAction)}</span>
          ${topSeverity ? severityBadge(topSeverity) : ""}
          <span class="badge coverage">coverage: ${escapeHtml(cov?.status ?? "unknown")}</span>
        </div>
        ${fact.plannedAction.startsWith("replace") && !fact.replacementCauseAvailable
          ? `<div class="finding">Replacement cause unavailable in the plan JSON — not treated as known.</div>`
          : ""}
        ${fact.replacePaths.map((p) => `<div class="evidence">replace_path: ${escapeHtml(p.path)}</div>`).join("")}
        ${findings.map((f) => `<div class="finding">${severityBadge(f.severity)} ${escapeHtml(f.message)} <span class="evidence">(rule=${escapeHtml(f.ruleId)})</span></div>`).join("")}
        ${deps.length ? `<div class="evidence">referenced by: ${deps.map((d) => `${escapeHtml(d.resourceId)} (${d.relationship})`).join(", ")}</div>` : ""}
        ${(policyByResource.get(fact.id) ?? []).map((pf) => `<div class="finding">${severityBadge(pf.result === "unknown" ? "notable" : pf.severity)} policy "${escapeHtml(pf.sentence)}" → ${escapeHtml(pf.result)}</div>`).join("")}
      </div>
    `);
  }

  if (result.unresolvedReferences?.length) {
    parts.push(`<div class="empty-state">${result.unresolvedReferences.length} reference(s) not resolved — not assumed to be edges.</div>`);
  }

  el.report.innerHTML = parts.join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderReviewList(reviews) {
  el.reviewList.innerHTML = "";
  if (!reviews || reviews.length === 0) {
    el.reviewList.innerHTML = `<span class="status">No reviews yet in this workspace.</span>`;
    return;
  }
  for (const r of reviews) {
    const btn = document.createElement("button");
    btn.textContent = `${r.label} — ${r.highCount} high, ${r.notableCount} notable`;
    btn.setAttribute("aria-pressed", String(r.id === activeReviewId));
    if (r.id === activeReviewId) btn.classList.add("primary");
    btn.addEventListener("click", () => selectReview(r.id));
    el.reviewList.appendChild(btn);
  }
}

function appendChatBubble(message) {
  el.chatEmpty.hidden = true;
  const div = document.createElement("div");
  div.className = `msg ${message.role}`;
  div.textContent = message.content;
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

// R1 fix (adversarial review): fetchWorkspaceState() used to call
// selectReview() when there was an active review, and selectReview() called
// fetchWorkspaceState() again at the end — an unbounded mutual-recursion
// loop that never settled once any review existed. Fixed by separating
// "refresh the list" (never selects) from "select a review" (never
// re-fetches the whole workspace, only refreshes the list rendering after).
// selectionToken guards against a slow, stale selectReview() call
// overwriting a newer one if the user clicks two reviews in quick succession.

let selectionToken = 0;

async function refreshReviewList() {
  const res = await fetch(`${AGENT_HTTP_BASE}/reviews`);
  if (!res.ok) return null;
  const state = await res.json();
  renderReviewList(state.reviews);
  return state;
}

async function selectReview(reviewId) {
  const token = ++selectionToken;
  activeReviewId = reviewId;
  let cache = reviewCache.get(reviewId);
  if (!cache) {
    const res = await fetch(`${AGENT_HTTP_BASE}/review/${encodeURIComponent(reviewId)}`);
    if (token !== selectionToken) return; // a newer selection started while this fetch was in flight
    if (!res.ok) return;
    const data = await res.json();
    cache = { result: data.result, messages: data.messages ?? [], policyFindings: data.policyFindings ?? [] };
    reviewCache.set(reviewId, cache);
  }
  if (token !== selectionToken) return; // still guard the cached-hit path for consistency

  activeResult = cache.result;
  renderReport(activeResult, cache.policyFindings);
  el.chatLog.innerHTML = "";
  el.chatEmpty.hidden = cache.messages.length > 0;
  if (cache.messages.length === 0) el.chatLog.appendChild(el.chatEmpty);
  for (const m of cache.messages) appendChatBubble(m);
  el.chatInput.disabled = false;
  el.chatSend.disabled = false;
  if (ws && wsReady) ws.send(JSON.stringify({ type: "set_active", reviewId }));
  await refreshReviewList().catch(() => {}); // updates list highlighting only — never re-selects
}

/** Call once, on initial page load only. */
async function hydrateWorkspace() {
  const state = await refreshReviewList().catch(() => null);
  if (state?.activeReviewId) await selectReview(state.activeReviewId);
}

/** Re-pulls the canonical message list for the active review from the
 *  server (R3) — called on every WebSocket (re)connect. Always replaces
 *  the cache and re-renders from the server's own ordering rather than
 *  appending, so a message received twice (once buffered server-side,
 *  once from a stale local copy) can never show up twice. A no-op when
 *  there's no active review yet. */
async function rehydrateActiveReview() {
  if (!activeReviewId) return;
  const reviewId = activeReviewId;
  const token = ++selectionToken;
  try {
    const res = await fetch(`${AGENT_HTTP_BASE}/review/${encodeURIComponent(reviewId)}`);
    if (!res.ok || token !== selectionToken || reviewId !== activeReviewId) return;
    const data = await res.json();
    const cache = { result: data.result, messages: data.messages ?? [], policyFindings: data.policyFindings ?? [] };
    reviewCache.set(reviewId, cache);
    el.chatLog.innerHTML = "";
    el.chatEmpty.hidden = cache.messages.length > 0;
    if (cache.messages.length === 0) el.chatLog.appendChild(el.chatEmpty);
    for (const m of cache.messages) appendChatBubble(m);
  } catch {
    // Reconnect will retry on its own timer; nothing to surface here.
  } finally {
    if (ws && wsReady && reviewId === activeReviewId) {
      ws.send(JSON.stringify({ type: "set_active", reviewId }));
    }
  }
}

async function submitPlan(planText, label) {
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    el.submitStatus.textContent = "Not valid JSON.";
    return;
  }
  el.submitBtn.disabled = true;
  el.submitStatus.textContent = "Analyzing…";
  try {
    const res = await fetch(`${AGENT_HTTP_BASE}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan, idempotencyKey: crypto.randomUUID(), label }),
    });
    const data = await res.json();
    if (!res.ok) {
      el.submitStatus.textContent = data.error ?? `Request failed (${res.status}).`;
      return;
    }
    el.submitStatus.textContent = "Done.";
    reviewCache.set(data.reviewId, { result: data.result, messages: [], policyFindings: data.policyFindings ?? [] });
    await selectReview(data.reviewId);
  } catch (err) {
    el.submitStatus.textContent = `Network error: ${err.message}`;
  } finally {
    el.submitBtn.disabled = false;
  }
}

el.submitBtn.addEventListener("click", () => {
  submitPlan(el.planInput.value, "Uploaded plan");
});

el.fileInput.addEventListener("change", async () => {
  const file = el.fileInput.files?.[0];
  if (!file) return;
  el.planInput.value = await file.text();
});

document.querySelectorAll("button[data-sample]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const name = btn.getAttribute("data-sample");
    const res = await fetch(`/samples/${name}.json`);
    const text = await res.text();
    el.planInput.value = text;
    await submitPlan(text, btn.textContent);
  });
});

// --- Policies ---

let pendingProposal = null;

el.policyProposeBtn = document.getElementById("policyProposeBtn");
el.policyInput = document.getElementById("policyInput");
el.policyProposal = document.getElementById("policyProposal");
el.policyList = document.getElementById("policyList");

async function loadPolicies() {
  const res = await fetch(`${AGENT_HTTP_BASE}/policies`);
  if (!res.ok) return;
  const data = await res.json();
  el.policyList.innerHTML = data.policies.length === 0
    ? `<div class="status">No saved policies yet.</div>`
    : data.policies.map((p) => `
        <div class="resource">
          <div>"${escapeHtml(p.sentence)}"</div>
          <div class="evidence">${escapeHtml(JSON.stringify(p.rule))}</div>
          <button data-delete-policy="${p.id}" style="margin-top:6px;">Delete</button>
        </div>
      `).join("");
  el.policyList.querySelectorAll("[data-delete-policy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`${AGENT_HTTP_BASE}/policies/${btn.getAttribute("data-delete-policy")}`, { method: "DELETE" });
      loadPolicies();
    });
  });
}

el.policyProposeBtn.addEventListener("click", async () => {
  const sentence = el.policyInput.value.trim();
  if (!sentence) return;
  el.policyProposal.innerHTML = `<div class="status">Compiling…</div>`;
  const res = await fetch(`${AGENT_HTTP_BASE}/policy/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sentence, reviewId: activeReviewId }),
  });
  const data = await res.json();
  if (!data.ok) {
    el.policyProposal.innerHTML = `<div class="finding" style="border-color:var(--high)">Refused: ${escapeHtml(data.reason ?? "unknown error")}</div>`;
    pendingProposal = null;
    return;
  }
  pendingProposal = data;
  const matchCount = data.dryRun.filter((d) => d.result === "match").length;
  const unknownCount = data.dryRun.filter((d) => d.result === "unknown").length;
  el.policyProposal.innerHTML = `
    <div class="resource">
      <div class="evidence">${escapeHtml(JSON.stringify(data.rule))}</div>
      <div style="margin-top:6px;">Against the selected review: ${matchCount} match, ${unknownCount} unknown.</div>
      <button id="policyConfirmBtn" class="primary" style="margin-top:8px;">Confirm and save</button>
    </div>`;
  document.getElementById("policyConfirmBtn").addEventListener("click", async () => {
    if (!pendingProposal) return;
    const confirmRes = await fetch(`${AGENT_HTTP_BASE}/policy/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: pendingProposal.proposalId }),
    });
    if (!confirmRes.ok) {
      const err = await confirmRes.json().catch(() => ({}));
      el.policyProposal.innerHTML = `<div class="finding" style="border-color:var(--high)">Not saved: ${escapeHtml(err.error ?? `HTTP ${confirmRes.status}`)}</div>`;
      pendingProposal = null;
      return;
    }
    el.policyProposal.innerHTML = `<div class="status">Saved. Applies to reviews submitted from now on.</div>`;
    el.policyInput.value = "";
    pendingProposal = null;
    loadPolicies();
  });
});

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text || !activeReviewId || !ws || !wsReady) return;
  // R3 (adversarial review): this used to append the user's bubble
  // optimistically AND render it again when the server broadcast the
  // persisted message back — every question the user asked showed up
  // twice. The server is the source of truth for message ordering and
  // ids; `handleServerMessage` renders the bubble once that broadcast
  // arrives, which for a live connection is near-instant.
  ws.send(JSON.stringify({ type: "chat", reviewId: activeReviewId, text }));
  el.chatInput.value = "";
});

// R2 fix (adversarial review): the WebSocket connection, /reviews fetch,
// and /policies fetch used to fire independently and in parallel on page
// load. Each request that arrives at the origin with no cookie yet gets a
// FRESH random workspace id from the server (see worker.ts) — so three
// parallel cookie-less requests could split one browser session across
// three different Durable Object instances. Fixed by awaiting one bootstrap
// request first (which the browser's Set-Cookie response completes before
// this function returns), and only then opening the socket and loading
// workspace data — guaranteeing every subsequent request already carries
// the same cookie.
async function bootstrapAndStart() {
  try {
    await fetch("/api/bootstrap", { credentials: "same-origin" });
  } catch {
    // Even if this fails, proceed — worst case is the pre-fix race,
    // not a hard failure to load the page.
  }
  connectWebSocket();
  await Promise.all([hydrateWorkspace().catch(() => { el.status.textContent = "no reviews yet"; }), loadPolicies().catch(() => {})]);
}

bootstrapAndStart();
