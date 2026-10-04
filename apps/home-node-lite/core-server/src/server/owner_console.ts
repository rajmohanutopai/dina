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

  <h2>Staff devices</h2>
  <p class="muted">Name a till, a clerk's phone or a connector, then give it the five-minute, single-use setup code. The device gets its own revocable key and no authority until you grant it a scope. Cards it raises show the name you give here.</p>
  <div class="bar">
    <input id="staffName" type="text" maxlength="64" placeholder="Device name, e.g. Jiffy till connector" aria-label="Staff device name">
    <button id="pairStaff" class="primary">Create staff setup code</button>
    <button id="copyStaff" class="hidden">Copy setup code</button>
    <span id="staffExpiry" class="muted"></span>
  </div>
  <textarea id="staffCode" class="hidden" readonly spellcheck="false"></textarea>
  <div id="staffDevices" class="muted">Not checked.</div>

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

<section>
  <h2>Approvals <span id="approvalCount" class="muted"></span></h2>
  <p class="muted">Cards only you may decide: a buyer asking below your automatic price limit, a tender ready to award, a clerk over their limit, a message to a remote agent.</p>
  <div class="bar"><button id="refreshApprovals">Refresh</button></div>
  <div id="approvals" class="muted">Not checked.</div>
</section>

<section>
  <h2>Remote agents</h2>
  <p class="muted">Outside agents (A2A) Dina may ask for help. Dina sends nothing to them until you approve the exact message on an Approvals card.</p>
  <form id="a2aRegister" class="row">
    <input id="a2aCardUrl" placeholder="https://agent.example/.well-known/agent-card.json" size="52" />
    <button class="primary" type="submit">Register</button>
  </form>
  <div class="bar"><button id="refreshA2A">Refresh</button></div>
  <div id="a2aAgents" class="muted">Not checked.</div>
  <h3>Requests to remote agents</h3>
  <div id="a2aOps" class="muted">Not checked.</div>
</section>

<section>
  <h2>Agent directory</h2>
  <p class="muted">Lists this node's public A2A card in the PeerLens agent directory, where other agents can find it. A listing grants nothing: every call still needs a client token you issue.</p>
  <div class="bar"><button id="refreshDirectory">Refresh</button></div>
  <div id="a2aDirectory" class="muted">Not checked.</div>
</section>

<section>
  <h2>Pack updates</h2>
  <p class="muted">Dina's own commerce and country packs update in place with the build. Orders already open stay with the pack.</p>
  <div class="bar"><button id="refreshPacks">Refresh</button></div>
  <div id="packs" class="muted">Not checked.</div>
</section>

<section>
  <h2>Tenders</h2>
  <div class="bar"><button id="refreshTenders">Refresh</button></div>
  <div id="tenders" class="muted">Not checked.</div>
  <div id="tenderDetail"></div>
</section>

<div id="presenceBox" class="card hidden">
  <div class="row">
    <input id="presencePass" type="password" placeholder="owner passphrase" autocomplete="off" size="30" />
    <button id="presenceConfirm" class="primary">Confirm it is you</button>
    <button id="presenceCancel">Cancel</button>
  </div>
  <div id="presenceNote" class="muted">This needs a person present.</div>
