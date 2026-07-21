/**
 * Round-B B-02 (the full fix) — a CORE-SERVED owner console for the §12.5
 * run/watch control plane.
 *
 * The round-A owner channel let the SPA drive runs, but the owner capability
 * transited the untrusted Brain process (it served the page and byte-piped the
 * calls). A fully-compromised Brain could skim the reusable bearer and then
 * originate owner commands itself. This closes that: CORE serves this page from
 * its OWN origin, and the page calls Core's OWN `/v1/run*` + `/v1/watch*` routes
 * SAME-ORIGIN. The capability lives only in the Core-origin page and never
 * touches Brain. The custom `x-dina-owner-capability` header also gives CSRF
 * protection for free — a cross-site page can't set a custom header without a
 * CORS preflight, and Core sends no permissive CORS headers by default, so the
 * browser blocks any other origin from calling these routes.
 *
 * Opt-in (`DINA_CORE_OWNER_CONSOLE=1`), off by default like every other served
 * UI — Core is the vault keeper, so it serves HTML only when an operator asks.
 * The page is fully self-contained (inline CSS/JS, no build step, no external
 * fetch) and builds the DOM with `textContent` only (no `innerHTML`), so a
 * provider-controlled service URI / DID can never inject markup.
 */

interface OwnerConsoleAppLike {
  get(path: string, handler: (req: unknown, reply: OwnerConsoleReplyLike) => unknown): unknown;
}

interface OwnerConsoleReplyLike {
  header(name: string, value: string): OwnerConsoleReplyLike;
  code(status: number): OwnerConsoleReplyLike;
  send(payload?: unknown): OwnerConsoleReplyLike;
}

export interface RegisterOwnerConsoleOptions {
  /** Serve the console only when true (`DINA_CORE_OWNER_CONSOLE=1`). */
  enabled: boolean;
  /** Route path (default `/owner`). */
  path?: string;
}

/** Register (when enabled) the Core-served owner console. Returns the path it
 *  bound, or null when disabled. */
export function registerOwnerConsoleRoute(
  app: OwnerConsoleAppLike,
  opts: RegisterOwnerConsoleOptions,
): string | null {
  if (!opts.enabled) return null;
  const path = opts.path ?? '/owner';
  const html = OWNER_CONSOLE_HTML;
  app.get(path, (_req, reply) => {
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      // The page is same-origin only; never let it be framed by another site.
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
      .code(200)
      .send(html);
  });
  return path;
}

