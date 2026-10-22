/**
 * The pages a hosted cell's gate serves on its owner origin (HOSTED_DINA §4,
 * §5): first-time setup, unlock, and "connect this browser".
 *
 * Self-contained like the owner console: inline CSS and JS, no external
 * fetch, every node built with createElement + textContent. The page JS uses
 * string concatenation only, so no `${…}` meets this TS template literal.
 *
 * The browser key is made by WebCrypto as non-extractable and stored in the
 * same IndexedDB record `/app` uses (`dina-owner-device` / `device` / `owner`),
 * so the owner console finds it and signs with it.
 */

import type { GateState } from './gate';

export const GATE_PAGE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
};

export function renderGatePage(state: GateState, frontDoorOrigin = ''): string {
  return PAGE.replace('__STATE__', JSON.stringify(state)).replace(
    '__FRONT_DOOR__',
    JSON.stringify(frontDoorOrigin),
  );
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Your Dina</title>
<style>
  :root { --ink:#1d2433; --muted:#5b6474; --line:#d8dce3; --bg:#f7f8fa; --card:#fff; --accent:#1f5f8b; --bad:#a3261a; }
  body { font:16px/1.5 system-ui,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:2rem 16px; }
  main { max-width:34rem; margin:0 auto; display:grid; gap:1rem; }
  h1 { font-size:1.4rem; margin:0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1rem 1.2rem; display:grid; gap:.6rem; }
  label { display:grid; gap:.2rem; font-size:.95rem; }
  input { font:inherit; padding:.45rem .55rem; border:1px solid var(--line); border-radius:6px; }
  button { font:inherit; padding:.5rem 1.1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; justify-self:start; }
  button:disabled { opacity:.5; cursor:default; }
  .muted { color:var(--muted); font-size:.92rem; }
  .err { color:var(--bad); }
  ol.words { columns:3; margin:0; padding-left:1.6rem; font-family:ui-monospace,monospace; }
  .hidden { display:none; }
</style>
</head>
<body>
<main>
  <h1>Your Dina</h1>
  <div id="view"></div>
  <p id="msg" class="err" role="alert"></p>
</main>
<script>
"use strict";
(function () {
  var STATE = __STATE__;
  var FRONT_DOOR = __FRONT_DOOR__;
  var view = document.getElementById("view");
  var msg = document.getElementById("msg");
  var WORDS = {
    bad_ticket: "This sign-up link has expired or was already used. Start again from ChatGPT.",
    already_set_up: "This Dina is already set up.",
    passphrase_too_short: "Use at least 12 characters for your passphrase.",
    passphrase_too_long: "That passphrase is too long.",
    bad_currency: "Currency must be a three-letter code, like INR.",
    bad_postal_area: "Use letters, digits and spaces for the delivery area.",
    wrong_passphrase: "That passphrase is not right.",
    too_many_attempts: "Too many tries. Wait ten minutes and try again.",
    busy: "Dina is busy with another step. Try again in a moment.",
    core_not_ready: "Dina did not start in time. Try again.",
    locked: "Your Dina is locked. Unlock it first.",
    core_still_running: "An earlier copy of your Dina is still stopping. Try again in a minute.",
    connect_failed: "Could not connect this browser."
  };

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
  function say(key) { msg.textContent = key ? (WORDS[key] || ("Something went wrong (" + key + ").")) : ""; }
  function field(id, label, type, extra) {
    var input = el("input", Object.assign({ id: id, type: type, autocomplete: "off" }, extra || {}));
    return el("label", { for: id }, [document.createTextNode(label), input]);
  }
  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, body: b }; });
    });
  }

  // ── The browser's owner key (same record /app uses) ──────────────────
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = "";
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
    for (var m = digits.length - 1; m >= 0; m--) out += B58.charAt(digits[m]);
    return out;
  }
  function multibase(pub) {
    var tagged = new Uint8Array(pub.length + 2);
    tagged[0] = 0xed; tagged[1] = 0x01; tagged.set(pub, 2);
    return "z" + base58(tagged);
  }
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("dina-owner-device", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("device", { keyPath: "id" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function hasOwnerKey() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var r = db.transaction("device", "readonly").objectStore("device").get("owner");
        r.onsuccess = function () { resolve(!!r.result); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }
  function pairBrowser(code) {
    return crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]).then(function (pair) {
      return crypto.subtle.exportKey("raw", pair.publicKey).then(function (raw) {
        var pub = new Uint8Array(raw);
        var mb = multibase(pub);
        return post("/v1/pair/complete", { code: code, public_key_multibase: mb }).then(function (res) {
          if (res.status !== 200 && res.status !== 201) throw new Error("pairing_failed");
          return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
              var tx = db.transaction("device", "readwrite");
              tx.objectStore("device").put({ id: "owner", did: "did:key:" + mb, deviceName: "Browser", privateKey: pair.privateKey });
              tx.oncomplete = function () { resolve(); };
              tx.onerror = function () { reject(tx.error); };
            });
          });
        });
      });
    });
  }

  // ── Setup ─────────────────────────────────────────────────────────────
  function hashParams() {
    var out = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }
  function safeReturn(url) {
    if (typeof url !== "string" || FRONT_DOOR === "") return "";
    return url.indexOf(FRONT_DOOR + "/link/done?") === 0 ? url : "";
  }

  function showSetup() {
    var params = hashParams();
    // The ticket and the way back stay in the fragment: never sent to a server log.
    history.replaceState(null, "", location.pathname);
    if (!params.ticket) { view.appendChild(el("p", { text: "Open this page from the link ChatGPT gave you." })); return; }
    var back = safeReturn(params["return"] || "");
    var form = el("div", { class: "card" }, [
      el("p", { text: "Choose a passphrase. It locks your Dina: we cannot open it without you, and we cannot reset it." }),
      field("pass", "Passphrase (12 characters or more)", "password", { minlength: "12" }),
      field("pass2", "Passphrase again", "password"),
      field("currency", "Currency you buy in", "text", { value: "INR", maxlength: "3" }),
      field("postal", "Delivery postal area (optional)", "text", { maxlength: "32" }),
      el("button", { id: "go", text: "Create my Dina" })
    ]);
    view.appendChild(form);
    document.getElementById("go").addEventListener("click", function () {
      var p1 = document.getElementById("pass").value;
      if (p1 !== document.getElementById("pass2").value) { say(""); msg.textContent = "The two passphrases differ."; return; }
      say("");
      var go = document.getElementById("go");
      go.disabled = true; go.textContent = "Creating your Dina…";
      post("/cell/setup", {
        ticket: params.ticket, passphrase: p1,
        currency: document.getElementById("currency").value,
        postal_area: document.getElementById("postal").value
      }).then(function (res) {
        if (res.status !== 200) { go.disabled = false; go.textContent = "Create my Dina"; say(res.body.error || "setup_failed"); return; }
        showWords(res.body.words || [], res.body.owner_device_code || "", back);
      }).catch(function () { go.disabled = false; go.textContent = "Create my Dina"; say("setup_failed"); });
    });
  }

  function showWords(words, code, back) {
    clear(view);
    var list = el("ol", { class: "words" });
    words.forEach(function (w) { list.appendChild(el("li", { text: w })); });
    var a = 2 + Math.floor(Math.random() * 10), b = 13 + Math.floor(Math.random() * 10);
    var card = el("div", { class: "card" }, [
      el("p", { text: "Write these 24 words down and keep them safe. With them you can move your Dina to your own phone or server, or restore it. This page shows them once." }),
      list,
      field("w1", "Word " + a, "text"),
      field("w2", "Word " + b, "text"),
      el("button", { id: "done", text: "I have written them down" })
    ]);
    view.appendChild(card);
    document.getElementById("done").addEventListener("click", function () {
      var ok = document.getElementById("w1").value.trim() === words[a - 1] && document.getElementById("w2").value.trim() === words[b - 1];
      if (!ok) { msg.textContent = "Those words do not match. Check what you wrote."; return; }
      say("");
      clear(view);
      view.appendChild(el("p", { class: "muted", text: "Connecting this browser as your owner key…" }));
      pairBrowser(code).then(function () {
        clear(view);
        var done = el("div", { class: "card" }, [el("p", { text: "Your Dina is ready, and this browser is its owner key." })]);
        if (back) {
          var go = el("button", { text: "Back to ChatGPT" });
          go.addEventListener("click", function () { location.assign(back); });
          done.appendChild(go);
        }
        var page = el("button", { text: "Open my Dina page" });
        page.addEventListener("click", function () { location.assign("/owner"); });
        done.appendChild(page);
        view.appendChild(done);
      }).catch(function () { say("pairing_failed"); });
    });
  }

  // ── Unlock ────────────────────────────────────────────────────────────
  function showUnlock() {
    hasOwnerKey().then(function (paired) {
      var card = el("div", { class: "card" }, [
        el("p", { text: "Your Dina is locked. It locks whenever it restarts, and only your passphrase opens it." }),
        field("pass", "Passphrase", "password"),
        el("button", { id: "go", text: "Unlock" })
      ]);
      view.appendChild(card);
      if (!paired) card.insertBefore(el("p", { class: "muted", text: "This browser will also become an owner key." }), card.lastChild);
      document.getElementById("go").addEventListener("click", function () {
        var go = document.getElementById("go");
        go.disabled = true;
        post("/cell/unlock", { passphrase: document.getElementById("pass").value, connect_browser: !paired }).then(function (res) {
          if (res.status !== 200) { go.disabled = false; say(res.body.error || "unlock_failed"); return; }
          var next = res.body.owner_device_code ? pairBrowser(res.body.owner_device_code) : Promise.resolve();
          return next.then(function () { location.assign("/owner"); });
        }).catch(function () { go.disabled = false; say("unlock_failed"); });
      });
    });
  }

  // ── Unlocked: go on, or connect this browser ─────────────────────────
  function showUnlocked() {
    hasOwnerKey().then(function (paired) {
      if (paired) { location.assign("/owner"); return; }
      var card = el("div", { class: "card" }, [
        el("p", { text: "Your Dina is open. To manage it from this browser, enter your passphrase; this browser becomes an owner key." }),
        field("pass", "Passphrase", "password"),
        el("button", { id: "go", text: "Connect this browser" })
      ]);
      view.appendChild(card);
      document.getElementById("go").addEventListener("click", function () {
        var go = document.getElementById("go");
        go.disabled = true;
        post("/cell/connect-browser", { passphrase: document.getElementById("pass").value }).then(function (res) {
          if (res.status !== 200) { go.disabled = false; say(res.body.error || "connect_failed"); return; }
          return pairBrowser(res.body.owner_device_code).then(function () { location.assign("/owner"); });
        }).catch(function () { go.disabled = false; say("pairing_failed"); });
      });
    });
  }

  function showWaiting(text) {
    view.appendChild(el("p", { class: "muted", text: text }));
    setTimeout(function () { location.reload(); }, 3000);
  }

  if (STATE === "new") showSetup();
  else if (STATE === "locked") showUnlock();
  else if (STATE === "starting") showWaiting("Your Dina is starting…");
  else if (STATE === "failed") view.appendChild(el("p", { text: "Setting up this Dina failed. Start again from ChatGPT." }));
  else showUnlocked();
})();
</script>
</body>
</html>`;
