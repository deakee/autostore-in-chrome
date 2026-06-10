/**
 * AutoStore in-Chrome extension — service worker.
 *
 * Maintains a persistent WS connection to the local bridge. Handles RPC
 * requests by calling chrome.* APIs on the user's real tabs.
 *
 * Flow:
 *   1. User installs extension and opens the popup once — paste bridge token
 *      (read from ~/.autostore-in-chrome/token on their machine, shown to
 *      them by the Mac app or the bridge's first-run message).
 *   2. Popup saves token to chrome.storage.local.
 *   3. Service worker connects to ws://127.0.0.1:43117, sends {type:"hello", token}.
 *   4. Bridge replies with {type:"hello-ack"}, then fires rpc-request messages
 *      whenever an MCP tool is called.
 *   5. Service worker dispatches by method, runs the chrome.* API, sends back
 *      rpc-response.
 *
 * Reconnection: if the WS drops (bridge restarted, sleep/wake, etc.) we back
 * off and retry. The user doesn't need to do anything.
 */

const DEFAULT_PORT = 43117;

// MV3 service workers can be suspended. Keep state in chrome.storage, not globals.
let ws = null;
let reconnectTimer = null;
let connectAttempt = 0;

async function getConfig() {
  const { bridgeToken, bridgePort } = await chrome.storage.local.get(["bridgeToken", "bridgePort"]);
  return { token: bridgeToken ?? "", port: bridgePort ?? DEFAULT_PORT };
}

/**
 * Auto-pair with the local daemon. Loopback-only, no auth required.
 *
 * The Mac app has already done a Deakee OAuth login and writes the user
 * identity to ~/.autostore-in-chrome/user.json. The daemon exposes both the
 * bridge token and that user via GET /pair, so the extension can become
 * "logged in" with zero clicks the moment the Mac app is running.
 *
 * Returns the bridge token on success, null on failure.
 */