// The page JS uses ordinary string concatenation (NOT template literals) so no
// `${...}` collides with this outer TS template literal, and builds every node
// with createElement + textContent (XSS-safe).
const OWNER_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dina — Owner control</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1.5rem; max-width: 900px; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.8rem; }
  .bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  input, button, select { font: inherit; padding: .4rem .6rem; border-radius: 6px; border: 1px solid #8888; background: transparent; color: inherit; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.danger { border-color: #dc2626; color: #dc2626; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: .8rem; margin: .6rem 0; }
  .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .muted { opacity: .7; font-size: .85rem; }
  .status { min-width: 8rem; }
  .decision { border-top: 1px solid #8883; margin-top: .6rem; padding-top: .6rem; }
  form.start { display: grid; grid-template-columns: max-content 1fr; gap: .5rem .8rem; align-items: center; margin: .6rem 0; }
  .hidden { display: none; }
  code { font-size: .85rem; word-break: break-all; }
</style>
</head>
<body>
<h1>Dina — Owner control</h1>
<p class="muted">Served by Core. Your owner key stays on this page and is sent only to Core — never to Brain.</p>
<div class="bar">
  <input id="cap" type="password" placeholder="owner capability" autocomplete="off" size="40" />
  <button id="save" class="primary">Save key</button>
  <span id="keystate" class="muted"></span>
</div>

<section>
  <h2>Runs</h2>
  <div class="bar">
    <button id="refreshRuns">Refresh</button>
    <button id="toggleStart">Start a run</button>
  </div>
  <form class="start hidden" id="startForm">
    <label>Provider DID</label><input id="f_provider" placeholder="did:plc:…" />
    <label>Service URI</label><input id="f_service" placeholder="at://…" />
    <label>Persona</label><input id="f_persona" value="general" />
    <label>Run for (min)</label><input id="f_ttl" value="60" inputmode="numeric" />
    <label>Grant (optional)</label><input id="f_grant" placeholder="provider grant id" />
    <span></span><button type="submit" class="primary">Start</button>
  </form>
  <div id="runlist"></div>
</section>

<section>
  <h2>Watches</h2>
  <div class="bar"><button id="refreshWatches">Refresh</button></div>
  <div id="watchlist"></div>
</section>

<script>
"use strict";
(function () {
  var KEY = "dina.owner_capability";
  function getCap() {
    var v = sessionStorage.getItem(KEY);
    return v && v.trim() !== "" ? v.trim() : null;
  }
  function setCap(v) { if (v && v.trim() !== "") sessionStorage.setItem(KEY, v.trim()); }
  function clearCap() { sessionStorage.removeItem(KEY); }
  var keySeq = 0;
  function nextKey() {
    return "web-" + Date.now().toString(36) + "-" + (++keySeq).toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function refreshKeyState() {
    var el = document.getElementById("keystate");
    el.textContent = getCap() ? "key set" : "no key";
  }
  function api(method, path, body) {
    var cap = getCap();
    var headers = { "content-type": "application/json" };
    if (cap) headers["x-dina-owner-capability"] = cap;
    var init = { method: method, headers: headers };
    if (method !== "GET") init.body = JSON.stringify(body || {});
    return fetch(path, init).then(function (res) {
      if (res.status === 403) { clearCap(); refreshKeyState(); throw new Error("403 — wrong or missing owner key"); }
      return res.text().then(function (t) {
        if (!res.ok) throw new Error(method + " " + path + " → " + res.status + " " + t.slice(0, 160));
        return t === "" ? {} : JSON.parse(t);
      });
    });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function btn(label, cls, onClick) {
    var b = el("button", { text: label, class: cls || "" });
    b.addEventListener("click", onClick);
    return b;
  }
  function rkey(uri) { var p = String(uri || "").split("/"); return p[p.length - 1] || uri; }

  // ── Runs ────────────────────────────────────────────────────────────
  function loadRuns() {
    var list = document.getElementById("runlist");
    api("GET", "/v1/run/list").then(function (data) {
      list.textContent = "";
      var runs = (data && data.runs) || [];
      if (runs.length === 0) { list.appendChild(el("p", { class: "muted", text: "No runs." })); return; }
      runs.forEach(function (r) { list.appendChild(renderRun(r)); });
    }).catch(function (e) { list.textContent = ""; list.appendChild(el("p", { class: "muted", text: String(e.message) })); });
  }
  function renderRun(r) {
    var card = el("div", { class: "card" });
    var head = el("div", { class: "row" }, [
      el("strong", { text: rkey(r.service_uri) }),
      el("span", { class: "muted", text: r.state + " · " + (r.produced_count || 0) + (r.max_count != null ? "/" + r.max_count : "") + " produced" }),
    ]);
    card.appendChild(head);
    card.appendChild(el("div", { class: "muted" }, [el("code", { text: r.run_id })]));
    if (!r.terminal) {
      var controls = el("div", { class: "row" }, [
        btn("Pause", "", function () { steer(r.run_id, "pause"); }),
        btn("Resume", "", function () { steer(r.run_id, "resume"); }),
        btn("Stop", "danger", function () { steer(r.run_id, "stop"); }),
        btn("Decisions", "", function () { toggleDecisions(r.run_id, card); }),
      ]);
      card.appendChild(controls);
    }
    return card;
  }
  function steer(runId, action) {
    api("POST", "/v1/run/" + encodeURIComponent(runId) + "/" + action, { idempotency_key: nextKey() })
      .then(loadRuns).catch(function (e) { alert(e.message); });
  }
  function toggleDecisions(runId, card) {
    var existing = card.querySelector(".decision");
    if (existing) { existing.remove(); return; }
    var box = el("div", { class: "decision" }, [el("span", { class: "muted", text: "loading…" })]);
    card.appendChild(box);
    api("GET", "/v1/run/" + encodeURIComponent(runId) + "/status").then(function (s) {
      box.textContent = "";
      box.appendChild(el("div", { class: "muted", text: "fetch: " + (s.fetch_paused ? ("paused — " + (s.fetch_blocked_reason || s.paused_reason || "")) : "active") }));
      (s.pending || []).forEach(function (m) {
        var label = (m.kind === "action" ? "Action" : "Update") + " #" + m.sequence + (m.action_type ? " · " + m.action_type : "");
        var row = el("div", { class: "row" }, [el("span", { text: label })]);
        if (m.title) row.appendChild(el("span", { class: "muted", text: m.title }));
        if (m.kind === "action") {
          row.appendChild(btn("Approve", "primary", function () { decide(runId, m.message_id, "approve", m.decision_revision); }));
          row.appendChild(btn("Deny", "danger", function () { decide(runId, m.message_id, "deny", m.decision_revision); }));
        } else {
          row.appendChild(btn("Got it", "", function () { decide(runId, m.message_id, "acknowledge", m.decision_revision); }));
        }
        box.appendChild(row);
      });
      (s.pending_risk || []).forEach(function (m) {
        box.appendChild(el("div", { class: "row" }, [
          el("span", { text: "Confirm action #" + m.sequence }),
          btn("Confirm", "primary", function () { confirmRisk(runId, m.message_id); }),
        ]));
      });
      (s.lost || []).forEach(function (l) {
        box.appendChild(el("div", { class: "row" }, [
          el("span", { text: "Update #" + l.cursor + " lost" + (l.reason ? " (" + l.reason + ")" : "") }),
          btn("Skip", "", function () { skipLost(runId, l.reservation_id); }),
        ]));
      });
      if ((s.pending || []).length + (s.pending_risk || []).length + (s.lost || []).length === 0) {
        box.appendChild(el("span", { class: "muted", text: "Nothing to decide." }));
      }
    }).catch(function (e) { box.textContent = ""; box.appendChild(el("span", { class: "muted", text: e.message })); });
  }
  function decide(runId, messageId, decision, rev) {
    api("POST", "/v1/run/" + encodeURIComponent(runId) + "/decide", { message_id: messageId, decision: decision, decision_revision: rev || 0, idempotency_key: nextKey() })
      .then(loadRuns).catch(function (e) { alert(e.message); });
  }
  function confirmRisk(runId, messageId) {
    api("POST", "/v1/run/" + encodeURIComponent(runId) + "/confirm-risk", { message_id: messageId, idempotency_key: nextKey() })
      .then(loadRuns).catch(function (e) { alert(e.message); });
  }
  function skipLost(runId, reservationId) {
    api("POST", "/v1/run/" + encodeURIComponent(runId) + "/skip-lost", { reservation_id: reservationId, idempotency_key: nextKey() })
      .then(loadRuns).catch(function (e) { alert(e.message); });
  }
  function startRun(ev) {
    ev.preventDefault();
    var ttl = Math.round(Number(document.getElementById("f_ttl").value) * 60);
    var grant = document.getElementById("f_grant").value.trim();
    var body = {
      provider_did: document.getElementById("f_provider").value.trim(),
      service_uri: document.getElementById("f_service").value.trim(),
      persona: document.getElementById("f_persona").value.trim(),
      ttl_seconds: ttl > 0 ? ttl : 3600,
      idempotency_key: nextKey(),
    };
    if (grant !== "") body.provider_grant_id = grant;
    api("POST", "/v1/run/start", body).then(function () {
      document.getElementById("startForm").classList.add("hidden");
      loadRuns();
    }).catch(function (e) { alert(e.message); });
  }

  // ── Watches ─────────────────────────────────────────────────────────
  function loadWatches() {
    var list = document.getElementById("watchlist");
    api("GET", "/v1/watch/list").then(function (data) {
      list.textContent = "";
      var ws = (data && data.watches) || [];
      if (ws.length === 0) { list.appendChild(el("p", { class: "muted", text: "No watches." })); return; }
      ws.forEach(function (w) { list.appendChild(renderWatch(w)); });
    }).catch(function (e) { list.textContent = ""; list.appendChild(el("p", { class: "muted", text: String(e.message) })); });
  }
  function renderWatch(w) {
    var card = el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("strong", { text: w.capability }), el("span", { class: "muted", text: w.status })]),
      el("div", { class: "muted" }, [el("code", { text: w.watch_id })]),
    ]);
    var controls = el("div", { class: "row" }, [
      btn("Pause", "", function () { watchSteer(w.watch_id, "pause"); }),
      btn("Resume", "", function () { watchSteer(w.watch_id, "resume"); }),
      btn("Cancel", "danger", function () { watchSteer(w.watch_id, "cancel"); }),
    ]);
    card.appendChild(controls);
    return card;
  }
  function watchSteer(watchId, action) {
    api("POST", "/v1/watch/" + encodeURIComponent(watchId) + "/" + action, {})
      .then(loadWatches).catch(function (e) { alert(e.message); });
  }

  // ── wire up ─────────────────────────────────────────────────────────
  document.getElementById("save").addEventListener("click", function () {
    setCap(document.getElementById("cap").value);
    document.getElementById("cap").value = "";
    refreshKeyState();
    loadRuns(); loadWatches();
  });
  document.getElementById("refreshRuns").addEventListener("click", loadRuns);
  document.getElementById("refreshWatches").addEventListener("click", loadWatches);
  document.getElementById("toggleStart").addEventListener("click", function () {
    document.getElementById("startForm").classList.toggle("hidden");
  });
  document.getElementById("startForm").addEventListener("submit", startRun);
  refreshKeyState();
  if (getCap()) { loadRuns(); loadWatches(); }
})();
</script>
</body>
</html>`;
