# ts7-lsp

A Claude Code plugin that gives TypeScript 7 projects a language server: hover, go to definition, find references,
and the diagnostics Claude Code shows after each edit.

## Why

TypeScript 7 ships no `tsserver.js`, so the official `typescript-lsp` plugin (which runs `typescript-language-server`)
cannot start on a TypeScript 7 workspace. TypeScript 7 has its own language server, `tsc --lsp --stdio`, but it
answers file diagnostics only when the client pulls them (`textDocument/diagnostic`), and Claude Code only listens
for pushed ones (`textDocument/publishDiagnostics`). Running `tsc --lsp` directly gives navigation and no diagnostics.

## How

`bin/ts7-lsp.mjs` resolves the workspace's own `typescript` (from `CLAUDE_PROJECT_DIR`, so each checkout or worktree
uses its own install), requires version 7 or later, and runs its native binary with `--lsp --stdio`. Every message is
relayed unchanged. After each `didOpen`, `didChange` or `didSave`, and whenever the server asks for a
`workspace/diagnostic/refresh` (TypeScript 7 watches files on disk itself), the bridge pulls diagnostics for every
open document and pushes them, tagged with the document version they were computed for. Bursts are coalesced, and
stopping the bridge stops the server.

## Install

```sh
claude plugin marketplace add RegiByte/ts7-lsp
claude plugin install ts7-lsp@ts7-lsp
claude plugin disable typescript-lsp@claude-plugins-official
```

Two plugins cannot both serve `.ts` files, so disable `typescript-lsp`. The workspace needs `typescript` 7 installed
(`npm ci`); the plugin refuses an older one and says so. Restart running sessions to pick it up.

## Tests

`test/claude-like-client.mjs` speaks LSP the way Claude Code does (push only, full-text `didChange` then `didSave`)
against a three-file fixture where `b.ts` uses values from `a.ts` and `c.ts`:

```sh
(cd test/fixture && npm install)
node test/claude-like-client.mjs "$PWD/test/fixture" node "$PWD/bin/ts7-lsp.mjs"
git checkout test/fixture/src
```

It checks that an edit to one file reports errors in another, that a change on disk reaches an open file through the
server's refresh, that no stale version is pushed, and that shutdown leaves no `tsc` running.

## Credits

The bridge's design follows [Nagato-Yuzuru/ts-lsp](https://github.com/Nagato-Yuzuru/ts-lsp).

## License

MIT