async function tryAutoPair(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pair`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.bridgeToken) return null;

    // Only write to storage when something actually changed, otherwise the
    // onChanged listener will close-and-reopen the WS on every popup poll.
    const existing = await chrome.storage.local.get(["bridgeToken", "bridgePort", "autoStoreUser"]);
    const update = {};
    if (existing.bridgeToken !== data.bridgeToken) update.bridgeToken = data.bridgeToken;
    if (existing.bridgePort  !== port)              update.bridgePort  = port;
    if (data.user && JSON.stringify(existing.autoStoreUser) !== JSON.stringify(data.user)) {
      update.autoStoreUser = data.user;
    }
    if (Object.keys(update).length > 0) {
      await chrome.storage.local.set(update);
      console.log("[autostore-in-chrome] paired with daemon" + (data.user ? ` as ${data.user.email}` : ""));
    }
    return data.bridgeToken;
  } catch {
    return null; // daemon not running
  }
}

/**
 * Legacy fallback: extension was logged in via Deakee OAuth (popup), has a
 * JWT but no bridge token (daemon was offline at the time). Trade JWT for
 * a bridge token. Used when the Mac app hasn't written user.json (older
 * Mac builds, or daemon started without the Mac app).
 */
async function autoFetchBridgeToken(port) {
  const { autoStoreJwt } = await chrome.storage.local.get(["autoStoreJwt"]);
  if (!autoStoreJwt) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: autoStoreJwt }),
    });
    if (!res.ok) {
      if (res.status === 401) await chrome.storage.local.remove(["autoStoreJwt", "autoStoreUser", "bridgeToken"]);
      return null;
    }
    const { token } = await res.json();
    if (token) {
      await chrome.storage.local.set({ bridgeToken: token, bridgePort: port });
      console.log("[autostore-in-chrome] fetched bridge token via JWT");
    }
    return token ?? null;
  } catch {
    return null;
  }
}

/** Is OUR daemon answering on this port? (vs. a foreign server / nothing). */
async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    if (!res.ok) return false;
    const j = await res.json();
    return typeof j?.daemonVersion === "string";
  } catch {
    return false; // refused, or a foreign server returning non-JSON
  }
}

/**
 * Find the live daemon. It auto-moves off a busy 43117 and writes its real
 * port to a file we can't read from an extension, so we probe /health across
 * the candidate range (same window the daemon walks). Returns a port or null.
 */
async function discoverPort(preferred) {
  const seen = new Set();
  const candidates = [preferred];
  for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + 13; p++) candidates.push(p);
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (await probeHealth(p)) return p;
  }
  return null;
}

async function connect() {
  clearTimeout(reconnectTimer);
  let { token, port } = await getConfig();

  // Follow the daemon if it moved off a busy 43117.
  const found = await discoverPort(port);
  if (found && found !== port) {
    port = found;
    await chrome.storage.local.set({ bridgePort: port });
    console.log(`[autostore-in-chrome] daemon found on port ${port}`);
  }

  // Always run /pair when we don't have user info yet — covers the case
  // where an older build of the extension stored a bridgeToken without a
  // paired user, and ensures the popup gets the identity from the Mac app.
  const { autoStoreUser } = await chrome.storage.local.get("autoStoreUser");
  if (!token || !autoStoreUser) {
    const paired = await tryAutoPair(port);
    if (paired) token = paired;
    else if (!token) token = (await autoFetchBridgeToken(port)) || "";
  }

  if (!token) {
    console.log("[autostore-in-chrome] daemon not reachable — waiting for AutoStore Mac app to start.");
    scheduleReconnect(5_000);
    return;
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  } catch (e) {
    console.warn("[autostore-in-chrome] WS construct failed:", e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    console.log("[autostore-in-chrome] WS open — sending hello");
    connectAttempt = 0;
    ws.send(JSON.stringify({
      type: "hello",
      token,
      chromeVersion: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? "unknown",
    }));
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    if (msg.type === "hello-ack") {
      console.log("[autostore-in-chrome] handshake OK, daemon v" + (msg.daemonVersion ?? "?"));
      setBadge("ON", "#1db954");
      return;
    }
    if (msg.type === "rpc-request") handleRpc(msg).catch((e) => sendRpcError(msg.id, e));
  });

  ws.addEventListener("close", () => {
    console.log("[autostore-in-chrome] WS closed");
    ws = null;
    setBadge("OFF", "#d33");
    scheduleReconnect();
  });

  ws.addEventListener("error", (e) => {
    console.warn("[autostore-in-chrome] WS error:", e);
    // `close` will follow; handle there.
  });
}

function scheduleReconnect(ms) {
  connectAttempt += 1;
  const delay = ms ?? Math.min(30_000, 500 * Math.pow(2, connectAttempt));
  reconnectTimer = setTimeout(connect, delay);
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─────────────────────────── RPC handlers ───────────────────────────

async function handleRpc(msg) {
  const { id, method, params } = msg;
  try {
    const result = await dispatch(method, params ?? {});
    ws?.send(JSON.stringify({ type: "rpc-response", id, ok: true, result }));
  } catch (e) {
    sendRpcError(id, e);
  }
}

function sendRpcError(id, err) {
  ws?.send(JSON.stringify({
    type: "rpc-response",
    id,
    ok: false,
    error: err?.message ?? String(err),
  }));
}

async function dispatch(method, params) {
  switch (method) {
    case "list_open_tabs": return listOpenTabs(params);
    case "snapshot":       return snapshot(params);
    case "click":          return click(params);
    case "open_url":       return openUrl(params);
    case "type":           return typeInto(params);
    case "eval":           return evalInPage(params);
    case "click_by_text":  return clickByText(params);
    case "find_by_text":   return findByText(params);
    case "fill_submit":    return fillSubmit(params);
    case "computer":       return computer(params);
    default: throw new Error(`unknown method: ${method}`);
  }
}

async function listOpenTabs({ urlContains } = {}) {
  const tabs = await chrome.tabs.query({});
  const filtered = urlContains
    ? tabs.filter((t) => (t.url ?? "").toLowerCase().includes(urlContains.toLowerCase()))
    : tabs;
  return filtered.map((t) => ({
    tabId: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
}

/**
 * ARIA snapshot via the debugger protocol. Playwright-style YAML output
 * isn't available in pure CDP, so we walk the accessibility tree and
 * emit a compact YAML-ish format ourselves.
 */
async function snapshot({ tabId }) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    await chrome.debugger.sendCommand(debuggee, "Accessibility.enable");
    const { nodes } = await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree");
    return { snapshot: renderAxTree(nodes) };
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch { /* ignore */ }
  }
}

function renderAxTree(nodes) {
  // Build child-index, then DFS from the root.
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId);
  const lines = [];
  for (const r of roots) walk(r, 0);
  return lines.join("\n");

  function walk(n, depth) {
    const ignored = n.ignored;
    if (!ignored) {
      const role = n.role?.value ?? "node";
      const name = n.name?.value ?? "";
      const label = name ? `${role} "${truncate(name, 80)}"` : role;
      lines.push(`${"  ".repeat(depth)}- ${label}`);
    }
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid);
      if (c) walk(c, ignored ? depth : depth + 1);
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function click({ tabId, selector }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      // Collect matches from document + every open shadow root so Katal /
      // Seller Hub / Etsy custom elements are reachable.
      const found = [];
      function walk(root) {
        try {
          root.querySelectorAll(sel).forEach((e) => found.push(e));
          root.querySelectorAll("*").forEach((n) => { if (n.shadowRoot) walk(n.shadowRoot); });
        } catch {}
      }
      walk(document);
      if (found.length === 0) return { success: false, error: `no element matches ${sel}` };
      if (found.length > 1)  return { success: false, error: `${found.length} elements match ${sel} — narrow the selector or use click_by_text` };
      const el = found[0];
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      return { success: true };
    },
    args: [selector],
  });
  if (!result?.success) throw new Error(result?.error ?? "click failed");
  return { clicked: selector };
}

async function openUrl({ url, tabId } = {}) {
  if (!url) throw new Error("open_url: url required");
  let tab;
  if (typeof tabId === "number") {
    tab = await chrome.tabs.update(tabId, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ url, active: true });
  }
  // Wait until the tab is done loading (or until 20s).
  await new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); }, 20_000);
    function onUpdate(id, info) {
      if (id === tab.id && info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
  // Refetch to get the final URL (redirects may have happened).
  const finalTab = await chrome.tabs.get(tab.id);
  return { tabId: finalTab.id, url: finalTab.url, title: finalTab.title };
}

/**
 * Fill a text field in the page. Works with plain <input> / <textarea> AND
 * contenteditable divs (Wangwang uses the latter). Dispatches input events so
 * React/Vue re-render.
 */
async function typeInto({ tabId, selector, text, append, submit } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, text, append, submit) => {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) return { ok: false, error: `no element matches ${sel}` };
      if (els.length > 1)  return { ok: false, error: `${els.length} elements match ${sel} — must be exactly one` };
      const el = els[0];
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.focus?.();
      const tag = el.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        const newVal = append ? (el.value || "") + text : text;
        setter.call(el, newVal);
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        if (!append) el.innerHTML = "";
        // Insert text at caret for better compatibility with rich editors.
        document.execCommand?.("insertText", false, text);
        if (!el.innerText.includes(text)) {
          // Fallback for editors that swallow execCommand.
          el.textContent = (append ? (el.textContent || "") : "") + text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      } else {
        return { ok: false, error: `element is not an input/textarea/contenteditable (tag=${tag})` };
      }
      if (submit) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
          }));
        }
      }
      return { ok: true };
    },
    args: [selector, text, !!append, !!submit],
  });
  if (!result?.ok) throw new Error(result?.error ?? "type failed");
  return { typed: selector, length: text.length };
}

/**
 * Run arbitrary JS in the page's main world. Expression is wrapped so a
 * bare expression returns its value — same semantics as DevTools console.
 * Return value must be JSON-serializable.
 */
async function evalInPage({ tabId, expression }) {
  const [{ result, error }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (expr) => {
      try {
        // Accept both expression form ("document.title") and statement form
        // ("const x = ...; return x;"). First try expression semantics —
        // matches DevTools console behavior. If that throws SyntaxError,
        // retry as an async function body so `const`/`let`/`var`/`if`/`await`
        // at the top level all work.
        // eslint-disable-next-line no-new-func
        let v;
        try {
          v = new Function(`return (${expr});`)();
        } catch (e1) {
          if (e1 instanceof SyntaxError) {
            // eslint-disable-next-line no-new-func
            const fn = new (Object.getPrototypeOf(async function () {}).constructor)(expr);
            v = fn();
          } else {
            throw e1;
          }
        }
        if (v && typeof v.then === "function") v = await v;
        return { ok: true, value: v === undefined ? null : v };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    args: [expression],
  });
  if (error) throw new Error(error);
  if (!result?.ok) throw new Error(result?.error ?? "eval failed");
  return { value: result.value };
}

/**
 * Find & optionally click an element by visible text — the primitive the LLM
 * actually needs. Walks the DOM AND every open shadow root (eBay Katal
 * components hide buttons inside shadow DOMs, as does Amazon Seller Central).
 *
 * Match rules:
 *   - text is matched case-insensitively as a substring of `textContent`
 *   - tag filter limits which elements are considered (default: clickable roles)
 *   - the first *visible* match wins; invisible/zero-size elements are skipped
 *   - if multiple equally-ranked matches exist, a disambiguation error is
 *     returned listing them so the caller can narrow via `nth` or `tag`
 */
async function findByText({ tabId, text, tag, nth = 0, frameUrlContains } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: !!frameUrlContains },
    world: "MAIN",
    func: (needle, tag, nth, frameUrlContains) => {
      if (frameUrlContains && !location.href.includes(frameUrlContains)) {
        return { ok: false, skipFrame: true };
      }
      const wanted = (needle || "").toLowerCase().trim();
      const tags = tag
        ? [tag.toLowerCase()]
        : ["button", "a", "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]",
           "input[type=submit]", "input[type=button]", "kat-button", "kat-link", "li", "span", "div"];
      const selector = tags.join(",");

      // Walk DOM + open shadow roots, collect candidates
      const candidates = [];
      function walk(root) {
        try {
          root.querySelectorAll(selector).forEach((el) => {
            const label = (el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim();
            if (!label) return;
            if (!label.toLowerCase().includes(wanted)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            candidates.push({ el, label, rect });
          });
          // Pierce open shadow roots
          root.querySelectorAll("*").forEach((n) => {
            if (n.shadowRoot) walk(n.shadowRoot);
          });
        } catch {}
      }
      walk(document);

      // Prefer shorter labels (exact-ish matches over "click here to edit listing")
      candidates.sort((a, b) => a.label.length - b.label.length);

      if (candidates.length === 0) return { ok: false, error: `no visible element contains text "${needle}"` };
      const pick = candidates[nth];
      if (!pick) return { ok: false, error: `only ${candidates.length} matches for "${needle}" (requested nth=${nth})` };

      // Return the rect so callers can fall back to CDP coordinate click.
      // Also stash on window so a follow-up click call can re-find it.
      (window.__autostoreLastFound ||= []).push(pick.el);
      return {
        ok: true,
        label: pick.label.slice(0, 120),
        rect: { x: pick.rect.x, y: pick.rect.y, width: pick.rect.width, height: pick.rect.height },
        matchCount: candidates.length,
        preview: candidates.slice(0, 5).map((c) => c.label.slice(0, 80)),
      };
    },
    args: [text, tag || null, nth, frameUrlContains || null],
  });
  // When allFrames is used, executeScript returns one result per frame.
  // We want the first frame where the element was actually found.
  const results = Array.isArray(result) ? result : [result];
  const hit = results.find((r) => r?.ok);
  if (hit) return hit;
  const first = results.find((r) => r && !r.skipFrame);
  throw new Error(first?.error ?? "find_by_text failed");
}

async function clickByText({ tabId, text, tag, nth = 0, frameUrlContains } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: !!frameUrlContains },
    world: "MAIN",
    func: (needle, tag, nth, frameUrlContains) => {
      if (frameUrlContains && !location.href.includes(frameUrlContains)) {
        return { ok: false, skipFrame: true };
      }
      const wanted = (needle || "").toLowerCase().trim();
      const tags = tag
        ? [tag.toLowerCase()]
        : ["button", "a", "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]",
           "input[type=submit]", "input[type=button]", "kat-button", "kat-link"];
      const selector = tags.join(",");
      const candidates = [];
      function walk(root) {
        try {
          root.querySelectorAll(selector).forEach((el) => {
            const label = (el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim();
            if (!label) return;
            if (!label.toLowerCase().includes(wanted)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            candidates.push({ el, label });
          });
          root.querySelectorAll("*").forEach((n) => {
            if (n.shadowRoot) walk(n.shadowRoot);
          });
        } catch {}
      }
      walk(document);
      candidates.sort((a, b) => a.label.length - b.label.length);
      if (candidates.length === 0) return { ok: false, error: `no clickable element contains text "${needle}"` };
      const pick = candidates[nth];
      if (!pick) return { ok: false, error: `only ${candidates.length} matches for "${needle}" (requested nth=${nth})` };
      pick.el.scrollIntoView({ behavior: "instant", block: "center" });
      pick.el.click();
      return { ok: true, clicked: pick.label.slice(0, 120), matchCount: candidates.length };
    },
    args: [text, tag || null, nth, frameUrlContains || null],
  });
  const results = Array.isArray(result) ? result : [result];
  const hit = results.find((r) => r?.ok);
  if (!hit) {
    const first = results.find((r) => r && !r.skipFrame);
    throw new Error(first?.error ?? "click_by_text failed");
  }
  // Wait briefly for the click's side effect (modal open/close, nav, etc.),
  // then capture a ground-truth snapshot so the caller's response carries
  // the actual post-click page state — makes hallucination impossible.
  await new Promise((r) => setTimeout(r, 500));
  try {
    hit.afterSnapshot = await quickSnapshot(tabId);
  } catch {}
  return hit;
}

/**
 * Fill a value into a field, click a submit-like button, wait, and return the
 * post-submit snapshot. Atomic composite so the LLM can't leave the dialog
 * half-filled and claim success. Either pass `selector` OR `nearLabel` to
 * locate the input. `submitText` defaults to "Submit" (also matches "Save",
 * "保存", "Apply" via the tag filter and includes substring).
 */
async function fillSubmit({ tabId, selector, nearLabel, value, submitText = "Submit", submitTag } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (sel, nearLabel, value, submitText, submitTag) => {
      // --- Locate the input ---
      let input = null;
      function walkFind(root, predicate) {
        const out = [];
        function recur(r) {
          try {
            Array.from(r.querySelectorAll("input,textarea,[contenteditable='true']"))
              .forEach((e) => { if (predicate(e)) out.push(e); });
            r.querySelectorAll("*").forEach((n) => { if (n.shadowRoot) recur(n.shadowRoot); });
          } catch {}
        }
        recur(root);
        return out;
      }
      if (sel) {
        input = walkFind(document, (e) => e.matches?.(sel))[0];
      } else if (nearLabel) {
        const wanted = nearLabel.toLowerCase();
        // Find any element whose text matches, then pick the nearest input
        const textEls = [];
        function recurText(r) {
          try {
            r.querySelectorAll("*").forEach((e) => {
              const t = (e.innerText || e.textContent || "").trim().toLowerCase();
              if (t && t.includes(wanted) && t.length < 200) textEls.push(e);
              if (e.shadowRoot) recurText(e.shadowRoot);
            });
          } catch {}
        }
        recurText(document);
        // Also look for visible inputs anywhere and rank by DOM proximity to a text match
        const inputs = walkFind(document, (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (inputs.length === 1) input = inputs[0];
        else if (inputs.length > 1 && textEls.length) {
          // Pick the input whose bounding box is closest to a text-match box
          let best = null, bestDist = Infinity;
          const tRects = textEls.map((t) => t.getBoundingClientRect());
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            for (const tr of tRects) {
              const dx = r.x - tr.x, dy = r.y - tr.y;
              const d = dx*dx + dy*dy;
              if (d < bestDist) { bestDist = d; best = inp; }
            }
          }
          input = best;
        } else {
          input = inputs[0] || null;
        }
      }
      if (!input) return { ok: false, error: `fill_submit: could not find input (selector=${sel}, nearLabel=${nearLabel})` };

      // --- Set value in a React-friendly way ---
      input.scrollIntoView({ behavior: "instant", block: "center" });
      input.focus?.();
      const tag = input.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (input.isContentEditable) {
        input.innerText = String(value);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
      }
      const valueSet = (tag === "input" || tag === "textarea") ? input.value : input.innerText;

      // --- Find & click the submit button (by visible text, shadow-aware) ---
      const submitTags = submitTag
        ? [submitTag.toLowerCase()]
        : ["button", "[role=button]", "input[type=submit]", "kat-button"];
      const selBtn = submitTags.join(",");
      const needle = (submitText || "").toLowerCase();
      const btns = [];
      function walkBtn(r) {
        try {
          r.querySelectorAll(selBtn).forEach((e) => {
            const label = (e.innerText || e.textContent || e.getAttribute?.("aria-label") || "").trim();
            const rect = e.getBoundingClientRect();
            if (!label || rect.width === 0 || rect.height === 0) return;
            if (label.toLowerCase().includes(needle)) btns.push({ e, label });
          });
          r.querySelectorAll("*").forEach((n) => { if (n.shadowRoot) walkBtn(n.shadowRoot); });
        } catch {}
      }
      walkBtn(document);
      btns.sort((a, b) => a.label.length - b.label.length);
      if (!btns.length) return { ok: false, error: `fill_submit: no submit button with text "${submitText}" (value was set to ${valueSet})` };
      const btn = btns[0];
      btn.e.click();
      return { ok: true, valueSet, clickedLabel: btn.label.slice(0, 80), submitCandidates: btns.length };
    },
    args: [selector || null, nearLabel || null, value, submitText, submitTag || null],
  });
  if (!result?.ok) throw new Error(result?.error ?? "fill_submit failed");
  // Wait for submit side effect then snapshot
  await new Promise((r) => setTimeout(r, 800));
  try { result.afterSnapshot = await quickSnapshot(tabId); } catch {}
  return result;
}

/**
 * Lightweight page snapshot — title, URL, top visible text (dialogs first),
 * and whether a <dialog>/role=dialog is currently open. Used to auto-embed
 * ground truth in tool responses.
 */
async function quickSnapshot(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const dialogs = Array.from(document.querySelectorAll("[role=dialog],dialog[open],.modal,.overlay"))
        .filter((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((d) => (d.innerText || d.textContent || "").trim().slice(0, 400));
      const mainText = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 600);
      return {
        title: document.title,
        url: location.href,
        dialogOpen: dialogs.length > 0,
        dialogText: dialogs[0] || null,
        pageTextHead: mainText,
      };
    },
  });
  return result;
}

/**
 * Computer-use: drive the browser like a human using CDP Input / Page APIs.
 *
 * All actions attach the debugger, perform exactly one action, then detach.
 * Callers should list available tabs first so they can pass the right tabId.
 */
async function computer({
  tabId, action,
  coordinate, end_coordinate,
  text, key,
  scroll_direction, scroll_amount,
} = {}) {
  const debuggee = { tabId };

  // Helper: attach debugger (safe to call if already attached from another tool)
  async function attach() {
    try { await chrome.debugger.attach(debuggee, "1.3"); }
    catch (e) {
      if (!/already/i.test(e?.message ?? "")) throw e;
      // already attached — fine, continue
    }
  }

  // Helper: dispatch a mouse event via CDP
  async function mouseEvent(type, x, y, button = "left", clickCount = 1, buttons = 0) {
    const btnMap = { left: 1, right: 2, middle: 4, none: 0 };
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type, x, y, button,
      buttons: buttons || btnMap[button] || 0,
      clickCount,
    });
  }

  // Helper: build available-tabs context string for the return value
  async function tabContext() {
    const tabs = await chrome.tabs.query({});
    const lines = tabs.map(t => `  • tabId ${t.id}: "${t.title ?? ""}" (${t.url ?? ""})`);
    return `Tab Context:\n- Executed on tabId: ${tabId}\n- Available tabs:\n${lines.join("\n")}`;
  }

  await attach();
  try {
    const [x, y] = coordinate ?? [0, 0];

    switch (action) {

      // ── Screenshot ──────────────────────────────────────────────────
      case "screenshot": {
        // Get device pixel ratio so we can normalise screenshot to CSS pixels.
        // CDP Input.dispatchMouseEvent uses CSS pixels; Page.captureScreenshot
        // defaults to physical pixels on Retina (dpr=2 → 2x larger image).
        // Capturing at scale=1/dpr gives an image whose pixel coordinates
        // directly match click coordinates — no scaling needed by the agent.
        let dpr = 1;
        try {
          const { result } = await chrome.debugger.sendCommand(
            debuggee, "Runtime.evaluate",
            { expression: "window.devicePixelRatio", returnByValue: true }
          );
          dpr = result?.value ?? 1;
        } catch (_) { /* use dpr=1 if evaluate fails */ }

        // Get CSS viewport size for the hint in the response.
        let cssW = 0, cssH = 0;
        try {
          const metrics = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
          cssW = Math.round(metrics.cssLayoutViewport?.clientWidth  ?? metrics.layoutViewport?.clientWidth  ?? 0);
          cssH = Math.round(metrics.cssLayoutViewport?.clientHeight ?? metrics.layoutViewport?.clientHeight ?? 0);
        } catch (_) {}

        // ── Annotated screenshot ─────────────────────────────────────
        // Collect visible interactive elements, inject numbered orange
        // labels directly into the DOM, capture, then clean up.
        // The model can then say "click [3]" instead of guessing coords.
        let elements = [];
        try {
          const [{ result: elems }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (vpW, vpH) => {
              const sel = [
                "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
                "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
                "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=option]",
                "[onclick]", "[tabindex]",
              ].join(",");
              const seen = new Set();
              const out = [];
              document.querySelectorAll(sel).forEach((el) => {
                const r = el.getBoundingClientRect();
                // Skip zero-size, off-screen, or duplicate rects
                if (r.width < 4 || r.height < 4) return;
                if (r.bottom < 0 || r.top > vpH || r.right < 0 || r.left > vpW) return;
                const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
                if (seen.has(key)) return;
                seen.add(key);
                const label = (
                  el.getAttribute("aria-label") ||
                  el.getAttribute("title") ||
                  el.getAttribute("placeholder") ||
                  (el.innerText || el.textContent || "").trim()
                ).replace(/\s+/g, " ").slice(0, 50);
                const tag = el.tagName.toLowerCase();
                const type = el.getAttribute("type") || "";
                out.push({
                  tag: type ? `${tag}[${type}]` : tag,
                  label,
                  x: Math.round(r.left + r.width  / 2),
                  y: Math.round(r.top  + r.height / 2),
                  rx: Math.round(r.left), ry: Math.round(r.top),
                  rw: Math.round(r.width), rh: Math.round(r.height),
                });
              });
              return out.slice(0, 60); // cap — more than 60 is noise
            },
            args: [cssW || 1280, cssH || 800],
          });
          elements = Array.isArray(elems) ? elems : [];
        } catch (_) { /* annotation is best-effort */ }

        // Inject numbered orange labels into the page
        if (elements.length > 0) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: (elems) => {
                document.getElementById("__as_annot__")?.remove();
                const host = document.createElement("div");
                host.id = "__as_annot__";
                host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647";
                elems.forEach((el, i) => {
                  const badge = document.createElement("div");
                  // Place badge at top-left corner of element rect
                  badge.style.cssText = `
                    position:fixed;left:${el.rx}px;top:${el.ry}px;
                    min-width:18px;height:18px;
                    background:#FF6600;color:#fff;
                    font:bold 11px/18px monospace;text-align:center;
                    border-radius:3px;padding:0 3px;
                    box-shadow:0 1px 3px rgba(0,0,0,.5);
                  `.replace(/\s+/g, " ");
                  badge.textContent = String(i + 1);
                  host.appendChild(badge);
                });
                document.documentElement.appendChild(host);
              },
              args: [elements],
            });
            // Brief pause so the browser paints the overlay
            await new Promise((r) => setTimeout(r, 120));
          } catch (_) {}
        }

        // Capture with overlay present
        const { data } = await chrome.debugger.sendCommand(
          debuggee, "Page.captureScreenshot",
          { format: "png", quality: 85, captureBeyondViewport: false,
            clip: cssW > 0 ? { x: 0, y: 0, width: cssW, height: cssH, scale: 1 } : undefined,
          }
        );

        // Remove overlay immediately after capture
        if (elements.length > 0) {
          chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => document.getElementById("__as_annot__")?.remove(),
          }).catch(() => {});
        }

        // Build element index for the model to reference
        const elementIndex = elements.length > 0
          ? "\n\nInteractive Elements (orange numbers on screenshot):\n" +
            elements.map((el, i) =>
              `  [${i + 1}] ${el.tag.padEnd(16)} (${el.x},${el.y})  ${el.label || "(no label)"}`
            ).join("\n") +
            "\nTo click an element: computer(action=\"left_click\", coordinate=[x,y]) using the coordinates above."
          : "";

        const hint = cssW > 0
          ? `\n[Viewport: ${cssW}×${cssH} CSS px | devicePixelRatio: ${dpr} | Screenshot normalised to CSS px — click coordinates = image pixel coordinates, NO scaling needed]`
          : `\n[devicePixelRatio: ${dpr} | click coordinates = image pixel coordinates]`;

        return {
          screenshot: data,               // base64 PNG with numbered orange labels
          mimeType: "image/png",
          tabContext: await tabContext() + hint + elementIndex,
        };
      }

      // ── Clicks ──────────────────────────────────────────────────────
      case "left_click":
      case "right_click":
      case "middle_click": {
        const btn = action === "left_click" ? "left" : action === "right_click" ? "right" : "middle";
        await mouseEvent("mousePressed", x, y, btn);
        await mouseEvent("mouseReleased", x, y, btn);
        const ctx = await tabContext();
        return { ok: true, action, coordinate: [x, y], result: `Clicked at (${x}, ${y})\n${ctx}` };
      }

      case "double_click": {
        await mouseEvent("mousePressed", x, y, "left", 1);
        await mouseEvent("mouseReleased", x, y, "left", 1);
        await mouseEvent("mousePressed", x, y, "left", 2);
        await mouseEvent("mouseReleased", x, y, "left", 2);
        const ctx = await tabContext();
        return { ok: true, action, coordinate: [x, y], result: `Double-clicked at (${x}, ${y})\n${ctx}` };
      }

      // ── Mouse move ──────────────────────────────────────────────────
      case "mouse_move": {
        await mouseEvent("mouseMoved", x, y, "none");
        const ctx = await tabContext();
        return { ok: true, action, coordinate: [x, y], result: `Moved mouse to (${x}, ${y})\n${ctx}` };
      }

      // ── Drag ────────────────────────────────────────────────────────
      case "left_click_drag": {
        const [ex, ey] = end_coordinate ?? [x, y];
        await mouseEvent("mousePressed", x, y, "left", 1, 1);
        // Move in small increments so sites detect the drag
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const ix = Math.round(x + (ex - x) * i / steps);
          const iy = Math.round(y + (ey - y) * i / steps);
          await mouseEvent("mouseMoved", ix, iy, "left", 0, 1);
        }
        await mouseEvent("mouseReleased", ex, ey, "left", 1);
        const ctx = await tabContext();
        return { ok: true, action, coordinate: [x, y], end_coordinate: [ex, ey],
          result: `Dragged from (${x}, ${y}) to (${ex}, ${ey})\n${ctx}` };
      }

      // ── Type ─────────────────────────────────────────────────────────
      case "type": {
        const str = text ?? "";
        for (const char of str) {
          await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
            type: "keyDown", text: char, unmodifiedText: char,
          });
          await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
            type: "keyUp", text: char, unmodifiedText: char,
          });
        }
        const ctx = await tabContext();
        return { ok: true, action, length: str.length,
          result: `Typed ${str.length} characters\n${ctx}` };
      }

      // ── Key ──────────────────────────────────────────────────────────
      case "key": {
        const combo = (key ?? "").trim();
        const parts  = combo.split(/\+(?=[^+])/);
        const mainKey = parts[parts.length - 1];
        const modMap = { ctrl: 2, control: 2, shift: 4, alt: 1, meta: 8, command: 8, cmd: 8, win: 8 };
        let modifiers = 0;
        for (const p of parts.slice(0, -1)) modifiers |= modMap[p.toLowerCase()] ?? 0;

        // CDP expects the DOM key name (e.g. "Enter", "Tab", "Escape", "ArrowUp")
        const keyNameMap = {
          enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape",
          backspace: "Backspace", delete: "Delete", del: "Delete",
          up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
          home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
          f1:"F1",f2:"F2",f3:"F3",f4:"F4",f5:"F5",f6:"F6",f7:"F7",f8:"F8",
          f9:"F9",f10:"F10",f11:"F11",f12:"F12",
          space: " ", " ": " ",
        };
        const cdpKey = keyNameMap[mainKey.toLowerCase()] ?? mainKey;

        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyDown", key: cdpKey, modifiers,
          text: cdpKey.length === 1 && !modifiers ? cdpKey : "",
        });
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyUp", key: cdpKey, modifiers,
        });
        const ctx = await tabContext();
        return { ok: true, action, key: combo, result: `Pressed key: ${combo}\n${ctx}` };
      }

      // ── Scroll ───────────────────────────────────────────────────────
      case "scroll": {
        const dir    = scroll_direction ?? "down";
        const amount = scroll_amount ?? 3;
        const TICK   = 100; // px per tick (matches typical browser line-height)
        const deltaX = dir === "left" ? -(amount * TICK) : dir === "right" ? (amount * TICK) : 0;
        const deltaY = dir === "up"   ? -(amount * TICK) : dir === "down"  ? (amount * TICK) : 0;

        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX, deltaY,
        });
        const ctx = await tabContext();
        return {
          ok: true, action, coordinate: [x, y],
          scroll_direction: dir, scroll_amount: amount,
          result: `Scrolled ${dir} by ${amount} ticks at (${x}, ${y})\n${ctx}`,
        };
      }

      default:
        throw new Error(`unknown computer action: ${action}`);
    }
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch { /* ignore */ }
  }
}

// ─────────────────────────── Pair-on-demand message ───────────────────────────
// Popup pings us whenever it opens so the user sees the paired state the
// instant the Mac app starts, without waiting for the next reconnect timer.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "try_pair") {
    (async () => {
      const { port } = await getConfig();
      const token = await tryAutoPair(port);
      if (token) {
        if (ws) try { ws.close(); } catch {}
        connect();
      }
      sendResponse({ ok: !!token });
    })();
    return true;
  }
  if (msg?.type === "reconnect") {
    if (ws) try { ws.close(); } catch {}
    connect();
    sendResponse({ ok: true });
    return false;
  }
});

// ─────────────────────────── lifecycle ───────────────────────────

chrome.runtime.onInstalled.addListener(() => { connect(); ensureKeepaliveAlarm(); });
chrome.runtime.onStartup.addListener(() => { connect(); ensureKeepaliveAlarm(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeToken || changes.bridgePort)) {
    // Reconnect with new credentials.
    if (ws) try { ws.close(); } catch { /* ignore */ }
    connect();
  }
});

// ─────────────────────────── MV3 keepalive ───────────────────────────
// MV3 service workers get suspended after ~30s of inactivity, which
// silently drops our WS. Two defenses running in parallel:
//
//   1. chrome.alarms fires every 25s. Each alarm event wakes the SW if
//      it was suspended and re-runs the handler, which reconnects the
//      WS if it's not OPEN. Minimum period in unpacked is 30s, but Chrome
//      rounds ours up and we still get at-most 30s cold windows.
//
//   2. When the WS is open, we also send a "ping" frame every 20s.
//      Incoming messages reset the SW idle timer, so the daemon will
//      write a pong back that keeps us hot between alarm fires.
//
// Either mechanism alone is insufficient — together the extension stays
// connected indefinitely.

const KEEPALIVE_ALARM = "autostore-in-chrome-keepalive";

function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Reconnect if WS is dead; no-op if it's healthy.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  } else {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
  }
});

// Kick it off once at worker boot.
ensureKeepaliveAlarm();
connect();
