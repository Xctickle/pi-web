# Pi Web - Development Notes

> Slimmed 2026-09-15 per context-budget spec (mind `self/spec/context-budget-spec.md`, ≤8KB per AGENTS.md). The full original — complete annotated file map, all design notes & traps, session-format walkthrough — is preserved verbatim at `docs/agents-full-20260915.md`. This file keeps only what every session must know upfront. New knowledge goes here, not into the archive.

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  ├─ GET /api/sessions ─────▶ reads ~/.pi/agent/sessions/ (read-only browse)
  ├─ send message ─▶ POST /api/agent/[id] ─ startRpcSession() ─▶ createAgentSession()
  └─ SSE connect ──▶ GET /api/agent/[id]/events ◀── session.subscribe()
```

Session browsing reads `.jsonl` via SDK `SessionManager` helpers + `lib/session-reader.ts` (no AgentSession created). Sending a message goes through `lib/rpc-manager.ts`, which creates an in-process AgentSession.

## File Map (short)

- `app/api/` — sessions (list/detail/context/export), agent (new/state/events/running), auth (login/logout/api-key/all-providers/providers), models + models-config (catalog/discover/test), skills (get/install/search), plugins, worktrees, files, cwd/validate, default-cwd, async-tasks, backups
- `lib/` — `rpc-manager.ts` (AgentSessionWrapper + registry), `session-reader.ts`, `async-status/async-mutations/async-schedule` (cron kanban read/write/pure-spec), `tool-presets.ts`, `worktree.ts`, `file-access.ts` + `path-security.ts` (file allow-list boundary), `normalize.ts`, `model-scope.ts`, `provider-listing*.ts`, `i18n/`
- `components/` — AppShell, SessionSidebar, ChatWindow/ChatInput/MessageView, AsyncTasksPanel, FileExplorer/FileViewer/TabBar, ModelsConfig/SkillsConfig/PluginsConfig, BranchNavigator, ChatMinimap
- `hooks/` — `useAgentSession` (messages + streaming + SSE + fork/navigate/reconciliation core), useAudio, useDragDrop, useIsMobile, useTheme

Full per-file annotations → `docs/agents-full-20260915.md`.

## Critical Traps (shortlist)

1. **AgentSession lifecycle** (`lib/rpc-manager.ts`): one wrapper per session id keyed in `globalThis.__piSessions` — `globalThis` survives Next.js hot-reload, a plain module-level Map does not. Idle timeout 10 min; concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
2. **Fork must destroy the wrapper immediately**: `AgentSession.fork()` mutates the wrapper in-place — after fork, `inner.sessionId` is the *new* session's id. A wrapper left alive under the old id yields corrupt `parentSession` chains. `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning.
3. **ToolCall normalization**: pi stores `{id,name,arguments}`, our types use `{toolCallId,toolName,input}` — `normalizeToolCalls()` (`lib/normalize.ts`) must be called in BOTH `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).
4. **Paths**: compare with `samePath()`, never `===` (git prints POSIX paths even on Windows; raw equality permanently hid the worktree switcher). The file-access security boundary is `isPathWithinRoots()` in `lib/path-security.ts` — the single implementation behind `isFilePathAllowed()`, keep it that way.
5. **`enabledModels` scoping**: minimatch globs / fuzzy match / `:thinkingLevel` suffix — never compare as literal strings; `lib/model-scope.ts` delegates to SDK `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree, falling back to all models when patterns resolve to nothing.
6. **Async-task mutations** (`lib/async-mutations.ts`): rewrite ONLY one task's crontab block per call (its command lines + directly-preceding comment block, reattached as header); every write keeps a timestamped `crontab.backup-*`; never touch night-guard or unrelated lines. Task names strictly `[a-z0-9][a-z0-9-]*` — that validation is the path-traversal guard for every POST.
7. **Two kinds of branching**: Fork = new independent `.jsonl` file (sidebar child via `parentSession` header field, display metadata only); in-session branch = `navigate_tree` within the same file (`Continue` button / BranchNavigator, context via `/api/sessions/[id]/context?leafId=`).
8. **SSE lifecycle**: never close on the first `agent_end` (retries, compaction, extension-queued messages can continue the same logical run); `prompt_done` completes the UI stage; idle SSE stays open on a 30s grace window. Runs carry a monotonic run id — ignore late responses from old runs so stale streaming bubbles can't resurrect. On mount, if `GET /api/agent/[id]` says `state.isStreaming`, reconnect SSE automatically.
9. **Dual-auth providers** (anthropic, github-copilot today — changes between SDK releases): provider listing is capability-driven (`lib/provider-listing.ts`), never id-driven; after ANY auth change refresh BOTH provider lists or a dual-auth provider renders twice. auth.json holds one credential per provider; deletes go through `removeStoredCredentialIfType()` under pi's auth file lock. Status endpoints must never return raw keys.
10. **Session files can be fully rewritten** — `parentSession` is display metadata only, zero effect on chat content; safe to `writeFileSync` the whole file (pi does this itself; used when cascade-reparenting children on delete).

All remaining traps with full reasoning — compaction event names, sound autoplay unlock, models test route location, worktree dirty-409 + branch-name path rules, plugins/skills toggle surgery, export HTML recursion patch — → `docs/agents-full-20260915.md`.

## Pi Session File Format

`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` — JSONL entry types: `session` (header, incl. `parentSession`), `model_change`, `message` (user/assistant/toolResult), `compaction`, `session_info`. `entryIds[]` in `SessionContext` is a parallel array to `messages[]`, mapping displayed messages back to entry ids (used by fork / navigate_tree). Field-by-field examples → archive.

## CSS Variables (`app/globals.css`)

`--bg --bg-panel --bg-hover --bg-selected --border --text --text-muted --text-dim --accent --user-bg --tool-bg --font-mono`