</div>

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
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
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
      renderStaffDevices(Array.isArray(data.staff_devices) ? data.staff_devices : []);
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
        ["network_protection", "Standard"],
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
      return "Dina provides identity, private context, services, and connections. Your agent handles ordinary local work; requests from others remain fully supervised.";
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
  function renderStaffDevices(devices) {
    var host = document.getElementById("staffDevices");
    clear(host);
    if (!devices.length) {
      host.textContent = "No staff devices paired.";
      return;
    }
    devices.forEach(function (device) {
      var card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "row" }, [
        el("strong", { text: String(device.name || "Staff device") }),
        el("code", { text: String(device.did || "") }),
      ]));
      var revoke = el("button", { class: "danger", text: "Revoke" });
      revoke.addEventListener("click", function () {
        if (!confirm("Revoke " + String(device.name || "this staff device") + "? Its grants end with it.")) return;
        api(
          "DELETE",
          "/v1/owner/setup/staff/" + encodeURIComponent(String(device.device_id || "")),
          {},
        ).then(loadSetup).catch(function (e) { alert(e.message); });
      });
      card.appendChild(revoke);
      host.appendChild(card);
    });
  }
  function createStaffSetup() {
    var name = document.getElementById("staffName").value.trim();
    if (!name) { alert("Name the device first."); return; }
    api("POST", "/v1/owner/setup/staff", { device_name: name }).then(function (data) {
      var code = document.getElementById("staffCode");
      code.value = String(data.setup_code || "");
      code.classList.remove("hidden");
      document.getElementById("copyStaff").classList.remove("hidden");
      document.getElementById("copyStaff").textContent = "Copy setup code";
      document.getElementById("staffExpiry").textContent =
        "Expires " + new Date(Number(data.expires_at) * 1000).toLocaleTimeString();
    }).catch(function (e) { alert(e.message); });
  }
  function copyStaffSetup() {
    var code = document.getElementById("staffCode").value;
    if (!code) return;
    navigator.clipboard.writeText(code).then(function () {
      document.getElementById("copyStaff").textContent = "Copied";
    }).catch(function () { alert("Could not access the clipboard. Select and copy the code."); });
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

  // ── Owner cards and tenders (NEGOTIATION_PLAN §4.3, §4.5, §4.7) ─────
  // A call that reports Core's own answer and never drops the key: an award
  // answers 403 no_user_presence when a proof is due, and that is not a
  // wrong key.
  function call(method, path, body) {
    var cap = getCap();
    var headers = { "content-type": "application/json" };
    if (cap) headers["x-dina-owner-capability"] = cap;
    var init = { method: method, headers: headers };
    if (method !== "GET") init.body = JSON.stringify(body || {});
    return fetch(path, init).then(function (res) {
      return res.text().then(function (t) {
        var parsed = {};
        try { parsed = t === "" ? {} : JSON.parse(t); } catch (e) { parsed = { error: t.slice(0, 120) }; }
        return { status: res.status, body: parsed };
      });
    });
  }
  function money(minor, currency) {
    var m = String(minor || "");
    var digits = "0123456789";
    for (var i = 0; i < m.length; i++) if (digits.indexOf(m.charAt(i)) < 0) return m;
    while (m.length < 3) m = "0" + m;
    var amount = m.slice(0, -2) + "." + m.slice(-2);
    return currency ? currency + " " + amount : amount;
  }
  function refusal(key) {
    var words = {
      counter_in_flight: "Dina is still waiting for this supplier to answer a counter-offer. Try again in a few minutes.",
      tender_closed: "This tender has already been awarded or closed.",
      tender_moved: "The tender changed while awarding. Refresh and try again.",
      no_awardable_offer: "No offer can be awarded: every quote is missing, expired or over budget.",
      quote_expired: "That quote has expired.",
      approval_expired: "The held order has lapsed. Award again to hold a fresh one.",
      approval_already_used: "This order has already been sent.",
      buyer_sender_unavailable: "Dina cannot send orders right now. Try again shortly."
    };
    return words[key] || ("Dina could not do that (" + String(key || "error") + ").");
  }
  var pendingRetry = null;
  function needPresence(retry) {
    pendingRetry = retry;
    document.getElementById("presenceNote").textContent = "This needs a person present.";
    document.getElementById("presenceBox").classList.remove("hidden");
    document.getElementById("presencePass").focus();
  }
  function confirmPresence() {
    var pass = document.getElementById("presencePass").value;
    call("POST", "/v1/commerce/catalog/drafts/presence", { passphrase: pass }).then(function (r) {
      document.getElementById("presencePass").value = "";
      if (r.status !== 200) {
        document.getElementById("presenceNote").textContent = "That passphrase did not verify.";
        return;
      }
      document.getElementById("presenceBox").classList.add("hidden");
      var retry = pendingRetry; pendingRetry = null;
      if (retry) retry();
    });
  }
  function payloadOf(task) {
    try { return JSON.parse(task.payload || "{}"); } catch (e) { return {}; }
  }
  function decide(task, verb, body) {
    call("POST", "/v1/workflow/tasks/" + encodeURIComponent(task.id) + "/" + verb, body || {}).then(function (r) {
      if (r.status !== 200) alert(refusal(r.body && r.body.error));
      loadApprovals();
    });
  }
  function approvalCard(task) {
    var p = payloadOf(task);
    var card = el("div", { class: "card", "data-task": task.id });
    var yes = "Approve", no = "Deny";
    if (p.type === "negotiation_price_approval") {
      card.appendChild(el("strong", { text: "A buyer asks for a lower price" }));
      card.appendChild(el("div", { class: "muted", text: "Buyer " + String(p.buyer_did || "") + " · quote " + String(p.quote_id || "") }));
      (Array.isArray(p.lines) ? p.lines : []).forEach(function (line) {
        card.appendChild(el("div", { text: String(line.line_id || "") + ": asks " + money(line.asked_minor_units, p.currency) +
          " (now " + money(line.signed_minor_units, p.currency) + ", first quoted " + money(line.quoted_minor_units, p.currency) + ")" }));
      });
      yes = "Offer it"; no = "Keep my price";
    } else if (p.type === "tender_ready") {
      card.appendChild(el("strong", { text: "Your tender is ready to award" }));
      card.appendChild(el("div", { class: "muted", text: String(p.offers || 0) + " offer(s) within budget" +
        (p.best_total_minor ? ", best " + money(p.best_total_minor, p.currency) : "") }));
      var tid = String(p.tender_id || "");
      card.appendChild(el("div", { class: "row" }, [btn("Open tender", "primary", function () { openTender(tid); })]));
      yes = "Dismiss"; no = null;
    } else if (p.type === "commerce_staff_escalation") {
      card.appendChild(el("strong", { text: "A clerk is over their limit" }));
      card.appendChild(el("div", { text: "Device " + String(p.device_did || "") + " · " +
        (p.value ? money(p.value.minor_units, p.value.currency) : "") }));
      card.appendChild(el("div", { class: "muted", text: String(p.reason || "") }));
    } else if (p.type === "a2a_delegation_consent") {
      a2aConsentCard(card, p);
      yes = "Send it"; no = "Don't send";
    } else if (p.type === "a2a_inbound_review") {
      var rd = p.display || {};
      card.appendChild(el("strong", { text: String(rd.title || "An outside agent asks to use one of your services") }));
      card.appendChild(el("pre", { text: String(rd.detail || "") }));
      yes = "Allow"; no = "Refuse";
    } else {
      card.appendChild(el("strong", { text: String(task.description || "Approval") }));
    }
    var row = el("div", { class: "row decision" });
    row.appendChild(btn(yes, "primary", function () { decide(task, "approve"); }));
    if (no) row.appendChild(btn(no, "danger", function () { decide(task, "cancel", { reason: "denied by the owner" }); }));
    card.appendChild(row);
    return card;
  }
  function loadApprovals() {
    var box = document.getElementById("approvals");
    call("GET", "/v1/workflow/tasks?kind=approval&state=pending_approval").then(function (r) {
      box.textContent = "";
      box.className = "";
      if (r.status !== 200) { box.className = "muted"; box.textContent = refusal(r.body && r.body.error); return; }
      var tasks = Array.isArray(r.body.tasks) ? r.body.tasks : [];
      document.getElementById("approvalCount").textContent = tasks.length ? "(" + tasks.length + ")" : "";
      if (tasks.length === 0) { box.className = "muted"; box.textContent = "Nothing waiting for you."; return; }
      tasks.forEach(function (t) { box.appendChild(approvalCard(t)); });
    });
  }
  function loadTenders() {
    var box = document.getElementById("tenders");
    call("GET", "/v1/commerce/trade/inbox").then(function (r) {
      box.textContent = "";
      box.className = "";
      if (r.status !== 200) { box.className = "muted"; box.textContent = refusal(r.body && r.body.error); return; }
      var open = (Array.isArray(r.body.items) ? r.body.items : []).filter(function (i) { return i.kind === "open_tender" || i.kind === "awarded_tender"; });
      if (open.length === 0) { box.className = "muted"; box.textContent = "No open tenders."; return; }
      open.forEach(function (item) {
        var id = String(item.subject);
        var parts = [el("code", { text: id })];
        if (item.kind === "awarded_tender") parts.push(el("span", { class: "muted", text: "Awarded — order to send" }));
        parts.push(btn("Open", "", function () { openTender(id); }));
        box.appendChild(el("div", { class: "row" }, parts));
      });
    });
  }
  var stateWords = {
    negotiating: "Dina is asking the suppliers for better prices",
    ready: "Ready to award",
    awarded: "Awarded",
    closed: "Closed",
    no_policy: "Collecting quotes"
  };
  var excludedWords = {
    no_quote: "No quote yet", declined: "Declined to quote", expired: "Quote expired",
    currency_mismatch: "Quoted in another currency", over_budget: "Over your budget"
  };
  function openTender(id, notice, held) {
    var box = document.getElementById("tenderDetail");
    call("GET", "/v1/commerce/trade/tender/ranking?tender_id=" + encodeURIComponent(id)).then(function (r) {
      box.textContent = "";
      var card = el("div", { class: "card", id: "tender-" + id });
      if (r.status !== 200) { card.appendChild(el("div", { text: refusal(r.body && r.body.error) })); box.appendChild(card); return; }
      var v = r.body;
      card.appendChild(el("strong", { text: "Tender " + id }));
      card.appendChild(el("div", { class: "status", "data-state": v.state, text: stateWords[v.state] || v.state }));
      if (v.target_total && v.currency) {
        card.appendChild(el("div", { class: "muted", text: "Target " + money(v.target_total, v.currency) +
          (v.budget_ceiling ? " · budget " + money(v.budget_ceiling, v.currency) : "") }));
      }
      var canAward = v.state === "ready" || v.state === "negotiating" || v.state === "no_policy";
      (v.ranked || []).forEach(function (o, i) {
        var row = el("div", { class: "row decision", "data-supplier": o.supplier_did }, [
          el("span", { text: (i === 0 ? "Best offer · " : "") + o.supplier_did }),
          el("strong", { class: "total", text: money(o.total_minor, o.currency) }),
          el("span", { class: "muted", text: "valid until " + String(o.valid_until || "").slice(0, 10) +
            (o.revision && o.revision !== "1" ? " · revised " + (Number(o.revision) - 1) + "×" : "") })
        ]);
        if (canAward) row.appendChild(btn("Award", "primary", function () { award(id, o.supplier_did); }));
        if (v.state === "awarded" && v.awarded_supplier_did === o.supplier_did) row.appendChild(el("span", { class: "muted", text: "Awarded" }));
        card.appendChild(row);
      });
      (v.excluded || []).forEach(function (x) {
        card.appendChild(el("div", { class: "muted", "data-excluded": x.supplier_did, text: x.supplier_did + " — " + (excludedWords[x.reason] || x.reason) }));
      });
      var approval = held || (v.held_order === "held" ? v.approval_id : null);
      if (!held && v.held_order === "sent") card.appendChild(el("div", { class: "decision", id: "tender-sent", text: "Order sent to the supplier." }));
      if (!held && v.held_order === "lapsed") card.appendChild(el("div", { class: "decision muted", text: "The held order lapsed before it was sent." }));
      if (approval) {
        var send = el("div", { class: "decision", id: "tender-held" }, [
          el("div", { text: "Order held. Nothing has gone to the supplier yet." }),
          btn("Send order", "primary", function () { sendHeld(id, approval); })
        ]);
        card.appendChild(send);
      }
      if (notice) card.appendChild(el("div", { class: "decision", id: "tender-notice", text: notice }));
      box.appendChild(card);
    });
  }
  function award(id, supplierDid) {
    call("POST", "/v1/commerce/trade/tender/award", { tender_id: id, supplier_did: supplierDid }).then(function (r) {
      if (r.status === 403 && r.body && r.body.error === "no_user_presence") {
        needPresence(function () { award(id, supplierDid); });
        return;
      }
      if (r.status === 200) { openTender(id, "Order held. Review it, then send it to the supplier.", r.body.approval_id); return; }
      openTender(id, refusal(r.body && r.body.error));
    });
  }
  function sendHeld(id, approvalId) {
    call("POST", "/v1/commerce/orders/submit", { approval_id: approvalId }).then(function (r) {
      if (r.status === 403 && r.body && r.body.error === "no_user_presence") {
        needPresence(function () { sendHeld(id, approvalId); });
        return;
      }
      openTender(id, r.status === 200 ? String(r.body.headline || "Sent.") : refusal(r.body && r.body.error));
    });
  }

  // ── Pack updates (item 1): list, review, confirm ─────────────────────
  function loadPacks() {
    var box = document.getElementById("packs");
    call("GET", "/v1/commerce/install/updates").then(function (r) {
      clear(box);
      box.className = "";
      if (r.status !== 200) { box.className = "muted"; box.textContent = refusal(r.body && r.body.error); return; }
      var updates = Array.isArray(r.body.updates) ? r.body.updates : [];
      if (updates.length === 0) { box.className = "muted"; box.textContent = "Every pack runs the build's version."; return; }
      updates.forEach(function (u) {
        var card = el("div", { class: "card", "data-install": u.install_id });
        card.appendChild(el("strong", { text: String(u.display_name || u.plugin_id) + " " + u.from_version + " → " + u.to_version }));
        card.appendChild(el("div", { class: "row" }, [btn("Review update", "primary", function () { reviewPack(card, u); })]));
        box.appendChild(card);
      });
    });
  }
  function reviewPack(card, u) {
    call("POST", "/v1/commerce/install/update/prepare", { install_id: u.install_id }).then(function (r) {
      if (r.status !== 200 || !r.body.review) { alert(r.body && (r.body.message || r.body.error) || "Could not review this update."); return; }
      var review = r.body.review;
      var detail = el("div", { class: "decision" });
      (review.widening || []).forEach(function (w) {
        detail.appendChild(el("div", { text: "Adds: " + String(w.kind).split("_").join(" ") + " — " + w.capabilityId }));
      });
      if (review.behaviorChanged) detail.appendChild(el("div", { text: "It also changes what the pack does." }));
      detail.appendChild(el("div", { class: "row" }, [btn("Update", "primary", function () {
        call("POST", "/v1/commerce/install/update/confirm", {
          install_id: u.install_id,
          to_cid: review.toCid,
          accepted_widening: review.widening || [],
          accepted_behavior_hash: review.toBehaviorHash
        }).then(function (c) {
          if (c.status !== 200) { alert("Update refused: " + String((c.body && (c.body.message || (c.body.outcome && c.body.outcome.refusal) || c.body.error)) || c.status)); }
          loadPacks();
        });
      })]));
      card.appendChild(detail);
    });
  }

  // ── Remote agents (A2A Lane 1, docs/A2A_GATEWAY_ARCHITECTURE.md §6) ──
  // The consent card shows exactly what will leave, in full (A2A-I10): no
  // summary stands in for the message. Every string is set as text.
  function partText(part) {
    if (part && typeof part.text === "string") return part.text;
    return JSON.stringify(part && part.data, null, 2);
  }
  function a2aConsentCard(card, p) {
    var d = p.display || {};
    var c = p.consent || {};
    card.appendChild(el("strong", { text: "Send to " + String(d.agent_name || "a remote agent") + ": " + String(d.skill_name || c.skill || "") }));
    card.appendChild(el("div", { class: "muted", text: "Endpoint " + String(d.endpoint || "") + " · card " + String(d.card_url || "") }));
    card.appendChild(el("div", { class: "muted", text: "Signature: " + String(d.signature_state || "") + ". " + String(d.signature_detail || "") }));
    card.appendChild(el("div", { text: String(d.credential || "") }));
    card.appendChild(el("div", { text: String(d.effect || "") }));
    (Array.isArray(d.labels) ? d.labels : []).forEach(function (l) { card.appendChild(el("div", { class: "muted", text: String(l) })); });
    var restricted = Array.isArray(d.restricted_personas) ? d.restricted_personas : [];
    if (restricted.length) {
      card.appendChild(el("div", { class: "muted", text: "Private vaults involved: " + restricted.map(String).join(", ") }));
    }
    (Array.isArray(d.sources) ? d.sources : []).forEach(function (line) { card.appendChild(el("div", { text: String(line) })); });
    var ph = Array.isArray(d.placeholders) ? d.placeholders : [];
    if (ph.length) {
      card.appendChild(el("div", { class: "muted", text: "Replaced with placeholders: " + ph.map(function (x) { return String(x.type) + " ×" + String(x.count); }).join(", ") }));
    }
    card.appendChild(el("div", { text: "Exactly what will be sent:" }));
    var parts = c.projection && Array.isArray(c.projection.parts) ? c.projection.parts : [];
    card.appendChild(el("pre", { text: parts.map(partText).join("\\n\\n") }));
    card.appendChild(el("div", { class: "muted", text: "Consent " + String(p.consent_hash || "").slice(0, 16) + "…" }));
  }
  function a2aRefusal(r) {
    var key = r.body && r.body.error;
    var words = {
      already_registered: "That card is already registered.",
      card_url_not_https: "The card address must start with https://.",
      card_url_literal_ip: "Use a name, not a bare IP address.",
      card_no_jsonrpc_1_0_interface: "That agent offers no A2A 1.0 JSON-RPC endpoint Dina can use.",
      credential_required_by_card: "This agent asks for a credential. Set one up above.",
      secret_invalid: "That secret is empty or has characters a header cannot carry.",
      scope_not_on_card: "Choose scopes from the ones the card offers.",
      scopes_required: "Choose the scopes this credential may ask for.",
      scheme_kind_mismatch: "That kind of credential does not match the card's scheme.",
      api_key_not_in_header: "The card sends its key outside a header, which Dina does not do.",
      token_url_refused: "The card's token address is not one Dina will connect to.",
      no_bound_skill: "Allow at least one skill first.",
      publisher_unavailable: "This node has no PDS account to publish from.",
      repo_unreachable: "Dina could not reach this node's repository. Try again later.",
      lost_race: "Another change to publishing came first. Refresh and try again.",
      not_configured: "This node has no public A2A address, so it has no card to publish.",
      not_active: "Publishing is already stopped.",
      cancel_refused: "The agent refused to cancel this task. It runs on to its own end.",
      skill_not_on_card: "That skill is not on the agent's card."
    };
    return words[key] || ("Dina could not do that (" + String(key || r.status) + ").");
  }
  var A2A_CLASSES = ["read", "quote", "write", "booking", "agentic"];
  function a2aAgentCard(agent) {
    var id = String(agent.agent_id);
    var base = "/v1/owner/a2a/remote-agents/" + encodeURIComponent(id);
    var card = el("div", { class: "card" });
    card.appendChild(el("strong", { text: String(agent.name) + " — " + String(agent.status) }));
    card.appendChild(el("div", { class: "muted", text: String(agent.card_url) + " → " + String(agent.endpoint) }));
    card.appendChild(el("div", { class: "muted", text: "Signature: " + String(agent.signature_state) + ". " + String(agent.signature_detail || "") }));
    // A2A §6.1, §8.4: the directory's PeerLens evidence for the Dina node this card names. It informs; it allows nothing.
    var evidence = el("div", { class: "muted", text: "PeerLens: checking the agent directory…" });
    card.appendChild(evidence);
    call("GET", base + "/evidence").then(function (r) { evidence.textContent = a2aEvidenceText(r); });
    var creds = (Array.isArray(agent.credentials) ? agent.credentials : []).filter(function (c) { return c.status === "active"; });
    var bound = {};
    (Array.isArray(agent.bindings) ? agent.bindings : []).forEach(function (b) { bound[b.skill] = b; });
    var act = function (verb, body) {
      call("POST", base + verb, body || {}).then(function (r) {
        if (r.status >= 300) alert(a2aRefusal(r));
        loadA2A();
      });
    };
    (Array.isArray(agent.skills) ? agent.skills : []).forEach(function (skill) {
      var row = el("div", { class: "row" }, [el("span", { text: String(skill.name) + " (" + String(skill.id) + "): " + String(skill.description) })]);
      if (agent.status !== "revoked") {
        if (bound[skill.id]) {
          row.appendChild(el("span", { class: "muted", text: "allowed as " + String(bound[skill.id].action_class) }));
          row.appendChild(btn("Stop allowing", "", function () { act("/bindings/" + encodeURIComponent(skill.id) + "/revoke"); }));
        } else if (creds.length) {
          var pick = el("select", {});
          A2A_CLASSES.forEach(function (k) { pick.appendChild(el("option", { value: k, text: k })); });
          row.appendChild(pick);
          // The owner names the credential each skill uses (§5.5).
          var credPick = el("select", {});
          creds.forEach(function (c) {
            credPick.appendChild(el("option", { value: String(c.credential_ref), text: a2aCredentialLabel(c) }));
          });
          row.appendChild(credPick);
          row.appendChild(btn("Allow", "", function () {
            act("/bindings", { skill: skill.id, action_class: pick.value, credential_ref: credPick.value });
          }));
        }
      }
      card.appendChild(row);
    });
    if (agent.status !== "revoked") a2aCredentialRows(agent, creds, act).forEach(function (r) { card.appendChild(r); });
    var bar = el("div", { class: "row" });
    if (agent.status !== "revoked" && !creds.length) bar.appendChild(btn("Use without a credential", "", function () { act("/credentials", { kind: "none" }); }));
    if (agent.status === "candidate" || agent.status === "changed") bar.appendChild(btn("Activate", "primary", function () { act("/activate"); }));
    if (agent.status !== "revoked") {
      bar.appendChild(btn("Check card again", "", function () { act("/verify"); }));
      bar.appendChild(btn("Remove", "danger", function () { act("/revoke"); }));
    }
    card.appendChild(bar);
    return card;
  }
  // What the owner reads about a remote agent's PeerLens evidence: shown beside the review, never a reason to allow.
  function a2aEvidenceText(r) {
    var e = r && r.status === 200 ? r.body : null;
    if (!e || e.status === "unavailable") return "PeerLens: the agent directory is not available right now.";
    if (e.status === "not_dina") return "PeerLens: no record. This agent's card names no Dina node.";
    if (e.status === "not_listed") return "PeerLens: " + String(e.did) + " is not in the agent directory.";
    if (e.status === "other_endpoint") {
      return "PeerLens: the directory's card for " + String(e.did) + " names another endpoint, so its evidence is not this agent's.";
    }
    if (e.status === "listed") {
      var score = typeof e.trust_score === "number" ? e.trust_score.toFixed(2) : "?";
      return "PeerLens: " + String(e.recommendation) + " (trust " + score + ") for " + String(e.did) + ", listed " +
        String(e.indexed_at).slice(0, 10) + (e.stale ? "; the listing may be behind the live card" : "") +
        ". Evidence informs your review; it allows nothing.";
    }
    return "PeerLens: no record.";
  }
  // A2A §5.3: a credential for one of the schemes the card declares. Secrets
  // go in password fields, are posted once, and are never shown again.
  var A2A_SECRET_FIELDS = {
    api_key: [["value", "API key"]],
    bearer: [["token", "Bearer token"]],
    oauth2_client: [["client_id", "Client id"], ["client_secret", "Client secret"]]
  };
  function a2aSecretInputs(kind) {
    var inputs = {};
    var row = el("span", {});
    (A2A_SECRET_FIELDS[kind] || []).forEach(function (f) {
      var input = el("input", { type: f[0] === "client_id" ? "text" : "password", placeholder: f[1], autocomplete: "off" });
      inputs[f[0]] = input;
      row.appendChild(input);
    });
    return { row: row, read: function () {
      var secret = {};
      Object.keys(inputs).forEach(function (k) { secret[k] = inputs[k].value; inputs[k].value = ""; });
      return secret;
    } };
  }
  function a2aCredentialLabel(c) {
    var scope = c.scope || {};
    var what = c.kind === "none" ? "No credential"
      : c.kind === "api_key" ? "API key in the " + String(scope.header) + " header"
      : c.kind === "bearer" ? "Bearer token"
      : "OAuth client for " + ((scope.scopes || []).join(", ") || "no named scopes");
    return what + ", revision " + String(c.revision);
  }
  function a2aCredentialRows(agent, creds, act) {
    var rows = [];
    creds.forEach(function (c) {
      var row = el("div", { class: "row" }, [el("span", { class: "muted", text: a2aCredentialLabel(c) })]);
      if (c.kind !== "none") {
        var fields = a2aSecretInputs(c.kind);
        row.appendChild(fields.row);
        row.appendChild(btn("Replace secret", "", function () { act("/credentials/" + encodeURIComponent(c.credential_ref) + "/rotate", { secret: fields.read() }); }));
      }
      row.appendChild(btn("Revoke credential", "danger", function () { act("/credentials/" + encodeURIComponent(c.credential_ref) + "/revoke"); }));
      rows.push(row);
    });
    (Array.isArray(agent.schemes) ? agent.schemes : []).forEach(function (sc) {
      if (!A2A_SECRET_FIELDS[sc.kind]) {
        rows.push(el("div", { class: "muted", text: "The card asks for “" + String(sc.label || "") + "”, a kind of sign-in Dina cannot provide yet." }));
        return;
      }
      var fields = a2aSecretInputs(sc.kind);
      var scopeBoxes = [];
      var row = el("div", { class: "row" }, [el("span", { text: "Credential for “" + String(sc.label || "") + "” (" + (sc.kind === "api_key" ? "API key in the " + String(sc.header) + " header" : sc.kind === "bearer" ? "bearer token" : "OAuth client at " + String(sc.token_host)) + ")" }), fields.row]);
      (sc.scopes || []).forEach(function (name) {
        var box = el("input", { type: "checkbox", value: String(name) });
        scopeBoxes.push(box);
        row.appendChild(el("label", {}, [box, el("span", { text: String(name) })]));
      });
      row.appendChild(btn("Use this credential", "", function () {
        var body = { kind: sc.kind, scheme: sc.name, secret: fields.read() };
        if (sc.kind === "oauth2_client") body.scopes = scopeBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        act("/credentials", body);
      }));
      rows.push(row);
    });
    return rows;
  }
  function a2aOpRow(op) {
    var row = el("div", { class: "card" }, [
      el("strong", { text: String(op.agent_name || "remote agent") + " · " + String(op.skill || "") + " — " + String(op.state) + (op.reason ? " (" + String(op.reason) + ")" : "") })
    ]);
    if (op.result !== null && op.result !== undefined) {
      var r = op.result;
      var text = r && r.version === 1 && Array.isArray(r.parts) ? r.parts.map(partText).join("\\n\\n") : JSON.stringify(r, null, 2);
      row.appendChild(el("pre", { text: text }));
    }
    if (op.state === "completed") {
      // What the answer's placeholders stand for, shown beside it (A2A §6.5),
      // never written into the agent's text.
      var legendBox = el("div", { class: "muted" });
      row.appendChild(btn("Show placeholders", "", function () {
        call("GET", "/v1/owner/a2a/operations/" + encodeURIComponent(String(op.operation_id))).then(function (r) {
          clear(legendBox);
          var legend = r.body && Array.isArray(r.body.placeholder_legend) ? r.body.placeholder_legend : [];
          if (!legend.length) legendBox.appendChild(el("div", { text: "No placeholder in this answer stands for a detail Dina kept." }));
          legend.forEach(function (e) { legendBox.appendChild(el("div", { text: String(e.placeholder) + " = " + String(e.original) })); });
        });
      }));
      row.appendChild(legendBox);
    }
    // The owner's cancel, once asked of the remote (A2A §6.4): one request per task.
    if (op.state === "running" && op.cancel === "refused") {
      row.appendChild(el("div", { class: "muted", text: "The agent refused to cancel. The task runs on to its own end." }));
    } else if (op.state === "running" && (op.cancel === "requested" || op.cancel === "attempting")) {
      row.appendChild(el("div", { class: "muted", text: "Cancel asked. Waiting for the agent's answer." }));
    }
    if (op.state === "pending_decision" || op.state === "queued" || (op.state === "running" && !op.cancel)) {
      row.appendChild(btn("Cancel", "danger", function () {
        call("POST", "/v1/owner/a2a/operations/" + encodeURIComponent(String(op.operation_id)) + "/cancel", {}).then(function (res) {
          if (res.status >= 300) alert(a2aRefusal(res));
          loadA2A(); loadApprovals();
        });
      }));
    }
    return row;
  }
  function loadA2A() {
    var agentsBox = document.getElementById("a2aAgents");
    var opsBox = document.getElementById("a2aOps");
    call("GET", "/v1/owner/a2a/remote-agents").then(function (r) {
      clear(agentsBox); agentsBox.className = "";
      if (r.status !== 200) { agentsBox.className = "muted"; agentsBox.textContent = r.status === 503 ? "Remote agents are not available on this node." : a2aRefusal(r); return; }
      var agents = Array.isArray(r.body.agents) ? r.body.agents : [];
      if (!agents.length) { agentsBox.className = "muted"; agentsBox.textContent = "No remote agents registered."; return; }
      agents.forEach(function (a) { agentsBox.appendChild(a2aAgentCard(a)); });
    });
    call("GET", "/v1/owner/a2a/operations").then(function (r) {
      clear(opsBox); opsBox.className = "";
      if (r.status !== 200) { opsBox.className = "muted"; opsBox.textContent = "Not available."; return; }
      var ops = Array.isArray(r.body.operations) ? r.body.operations : [];
      if (!ops.length) { opsBox.className = "muted"; opsBox.textContent = "No requests yet."; return; }
      ops.forEach(function (o) { opsBox.appendChild(a2aOpRow(o)); });
    });
  }
  // A2A §8.2: the directory listing and its publisher are the owner's alone.
  var A2A_PUBLISH_STATES = {
    not_published: "Not published.",
    pending: "Publishing…",
    published: "Published.",
    failed: "Publishing failed. Dina will try again.",
    stood_down: "Stopped publishing.",
    deactivating: "Taking the card down…"
  };
  var A2A_STAND_DOWN_NOTICES = {
    another_server_publishing: "Another server now publishes this node's card, so this one stopped. Start publishing here only if this server should take over.",
    fence_missing: "This node's publishing fence is gone from its repository, so it stopped publishing. Start publishing to set a new one.",
    fence_unverifiable: "This node could not verify the publishing fence in its repository, so it stopped publishing. Start publishing to check again."
  };
  function a2aDirectoryPanel(view, act) {
    var box = el("div", {});
    box.appendChild(el("div", { text: view.listing_enabled ? "Listing is on." : "Listing is off." }));
    box.appendChild(el("div", { class: "muted", text: (A2A_PUBLISH_STATES[view.state] || String(view.state)) + (view.active ? " This server publishes." : " This server does not publish.") }));
    if (view.listing_enabled && view.active && !view.eligible && view.state !== "stood_down") {
      box.appendChild(el("div", { class: "muted", text: "Nothing goes out until this node has a gateway and at least one public skill." }));
    }
    if (view.published_at) {
      box.appendChild(el("div", { class: "muted", text: "Last published " + new Date(view.published_at).toISOString() + (view.published_uri ? " as " + String(view.published_uri) : "") + "." }));
    }
    if (view.state === "failed" && view.next_retry_at) {
      box.appendChild(el("div", { class: "muted", text: "Attempts so far: " + String(view.attempts) + ". Next try " + new Date(view.next_retry_at).toISOString() + "." }));
    }
    if (view.notice) {
      box.appendChild(el("div", { class: "card", text: A2A_STAND_DOWN_NOTICES[view.notice] || ("Publishing stopped (" + String(view.notice) + ").") }));
    }
    var bar = el("div", { class: "bar" });
    bar.appendChild(btn(view.listing_enabled ? "Turn listing off" : "Turn listing on", "", function () {
      act("/v1/owner/a2a/directory-listing", { enabled: !view.listing_enabled });
    }));
    if (view.active) bar.appendChild(btn("Stop publishing", "danger", function () { act("/v1/owner/a2a/publisher/deactivate", {}); }));
    else bar.appendChild(btn("Start publishing", "primary", function () { act("/v1/owner/a2a/publisher/activate", {}); }));
    box.appendChild(bar);
    return box;
  }
  // Offered only after activation found a fence it cannot verify (§8.2): replacing it is the owner's call.
  function a2aRefenceOffer(act) {
    return el("div", { class: "card" }, [
      el("div", { text: "A publishing fence Dina cannot verify stands in this node's repository. Replace it only if no other server should publish this node's card." }),
      btn("Replace the fence and publish from here", "danger", function () { act("/v1/owner/a2a/publisher/activate", { refence: true }); })
    ]);
  }
  function directoryAct(path, body) {
    call("POST", path, body).then(function (r) {
      if (r.status === 409 && r.body && r.body.error === "fence_unverifiable" && body.refence !== true) {
        document.getElementById("a2aDirectory").appendChild(a2aRefenceOffer(directoryAct));
        return;
      }
      if (r.status >= 300) alert(a2aRefusal(r));
      loadDirectory();
    });
  }
  function loadDirectory() {
    var box = document.getElementById("a2aDirectory");
    call("GET", "/v1/owner/a2a/publisher").then(function (r) {
      clear(box); box.className = "";
      if (r.status !== 200) { box.className = "muted"; box.textContent = r.status === 503 ? "The agent directory is not available on this node." : a2aRefusal(r); return; }
      box.appendChild(a2aDirectoryPanel(r.body, directoryAct));
    });
  }
  function registerA2A(evt) {
    evt.preventDefault();
    var input = document.getElementById("a2aCardUrl");
    call("POST", "/v1/owner/a2a/remote-agents", { card_url: input.value.trim() }).then(function (r) {
      if (r.status !== 201) { alert(a2aRefusal(r)); return; }
      input.value = "";
      loadA2A();
    });
  }

  // ── wire up ─────────────────────────────────────────────────────────
  document.getElementById("save").addEventListener("click", function () {
    setCap(document.getElementById("cap").value);
    document.getElementById("cap").value = "";
    refreshKeyState();
    loadSetup(); loadReasoningJobs(); loadRuns(); loadWatches(); loadApprovals(); loadTenders(); loadPacks(); loadA2A(); loadDirectory();
  });
  document.getElementById("refreshApprovals").addEventListener("click", loadApprovals);
  document.getElementById("refreshTenders").addEventListener("click", loadTenders);
  document.getElementById("refreshPacks").addEventListener("click", loadPacks);
  document.getElementById("refreshA2A").addEventListener("click", loadA2A);
  document.getElementById("refreshDirectory").addEventListener("click", loadDirectory);
  document.getElementById("a2aRegister").addEventListener("submit", registerA2A);
  document.getElementById("presenceConfirm").addEventListener("click", confirmPresence);
  document.getElementById("presenceCancel").addEventListener("click", function () {
    pendingRetry = null;
    document.getElementById("presenceBox").classList.add("hidden");
  });
  document.getElementById("pairCoding").addEventListener("click", createCodingSetup);
  document.getElementById("copyCoding").addEventListener("click", copyCodingSetup);
  document.getElementById("pairStaff").addEventListener("click", createStaffSetup);
  document.getElementById("copyStaff").addEventListener("click", copyStaffSetup);
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
  if (getCap()) { loadSetup(); loadReasoningJobs(); loadRuns(); loadWatches(); loadApprovals(); loadTenders(); loadPacks(); loadA2A(); loadDirectory(); }
})();
</script>
</body>
</html>`;
