# autostore-in-chrome

> ## 🧠 Knowledge Distillation Strategy
>
> AutoStore's architectural bet: encode every workflow as a deterministic macro tool so weak models (qwen-plus, glm-4-flash) only need intent matching — multi-step reasoning is pre-computed by Claude offline.
>
> Before ending any session, read:
> - `rules/KNOWLEDGE_DISTILLATION_STRATEGY.md` — the master plan + macro roadmap
> - `rules/CONTRIBUTING_PLATFORM_KNOWLEDGE.md` — where each kind of knowledge belongs
> - `rules/COMPUTER_USE_STRATEGY.md` — annotated screenshots + macro-tool rationale
>
> **Rule:** if you spent 3+ tool calls on a workflow that could be one macro, encode it in `mac/AutoStore/Sources/Services/PlatformKnowledge.swift` + register the tool in `LocalLLMService.swift` before committing. Push so the next AutoStore release ships with that knowledge.


**Chrome extension + local HTTP/WS server that lets the AutoStore app drive
the user's real Chrome** — no separate Playwright browser, no cookie
transplant, no fresh logins. Alongside `browser-mcp` (which gives a *scripted*
Chromium), this gives AutoStore the user's *actual* Chrome with all its
existing sessions (1688, eBay, Amazon, Etsy, …).

> ## ⚠️ The shipped server is NATIVE SWIFT, in-process (2026-06-11)
> A user's AutoStore is **Swift + macros only — no Node, no Go, no child
> process**. The loopback HTTP+WebSocket server now lives inside the Mac app:
> `mac/AutoStore/Sources/Services/InChromeServer.swift` (Network.framework +
> a hand-rolled RFC6455 WebSocket). The app *is* the server the extension
> connects to. Nothing to install or spawn → fixes the whole `-1004` class of
> bugs (no external daemon to be missing, no `node` dependency).
>
> **`daemon/` (Node) and `daemon-go/` (Go) are R&D reference only** — kept as
> the iteration playground / protocol spec. They are NOT shipped to users.
> When you change the wire protocol, change `InChromeServer.swift` (it's what
> ships) and keep the others in sync if you use them for testing.
>
> The HTTP API, wire protocol, and method list below are unchanged — the Swift
> server is byte-compatible with what the extension and `InChromeClient` expect.

## No Claude Code dependency

This project is **NOT** an MCP server. The target users are in mainland
China and cannot reach Claude Code. The daemon exposes a plain
**HTTP + WebSocket API on 127.0.0.1**, and the AutoStore Mac app / backend
call it directly using any LLM provider (DeepSeek, Qwen, Kimi, Zhipu, …).

## When to use which

| | browser-mcp | autostore-in-chrome |
|---|---|---|
| Headless / CI / cron | ✅ | ❌ Chrome must be running |
| Day-to-day listing work alongside a human | OK | ✅ preferred |
| Fresh machine, no login state | ✅ (scripted login helper) | ❌ needs user's Chrome logged in |
| Anti-bot fingerprint | Playwright (gets flagged sometimes) | Real Chrome (never flagged) |
| Reuses 1688 / eBay / Amazon / Etsy logins | ❌ (must re-login per profile) | ✅ zero setup |

AutoStore should try `autostore-in-chrome` first and fall back to
`browser-mcp` when the daemon reports `connected:false`.

## Architecture

```
┌──────────────────┐   HTTP    ┌────────────────────┐   WS    ┌────────────────────┐
│ AutoStore Mac    │ ────────▶ │  daemon (Node)     │ ◀────── │ Chrome extension   │
│ app / backend    │  POST /rpc│  — this repo       │         │ service worker     │
└──────────────────┘           └────────────────────┘         └────────────────────┘
                                        ▲                                │
                                token in ~/.autostore-in-chrome/token    │ chrome.debugger
                                                                         ▼  chrome.tabs
                                                                   user's real tabs
```

Two halves:

