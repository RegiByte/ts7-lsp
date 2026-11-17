// usage: node handshake.mjs <root> <cmd> [args...]
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const [root, cmd, ...args] = process.argv.slice(2);
const p = spawn(cmd, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
console.error("pid", p.pid);
let buf = Buffer.alloc(0); const waiters = new Map(); const notes = [];
p.stdout.on("data", d => { buf = Buffer.concat([buf, d]); for (;;) {
  const h = buf.indexOf("\r\n\r\n"); if (h < 0) return;
  const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1];
  if (buf.length < h + 4 + len) return;
  const msg = JSON.parse(buf.slice(h + 4, h + 4 + len)); buf = buf.slice(h + 4 + len);
  if (msg.id != null && waiters.has(msg.id) && !msg.method) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  else if (msg.method && msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "workspace/configuration" ? (msg.params.items||[]).map(()=>null) : null });
  else notes.push(msg);
}});
p.stderr.on("data", d => process.stderr.write("[stderr] " + d));
p.on("exit", c => console.error("exit", c));
const send = m => { const s = JSON.stringify(m); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
let id = 0; const req = (method, params) => new Promise((res, rej) => { const i = ++id; waiters.set(i, res); send({ jsonrpc: "2.0", id: i, method, params }); setTimeout(() => rej(new Error("timeout " + method)), 20000); });
const rootUri = pathToFileURL(root).href;
const t0 = Date.now();
const init = await req("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "w" }],
  capabilities: { textDocument: { hover: { contentFormat: ["markdown","plaintext"] }, definition: {}, references: {}, publishDiagnostics: {}, diagnostic: {} }, workspace: { configuration: true, workspaceFolders: true } } });
console.log("initialize ms", Date.now() - t0);
console.log("serverInfo", JSON.stringify(init.result?.serverInfo));
const caps = init.result.capabilities;
console.log("capability keys", Object.keys(caps).join(", "));
console.log("textDocumentSync", JSON.stringify(caps.textDocumentSync), "diagnosticProvider", JSON.stringify(caps.diagnosticProvider));
send({ jsonrpc: "2.0", method: "initialized", params: {} });
// probe: open a file with a deliberate error, ask hover/definition/references/diagnostics
const file = `${root}/src/shared/api.ts`; const uri = pathToFileURL(file).href;
const text = fs.readFileSync(file, "utf8") + "\nconst __probe: number = 'x';\n";
send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text } } });
const lines = text.split("\n"); const ln = lines.findIndex(l => /API_VERSION/.test(l)); const ch = lines[ln].indexOf("API_VERSION") + 2;
console.log("probe symbol line", ln + 1, JSON.stringify(lines[ln].trim().slice(0, 80)));
const pos = { textDocument: { uri }, position: { line: ln, character: ch } };
const hov = await req("textDocument/hover", pos); console.log("hover", JSON.stringify(hov.result?.contents).slice(0, 160));
const def = await req("textDocument/definition", pos); console.log("definition", JSON.stringify(def.result).slice(0, 200));
const refs = await req("textDocument/references", { ...pos, context: { includeDeclaration: true } }); console.log("references count", refs.result?.length, (refs.result||[]).slice(0,4).map(r => r.uri.split("/").slice(-2).join("/")).join(" "));
if (caps.diagnosticProvider) { const d = await req("textDocument/diagnostic", { textDocument: { uri } }); console.log("pull diagnostics", JSON.stringify((d.result.items||[]).map(i => `${i.range.start.line+1}: ${i.message}`))); }
await new Promise(r => setTimeout(r, 3000));
const pushed = notes.filter(n => n.method === "textDocument/publishDiagnostics");
console.log("push diagnostics notifications", pushed.length, JSON.stringify(pushed.map(n => n.params.diagnostics.map(i => `${i.range.start.line+1}: ${i.message}`))).slice(0, 300));
console.log("other notifications", [...new Set(notes.map(n => n.method))].join(", "));
await req("shutdown", null).catch(e => console.log(e.message)); send({ jsonrpc: "2.0", method: "exit" });
setTimeout(() => { if (p.exitCode === null) { p.kill(); console.log("killed"); } process.exit(0); }, 2000);
