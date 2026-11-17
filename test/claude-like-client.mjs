// usage: node claude-like-client.mjs <root> <cmd> [args...]
// Speaks to an LSP server the way Claude Code 2.1.326 does: push diagnostics only, full-text didChange then didSave.
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const [root, cmd, ...args] = process.argv.slice(2);
const p = spawn(cmd, args, { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0); const waiters = new Map(); const pushes = []; const serverRequests = [];
p.stdout.on("data", d => { buf = Buffer.concat([buf, d]); for (;;) {
  const h = buf.indexOf("\r\n\r\n"); if (h < 0) return;
  const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1];
  if (buf.length < h + 4 + len) return;
  const m = JSON.parse(buf.slice(h + 4, h + 4 + len)); buf = buf.slice(h + 4 + len);
  if (m.id != null && !m.method) { waiters.get(m.id)?.(m); waiters.delete(m.id); }
  else if (m.method && m.id != null) { serverRequests.push(m.method); send({ jsonrpc: "2.0", id: m.id, result: m.method === "workspace/configuration" ? m.params.items.map(() => null) : null }); }
  else if (m.method === "textDocument/publishDiagnostics") pushes.push({ t: Date.now(), ...m.params });
}});
let stderr = ""; p.stderr.on("data", d => stderr += d);
const exited = new Promise(r => p.on("exit", (code, sig) => r({ code, sig })));
const send = m => { const s = JSON.stringify(m); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
let id = 0; const req = (method, params) => new Promise(res => { const i = ++id; waiters.set(i, res); send({ jsonrpc: "2.0", id: i, method, params }); });
const note = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uri = f => pathToFileURL(`${root}/src/${f}`).href;
const short = u => u.split("/").pop();
const show = (label, since) => {
  const got = pushes.filter(x => x.t >= since && !x.uri.endsWith("tsconfig.json"));
  console.log(`${label}: ${got.length} push(es)`); for (const x of got) console.log(`  ${short(x.uri)} v${x.version}: ${JSON.stringify(x.diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`))}`);
  return got;
};
const ver = { "a.ts": 1, "b.ts": 1 };
const edit = (f, text) => { ver[f]++; note("textDocument/didChange", { textDocument: { uri: uri(f), version: ver[f] }, contentChanges: [{ text }] }); fs.writeFileSync(`${root}/src/${f}`, text); note("textDocument/didSave", { textDocument: { uri: uri(f) } }); };

const rootUri = pathToFileURL(root).href;
await req("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "f" }], capabilities: { textDocument: { publishDiagnostics: { versionSupport: true }, hover: {}, definition: {}, references: {} }, workspace: { configuration: true } } });
note("initialized", {});
const bridgePid = p.pid; const tscPid = execFileSync("pgrep", ["-P", String(bridgePid)]).toString().trim();
console.log(`bridge pid ${bridgePid}, tsc pid ${tscPid}`);

let t = Date.now();
for (const f of ["a.ts", "b.ts"]) note("textDocument/didOpen", { textDocument: { uri: uri(f), languageId: "typescript", version: 1, text: fs.readFileSync(`${root}/src/${f}`, "utf8") } });
await sleep(1500); show("1. open a.ts, b.ts (clean project; Claude Code skips empty pushes)", t);

t = Date.now(); edit("a.ts", 'export const x: string = "one";\n');
await sleep(1500); show("2. edit a.ts so x is a string (only a.ts changed; b.ts open)", t);

t = Date.now(); fs.writeFileSync(`${root}/src/c.ts`, 'export const y: boolean = true;\n');
await sleep(4000); show("3. c.ts changed on disk only, not open (needs TS7 refresh)", t);
console.log(`   server->client requests seen by the client: ${JSON.stringify([...new Set(serverRequests)])}`);

t = Date.now(); edit("a.ts", "export const x: number = 1;\n"); edit("a.ts", "export const x: number = 2;\n");
await sleep(1500); const g = show(`4. two quick edits to a.ts (v${ver["a.ts"] - 1}, v${ver["a.ts"]})`, t);
console.log(`   stale pushes for a.ts (version < ${ver["a.ts"]}): ${g.filter(x => x.uri.endsWith("a.ts") && x.version < ver["a.ts"]).length}`);

if (process.env.STOP === "signal") { process.kill(bridgePid, "SIGTERM"); }
else { console.log("   sending shutdown"); const r = await Promise.race([req("shutdown"), sleep(5000).then(() => "TIMEOUT")]); console.log("   shutdown reply:", JSON.stringify(r)); note("exit"); }
const e = await Promise.race([exited, sleep(5000).then(() => "NO EXIT within 5s")]); await sleep(500);
let alive; try { process.kill(+tscPid, 0); alive = true; } catch { alive = false; }
console.log(`5. stop by ${process.env.STOP === "signal" ? "SIGTERM to the bridge" : "shutdown/exit"}: bridge exit ${JSON.stringify(e)}, tsc ${tscPid} still alive: ${alive}`);
console.log(`stderr: ${JSON.stringify(stderr.trim())}`);
process.exit(0);
