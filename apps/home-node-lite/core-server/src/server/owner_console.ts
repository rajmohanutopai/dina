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
    return (
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        // The page is same-origin only; never let it be framed by another site.
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header(
          'content-security-policy',
          "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        )
        .code(200)
        .send(html)
    );
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
  input, button, select, textarea { font: inherit; padding: .4rem .6rem; border-radius: 6px; border: 1px solid #8888; background: transparent; color: inherit; }
  textarea { width: min(100%, 46rem); min-height: 5rem; box-sizing: border-box; overflow-wrap: anywhere; }
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
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: .5rem 0 0; font: .85rem ui-monospace, monospace; }
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
  <h2>Agent setup</h2>
  <p class="muted">Create a five-minute, single-use code for a coding agent. The agent receives its own revocable key and never receives your vault keys.</p>
  <div class="bar">
    <button id="pairCoding" class="primary">Pair coding agent</button>
    <button id="copyCoding" class="hidden">Copy setup code</button>
    <span id="codingExpiry" class="muted"></span>
  </div>
  <textarea id="codingCode" class="hidden" readonly spellcheck="false"></textarea>
  <div id="codingAgents" class="muted">Not checked.</div>
  <p class="muted">Your selected supervision level applies only while you are
  directly using this agent. Requests from contacts, services, delegated work,
  background jobs, and unknown sources always use Full supervision.</p>

  <h2>Approval phone</h2>
  <p class="muted">Paste a setup code generated by the Dina mobile app. Only this owner page can replace or revoke the phone that decides HIGH-risk coding actions.</p>
  <div class="bar">
    <input id="phoneCode" type="password" placeholder="dina1:…" autocomplete="off" size="48" />
    <button id="pairPhone" class="primary">Pair phone</button>
    <button id="revokePhone" class="danger">Revoke phone</button>
  </div>
  <div id="phoneStatus" class="muted">Not checked.</div>
</section>

<section>
  <h2>Connected Brain work <span id="reasoningCount" class="muted"></span></h2>
  <p class="muted">Durable reasoning delegated by Core. The connected agent receives only a time-limited context projection; Core validates and commits every result.</p>
  <div class="bar">
    <button id="refreshReasoning">Refresh</button>
  </div>
  <div id="reasoningJobs"></div>
</section>

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
  <div class="bar">
    <button id="refreshWatches">Refresh</button>
    <button id="toggleWatch">New subscription</button>
  </div>
  <form class="start hidden" id="watchForm">
    <label>Provider DID</label><input id="w_provider" placeholder="did:plc:…" />
    <label>Service URI</label><input id="w_service" placeholder="at://…" />
    <label>Capability</label><input id="w_capability" value="eta_query" />
    <label>Persona</label><input id="w_persona" value="general" />
    <label>Poll every (sec)</label><input id="w_interval" value="60" inputmode="numeric" />
    <label>Freshness (sec, optional)</label><input id="w_freshness" placeholder="provider defaultTtlSeconds — floors the poll interval" inputmode="numeric" />
    <label>Query (JSON, optional)</label><input id="w_query" placeholder='{"route_id":"42"}' />
    <label>Schema hash (optional)</label><input id="w_schema" placeholder="from discovery — required if the provider publishes a schema" />
    <span></span><button type="submit" class="primary">Create</button>
  </form>
  <div id="watchlist"></div>
</section>

<script>
"use strict";
(function () {
  var KEY = "dina.owner_capability";
  var currentCodingAgents = [];
  var agentPolicies = {};
  var staleAgentPolicies = {};
  var reasoningBackends = {};
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

  // ── Setup ───────────────────────────────────────────────────────────
  function loadSetup() {
    api("GET", "/v1/owner/setup/status").then(function (data) {
      var phone = data && data.phone ? data.phone : {};
      var status = phone.state === "active"
        ? "Paired to " + String(phone.phoneDid || "phone")
        : phone.state === "revoking"
          ? "Disabled locally; remote revocation will retry when the phone is reachable."
          : "No approval phone paired.";
      document.getElementById("phoneStatus").textContent = status;
      document.getElementById("revokePhone").disabled = phone.state === "unpaired";
      document.getElementById("pairPhone").disabled = phone.state !== "unpaired";
      document.getElementById("phoneCode").disabled = phone.state !== "unpaired";
      document.getElementById("pairCoding").disabled = !data.coding_agent_pairing_available;
      currentCodingAgents = Array.isArray(data.coding_agents) ? data.coding_agents : [];
      loadAgentControls();
    }).catch(function (e) {
      document.getElementById("phoneStatus").textContent = String(e.message);
    });
  }
  function loadAgentControls() {
    Promise.all([
      api("GET", "/v1/owner/agent-policies"),
      api("GET", "/v1/reasoning/backends"),
    ]).then(function (rows) {
      agentPolicies = {};
      ((rows[0] && rows[0].policies) || []).forEach(function (p) {
        if (p && p.agent_did) agentPolicies[String(p.agent_did)] = p;
      });
      staleAgentPolicies = {};
      ((rows[0] && rows[0].stale_policies) || []).forEach(function (p) {
        if (p && p.agent_did) staleAgentPolicies[String(p.agent_did)] = p;
      });
      reasoningBackends = {};
      ((rows[1] && rows[1].backends) || []).forEach(function (b) {
        if (!b || !b.principal_did) return;
        var did = String(b.principal_did);
        if (!reasoningBackends[did]) reasoningBackends[did] = [];
        reasoningBackends[did].push(b);
      });
      renderCodingAgents(currentCodingAgents);
    }).catch(function (e) {
      var host = document.getElementById("codingAgents");
      host.textContent = "Could not load agent controls: " + String(e.message);
    });
  }
  function renderCodingAgents(agents) {
    var host = document.getElementById("codingAgents");
    clear(host);
    if (!agents.length) {
      host.textContent = "No coding agents paired.";
      return;
    }
    agents.forEach(function (agent) {
      var did = String(agent.did || "");
      var policy = agentPolicies[did] || null;
      var stalePolicy = staleAgentPolicies[did] || null;
      var profile = policy && !policy.revoked_at ? String(policy.profile) : "full_supervision";
      var backends = reasoningBackends[did] || [];
      var activeBrain = backends.find(function (b) {
        return b.kind === "connected_host" && b.enabled && !b.revoked_at;
      }) || null;
      var card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "row" }, [
        el("strong", { text: String(agent.name || "Coding agent") }),
        el("code", { text: did }),
      ]));
      var select = el("select", { "aria-label": "Supervision level" });
      [
        ["network_protection", "Network protection"],
        ["sensitive_boundaries", "Sensitive boundaries"],
        ["full_supervision", "Full supervision"],
      ].forEach(function (entry) {
        var option = el("option", { value: entry[0], text: entry[1] });
        if (entry[0] === profile) option.selected = true;
        select.appendChild(option);
      });
      var save = btn("Save supervision", "", function () {
        api("PUT", "/v1/owner/agent-policies/" + encodeURIComponent(did), {
          profile: select.value,
          expected_version: policy
            ? policy.policy_version
            : stalePolicy
              ? stalePolicy.policy_version
              : null,
        }).then(loadAgentControls).catch(function (e) { alert(e.message); });
      });
      card.appendChild(el("div", { class: "row" }, [select, save]));
      if (stalePolicy) {
        card.appendChild(el("p", {
          class: "muted",
          text: "This Home Node's identity changed. Full supervision is active until you confirm a supervision level again.",
        }));
      }
      card.appendChild(el("p", {
        class: "muted",
        text: profileDescription(profile),
      }));
      var brain = btn(
        activeBrain ? "Stop using this agent as Brain" : "Use this agent as Brain",
        activeBrain ? "danger" : "primary",
        function () { toggleBrain(agent, backends, activeBrain); },
      );
      card.appendChild(el("div", { class: "row" }, [
        brain,
        el("span", {
          class: "muted",
          text: activeBrain
            ? "Foreground only. Core keeps identity, context policy, approvals, state, and effects."
            : "Lets this active Claude/Codex session perform bounded reasoning without another AI key.",
        }),
      ]));
      var revoke = el("button", { class: "danger", text: "Revoke" });
      revoke.addEventListener("click", function () {
        if (!confirm("Revoke " + String(agent.name || "this coding agent") + "?")) return;
        api(
          "DELETE",
          "/v1/owner/setup/coding-agent/" + encodeURIComponent(String(agent.device_id || "")),
          {},
        ).then(loadSetup).catch(function (e) { alert(e.message); });
      });
      card.appendChild(revoke);
      host.appendChild(card);
    });
  }
  function profileDescription(profile) {
    if (profile === "network_protection") {
      return "Dina protects its own keys, vaults, sessions, and authority. Your agent and its host handle ordinary coding.";
    }
    if (profile === "sensitive_boundaries") {
      return "Dina also checks protected data, external sends, destructive operations, package changes, and system changes.";
    }
    return "Dina applies its full classifier and approval policy to every supported tool call.";
  }
  function toggleBrain(agent, backends, activeBrain) {
    var did = String(agent.did || "");
    if (activeBrain) {
      var active = backends.filter(function (b) {
        return b.kind === "connected_host" && b.enabled && !b.revoked_at;
      });
      Promise.all(active.map(function (b) {
        return api(
          "POST",
          "/v1/reasoning/backends/" + encodeURIComponent(String(b.backend_id)) + "/revoke",
          { expected_version: b.policy_version },
        );
      })).then(loadAgentControls).catch(function (e) { alert(e.message); });
      return;
    }
    var stableId = "connected." + String(agent.device_id || "").replace(/[^A-Za-z0-9._:-]/g, "");
    var existing = backends.find(function (b) { return String(b.backend_id) === stableId; }) || null;
    api("POST", "/v1/reasoning/backends/register", {
      backend_id: stableId,
      kind: "connected_host",
      principal_did: did,
      allowed_task_kinds: [
        "answer.compose",
        "memory.structure",
        "intent.route",
        "service.respond",
        "review.summarize",
        "reminder.extract",
      ],
      max_sensitivity: "sensitive",
      availability: "foreground",
      model_class: "connected-host",
      expires_at: null,
      expected_version: existing ? existing.policy_version : null,
    }).then(loadAgentControls).catch(function (e) { alert(e.message); });
  }
  function createCodingSetup() {
    api("POST", "/v1/owner/setup/coding-agent", {}).then(function (data) {
      var code = document.getElementById("codingCode");
      code.value = String(data.setup_code || "");
      code.classList.remove("hidden");
      document.getElementById("copyCoding").classList.remove("hidden");
      document.getElementById("codingExpiry").textContent =
        "Expires " + new Date(Number(data.expires_at) * 1000).toLocaleTimeString();
    }).catch(function (e) { alert(e.message); });
  }
  function copyCodingSetup() {
    var code = document.getElementById("codingCode").value;
    if (!code) return;
    navigator.clipboard.writeText(code).then(function () {
      document.getElementById("copyCoding").textContent = "Copied";
    }).catch(function () { alert("Could not access the clipboard. Select and copy the code."); });
  }
  function pairPhone() {
    var field = document.getElementById("phoneCode");
    var setupCode = field.value.trim();
    if (!setupCode) { alert("Paste the setup code from the Dina mobile app."); return; }
    api("POST", "/v1/owner/setup/phone", { setup_code: setupCode }).then(function () {
      field.value = "";
      loadSetup();
    }).catch(function (e) { alert(e.message); });
  }
  function revokePhone() {
    if (!confirm("Revoke the approval phone? HIGH-risk coding actions will remain blocked until another phone is paired.")) return;
    api("DELETE", "/v1/owner/setup/phone", {}).then(loadSetup).catch(function (e) { alert(e.message); });
  }

  // ── Connected Brain work ─────────────────────────────────────────────
  function loadReasoningJobs() {
    var list = document.getElementById("reasoningJobs");
    api("GET", "/v1/owner/reasoning/jobs?limit=50").then(function (data) {
      clear(list);
      var jobs = (data && data.jobs) || [];
      var active = jobs.filter(function (job) { return !reasoningTerminal(job); }).length;
      document.getElementById("reasoningCount").textContent =
        active > 0 ? "· " + active + " pending" : "";
      if (jobs.length === 0) {
        list.appendChild(el("p", { class: "muted", text: "No connected Brain work." }));
        return;
      }
      jobs.forEach(function (job) { list.appendChild(renderReasoningJob(job)); });
    }).catch(function (e) {
      document.getElementById("reasoningCount").textContent = "";
      clear(list);
      list.appendChild(el("p", { class: "muted", text: String(e.message) }));
    });
  }
  function reasoningTerminal(job) {
    return job.state === "failed" ||
      job.state === "cancelled" ||
      job.state === "outcome_unknown" ||
      (job.state === "completed" &&
        (job.commitState === "committed" || job.commitState === "failed"));
  }
  function reasoningStatus(job) {
    if (job.commitState === "pending_approval") return "Waiting for approval";
    if (job.commitState === "failed") return "Commit failed";
    if (job.state === "completed" && job.commitState === "committed") return "Complete";
    if (job.state === "claimed" || job.state === "running") return "Working";
    if (job.state === "cancelled") return "Cancelled";
    if (job.state === "failed" || job.state === "outcome_unknown") return "Failed";
    return "Queued";
  }
  function renderReasoningJob(job) {
    var card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "row" }, [
      el("strong", { text: String(job.taskKind || "Reasoning") }),
      el("span", { class: "muted", text: reasoningStatus(job) }),
    ]));
    card.appendChild(el("div", { text: String(job.purpose || "Reasoning request") }));
    card.appendChild(el("div", { class: "muted" }, [
      el("code", { text: String(job.taskId || "") }),
      el("span", { text: " · " + String(job.backendId || "policy-selected") }),
    ]));
    if (job.result !== undefined) {
      var answer =
        job.result && typeof job.result === "object" && typeof job.result.answer === "string"
          ? job.result.answer
          : JSON.stringify(job.result, null, 2);
      if (answer) card.appendChild(el("pre", { text: String(answer) }));
    }
    if (job.error) {
      card.appendChild(el("p", { class: "muted", text: String(job.error) }));
    }
    if (!reasoningTerminal(job)) {
      card.appendChild(btn("Cancel", "danger", function () {
        cancelReasoningJob(String(job.taskId || ""));
      }));
    }
    return card;
  }
  function cancelReasoningJob(taskId) {
    if (!taskId || !confirm("Cancel this connected Brain request?")) return;
    api(
      "POST",
      "/v1/owner/reasoning/" + encodeURIComponent(taskId) + "/cancel",
      { reason: "cancelled from owner console" },
    ).then(loadReasoningJobs).catch(function (e) { alert(e.message); });
  }

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
  function createWatch(ev) {
    ev.preventDefault();
    var interval = Math.round(Number(document.getElementById("w_interval").value));
    var queryRaw = document.getElementById("w_query").value.trim();
    var query = {};
    if (queryRaw !== "") {
      try { query = JSON.parse(queryRaw); }
      catch (e) { alert("Query must be valid JSON: " + e.message); return; }
    }
    var schemaHash = document.getElementById("w_schema").value.trim();
    var freshness = Math.round(Number(document.getElementById("w_freshness").value));
    var body = {
      subscription_id: "sub-" + nextKey(),
      provider_did: document.getElementById("w_provider").value.trim(),
      service_uri: document.getElementById("w_service").value.trim(),
      capability: document.getElementById("w_capability").value.trim(),
      persona: document.getElementById("w_persona").value.trim(),
      poll_interval_sec: interval > 0 ? interval : 60,
      query: query,
    };
    if (schemaHash !== "") body.schema_hash = schemaHash;
    if (freshness > 0) body.freshness_sec = freshness;
    api("POST", "/v1/watch/create", body).then(function () {
      document.getElementById("watchForm").classList.add("hidden");
      loadWatches();
    }).catch(function (e) { alert(e.message); });
  }

  // ── wire up ─────────────────────────────────────────────────────────
  document.getElementById("save").addEventListener("click", function () {
    setCap(document.getElementById("cap").value);
    document.getElementById("cap").value = "";
    refreshKeyState();
    loadSetup(); loadReasoningJobs(); loadRuns(); loadWatches();
  });
  document.getElementById("pairCoding").addEventListener("click", createCodingSetup);
  document.getElementById("copyCoding").addEventListener("click", copyCodingSetup);
  document.getElementById("pairPhone").addEventListener("click", pairPhone);
  document.getElementById("revokePhone").addEventListener("click", revokePhone);
  document.getElementById("refreshReasoning").addEventListener("click", loadReasoningJobs);
  document.getElementById("refreshRuns").addEventListener("click", loadRuns);
  document.getElementById("refreshWatches").addEventListener("click", loadWatches);
  document.getElementById("toggleStart").addEventListener("click", function () {
    document.getElementById("startForm").classList.toggle("hidden");
  });
  document.getElementById("startForm").addEventListener("submit", startRun);
  document.getElementById("toggleWatch").addEventListener("click", function () {
    document.getElementById("watchForm").classList.toggle("hidden");
  });
  document.getElementById("watchForm").addEventListener("submit", createWatch);
  refreshKeyState();
  if (getCap()) { loadSetup(); loadReasoningJobs(); loadRuns(); loadWatches(); }
})();
</script>
</body>
</html>`;