1. **daemon/** — Long-running Node process. Listens on `127.0.0.1:43117`.
   - HTTP: `POST /rpc` (bearer token) and `GET /health` (unauthenticated).
   - WS: `/ws` — the Chrome extension's service worker connects here.
   - Token is auto-generated on first run under `~/.autostore-in-chrome/token`
     (0600 perms). Never binds to 0.0.0.0.
2. **extension/** — MV3 Chrome extension. Service worker connects to the
   daemon on 127.0.0.1 with the token. Handles RPC calls by dispatching
   to `chrome.tabs`, `chrome.scripting`, `chrome.debugger`.

## HTTP API

### `GET /health` (no auth)

```json
{
  "ok": true,
  "daemonVersion": "0.1.0",
  "extension": { "connected": true, "connectedSinceMs": 12453, "pendingCalls": 0 },
  "methods": ["daemon_status", "list_open_tabs", "snapshot", "click"]
}
```

Use this for UI status indicators and for probing whether the extension is live.

### `POST /rpc` (bearer token required)

```bash
TOKEN=$(cat ~/.autostore-in-chrome/token)
curl -s http://127.0.0.1:43117/rpc \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"method":"list_open_tabs","params":{"urlContains":"1688.com"}}'
```

Response shape:

```json
{ "ok": true, "result": [ { "tabId": 42, "url": "...", "title": "..." } ] }
// or
{ "ok": false, "error": "AutoStore Chrome extension is not connected..." }
```

## Built-in methods

| Method | Params | Purpose |
|---|---|---|
| `daemon_status` | — | Answered locally by the daemon — is the extension connected? |
| `list_open_tabs` | `{ urlContains?: string }` | Every tab in the user's Chrome, optionally filtered. |
| `snapshot` | `{ tabId: number }` | ARIA accessibility tree of a tab (compact YAML-ish). |
| `click` | `{ tabId: number, selector: string }` | Click a single CSS-selected element. |

Add a new method in two steps:
1. Add a zod schema in `daemon/src/rpc.ts`.
2. Add a `case` in `extension/service-worker.js → dispatch()`.

## Wire protocol (daemon ⇄ extension, over WS)

Symmetric JSON messages:

```ts
{ type: "hello", token, chromeVersion }            // extension → daemon
{ type: "hello-ack", daemonVersion }               // daemon → extension
{ type: "rpc-request", id, method, params }        // daemon → extension
{ type: "rpc-response", id, ok, result|error }     // extension → daemon
```

## Setup

### Daemon

```bash
cd daemon
npm install
npm run build
node dist/index.js
# [daemon] autostore-in-chrome v0.1.0 listening on 127.0.0.1:43117
```

Auto-start on macOS login:

```bash
# Edit scripts/com.autostore.in-chrome.plist and replace the two paths
# (node binary + absolute path to daemon/dist/index.js)
mkdir -p ~/Library/LaunchAgents
cp scripts/com.autostore.in-chrome.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.autostore.in-chrome.plist
```

### Extension (dev — unpacked)

1. `chrome://extensions/` → **Developer mode** ON
2. **Load unpacked** → pick `in-chrome/extension/`
3. Click the extension icon in the toolbar → popup opens
4. Paste the token from `cat ~/.autostore-in-chrome/token` → Save & connect
5. Badge goes green (**ON**)

## Security

- HTTP + WS bind **127.0.0.1 only**. Loopback is the trust boundary.
- Token is 32-byte random hex, 0600 perms. Both daemon and extension must
  present it — wrong token closes the socket / returns 401.
- Extension has `debugger` permission, which Chrome flags to the user at
  install time (yellow "Debugging" banner across the top). That's the
  price for CDP access — same permission Playwright uses.
- No TLS. Loopback doesn't need it, and adding certs would only burden
  the user.

## Mac app integration

The AutoStore Mac app is the natural installer:
- Bundles extension (as `.crx` or install instructions) + daemon binary.
- Installs the launchd plist on first run so the daemon auto-starts.
- Shows the token in a copy-to-clipboard UI for the user to paste into the
  extension popup once.
- Polls `GET /health` for the main-window status badge.

## File layout

```
in-chrome/
  daemon/
    src/
      index.ts         — entry: load token, start server, wait
      server.ts        — HTTP (POST /rpc, GET /health) + WS upgrade
      rpc.ts           — method registry + zod param schemas
      extension-bus.ts — manages WS from the Chrome extension
      handshake.ts     — token + port, wire message types
    package.json
    tsconfig.json
  extension/
    manifest.json     — MV3, minimal permissions
    service-worker.js — WS client + chrome.* dispatchers
    popup.html
    popup.js          — token/port config UI
    icon128.png
  scripts/
    com.autostore.in-chrome.plist  — launchd user agent template
  CLAUDE.md
  .gitignore
```
