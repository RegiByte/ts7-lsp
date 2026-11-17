#!/usr/bin/env node
// Runs the workspace's own TypeScript 7 language server (`tsc --lsp --stdio`) for Claude Code.
//
// TS7 answers file diagnostics only when pulled (textDocument/diagnostic) and pushes
// publishDiagnostics for tsconfig files alone; Claude Code only listens for pushes. So every
// frame is relayed unchanged, and whenever the documents may have changed the bridge pulls
// diagnostics for every open document and pushes them, tagged with the version they were
// computed for. "Changed" means a didOpen/didChange/didSave from the client, or the server's
// workspace/diagnostic/refresh, which TS7 sends when files change on disk (it watches them
// itself when the client cannot); the bridge advertises refresh support on the client's
// behalf and answers that request itself.
//
// The pull-and-push design follows Nagato Yuzuru's ts-lsp bridge:
// https://github.com/Nagato-Yuzuru/ts-lsp (plugin/bin/bridge.ts).
//
// stdout is the protocol; anything this script says goes to stderr.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const log = (msg) => process.stderr.write(`ts7-lsp: ${msg}\n`);
const fail = (msg) => {
  log(msg);
  process.exit(1);
};

let pkgJson;
try {
  pkgJson = createRequire(path.join(root, "package.json")).resolve("typescript/package.json");
} catch {
  fail(`no typescript in ${root}/node_modules: run npm ci there`);
}
const { version } = createRequire(import.meta.url)(pkgJson);
if (parseInt(version, 10) < 7) fail(`${pkgJson} is TypeScript ${version}; this server needs 7 or later`);
const getExePath = (await import(pathToFileURL(path.join(path.dirname(pkgJson), "lib/getExePath.js")).href)).default;
const exe = getExePath();
log(`TypeScript ${version} -> ${exe} --lsp --stdio`);

const server = spawn(exe, ["--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
server.on("error", (e) => fail(`could not start ${exe}: ${e.message}`));
server.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => server.kill(sig));

const frame = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

const reader = (onFrame) => {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
      if (!Number.isFinite(len)) throw new Error("LSP frame without Content-Length");
      const end = sep + 4 + len;
      if (buf.length < end) return;
      const raw = buf.subarray(0, end);
      buf = buf.subarray(end);
      onFrame(raw, JSON.parse(raw.subarray(sep + 4).toString()));
    }
  };
};

const withRefreshSupport = (init) => ({
  ...init,
  params: {
    ...init.params,
    capabilities: {
      ...init.params.capabilities,
      workspace: {
        ...init.params.capabilities?.workspace,
        diagnostics: { ...init.params.capabilities?.workspace?.diagnostics, refreshSupport: true },
      },
    },
  },
});

// Claude Code sends a didChange and a didSave per edit, and a write to disk also reaches TS7's
// own watcher: one pull round per burst is enough.
const PULL_DELAY_MS = 30;

const open = new Map(); // uri -> latest version from the client
const pulls = new Map(); // own request id -> { uri, version }
let nextPull = 0;
let pullTimer;
let shuttingDown = false;

const pullOpen = () => {
  pullTimer = undefined;
  if (shuttingDown) return;
  for (const [uri, version] of open) {
    const id = `ts7-lsp:${nextPull++}`;
    pulls.set(id, { uri, version });
    server.stdin.write(frame({ id, method: "textDocument/diagnostic", params: { textDocument: { uri } } }));
  }
};
const schedulePull = () => {
  pullTimer ??= setTimeout(pullOpen, PULL_DELAY_MS);
};

process.stdin.on(
  "data",
  reader((raw, msg) => {
    if (msg.method === "initialize") return void server.stdin.write(frame(withRefreshSupport(msg)));
    server.stdin.write(raw);
    const doc = msg.params?.textDocument;
    switch (msg.method) {
      case "textDocument/didOpen":
      case "textDocument/didChange":
        open.set(doc.uri, doc.version);
        return schedulePull();
      case "textDocument/didSave":
        return schedulePull();
      case "textDocument/didClose":
        return void open.delete(doc.uri);
      case "shutdown":
        shuttingDown = true;
        return void clearTimeout(pullTimer);
    }
  }),
);
process.stdin.on("end", () => server.stdin.end());

server.stdout.on(
  "data",
  reader((raw, msg) => {
    if (msg.method === "workspace/diagnostic/refresh") {
      server.stdin.write(frame({ id: msg.id, result: null }));
      return schedulePull();
    }
    const pull = !msg.method && pulls.get(msg.id);
    if (!pull) return void process.stdout.write(raw);
    pulls.delete(msg.id);
    if (msg.error) return log(`pull for ${pull.uri} failed: ${msg.error.message}`);
    if (msg.result?.kind !== "full" || open.get(pull.uri) !== pull.version) return;
    process.stdout.write(
      frame({
        method: "textDocument/publishDiagnostics",
        params: { uri: pull.uri, version: pull.version, diagnostics: msg.result.items },
      }),
    );
  }),
);
