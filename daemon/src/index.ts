#!/usr/bin/env node
/**
 * autostore-in-chrome daemon entry point.
 *
 * Long-running process. Started by the AutoStore Mac app (or `node dist/index.js`
 * for dev). Loads or creates the shared token, opens the loopback server, and
 * waits for a Chrome extension to connect.
 *
 * Port resolution (fixes the "decode failed; body=ok" class of bugs): the
 * preferred port (43117) is frequently taken on a user's Mac by an unrelated
 * local server. Previously `listen()` then threw EADDRINUSE and the daemon
 * exited, leaving the app/extension talking to the stranger. Now we:
 *   1. If the preferred port is free → use it.
 *   2. If it's occupied by ANOTHER AutoStore daemon (GET /health returns our
 *      JSON) → that instance is already serving; exit 0 quietly.
 *   3. If it's occupied by a FOREIGN server → walk up to the next free port.
 * The actual bound port is written to ~/.autostore-in-chrome/port so the Mac
 * client reads it directly and the extension can scan for it.
 */
import { createServer as createNetServer } from "net";
import { request as httpRequest } from "http";
import { loadOrCreateToken, writePort, DEFAULT_PORT } from "./handshake.js";
import { ExtensionBus } from "./extension-bus.js";
import { createDaemonServer } from "./server.js";

const DAEMON_VERSION = "0.1.0";
const PORT_SCAN_RANGE = 13; // try preferred .. preferred+13

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

/** Is the server on `port` one of OUR daemons (so we shouldn't double-start)? */
function isOurDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(typeof j?.daemonVersion === "string");
          } catch {
            resolve(false); // body wasn't our JSON (e.g. a foreign "ok")
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function resolvePort(preferred: number): Promise<number> {
  for (let p = preferred; p <= preferred + PORT_SCAN_RANGE; p++) {
    if (await isPortFree(p)) return p;
    if (await isOurDaemon(p)) {
      process.stderr.write(
        `[daemon] an AutoStore daemon is already running on ${p}; nothing to do\n`,
      );
      // Make sure the port file points at the live instance, then exit clean.
      writePort(p);
      process.exit(0);
    }
    process.stderr.write(
      `[daemon] port ${p} is held by another process; trying ${p + 1}\n`,
    );
  }
  throw new Error(
    `no free port in ${preferred}..${preferred + PORT_SCAN_RANGE} (all held by other apps)`,
  );
}

async function main() {
  const token = loadOrCreateToken();
  const preferred = Number(process.env.AUTOSTORE_IN_CHROME_PORT ?? DEFAULT_PORT);
  const port = await resolvePort(preferred);

  const backendUrl = process.env.AUTOSTORE_BACKEND_URL ?? "https://api.spriterock.com";
  const bus = new ExtensionBus({ token, daemonVersion: DAEMON_VERSION });
  const server = createDaemonServer({ token, port, daemonVersion: DAEMON_VERSION, bus, backendUrl });

  await server.listen();
  writePort(port);

  process.stderr.write(
    `[daemon] autostore-in-chrome v${DAEMON_VERSION} listening on 127.0.0.1:${port}` +
      (port !== preferred ? ` (preferred ${preferred} was busy)` : "") +
      `\n[daemon] token: ~/.autostore-in-chrome/token\n` +
      `[daemon] waiting for Chrome extension...\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[daemon] ${signal} — shutting down\n`);
    bus.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[daemon] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
