# LobeHub Probe & Mock Guide

This is the project-layer entry point for LobeHub acceptance probes. Read it
together with the agent-testing skill's generic `references/probe-mock-patterns.md`.
Product-independent rules belong upstream; LobeHub routes, stores, services, env
variables, and fixtures belong here.

## Choose the least invasive mechanism

1. **Use a supported command** in `scripts/app-probe.sh` for read-only app state.
2. **Use a public store action or API** when the behavior must execute real product
   logic.
3. **Use an agent-runtime hook** for tool-call mocks. `beforeToolCall` is the
   supported mock boundary; browser HMR patches are not the default for runtime
   tools.
4. **Use a narrowly scoped temporary injection** only when no stable boundary
   exists. Snapshot dirty files first, mark the injection, and prove exact cleanup.
5. **Use the historical field notes** for rare environment or renderer failures.

Never infer a passed UI state from a state probe alone. A visual claim still needs
an opened and inspected screenshot.

## Supported probes

```bash
PROBE=.agents/acceptance/scripts/app-probe.sh

$PROBE ready                      # app root + exposed-store readiness
$PROBE auth                       # renderer auth state
$PROBE server-auth                # authenticated server request (200 vs 401)
$PROBE route                      # current SPA route
$PROBE stores                     # exposed store names
$PROBE ops                        # chat operation summary
$PROBE wait-ops [timeout-seconds] # wait until no operation is running
$PROBE topic                      # active topic + metadata from the paged view
$PROBE goto /settings             # full navigation, then report route
$PROBE errors-install             # begin console.error capture
$PROBE errors                     # read captured console errors
```

Target Electron by default. For a web session:

```bash
AB_TARGET="--session lobehub-dev" $PROBE ready
```

Prefer `server-auth` over `document.cookie`: Better Auth session cookies are
HttpOnly, so an empty `document.cookie` does not establish signed-out state.

## Decision table

| Goal                               | Preferred boundary                         | Notes                                                          |
| ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Confirm app/store mount            | `app-probe.sh ready`                       | Distinguishes an unmounted shell from a ready SPA              |
| Confirm identity                   | `auth` then `server-auth`                  | Renderer state and server session are separate claims          |
| Inspect a running agent turn       | `ops` / `wait-ops`                         | Proves operation state, not which server runtime executed      |
| Read active topic metadata         | `topic`                                    | `topicDataMap` is keyed by `agent_<id>`, not topic id          |
| Render message-attached error UI   | In-memory chat dispatch                    | Safe when the temporary message has a unique id and is deleted |
| Force a tool result                | `beforeToolCall` hook + `event.mock()`     | Local/in-memory hook mode only                                 |
| Force a fetch failure              | Request boundary or narrow HMR injection   | Preserve dirty files byte-for-byte                             |
| Verify first-load error            | Clear the relevant cache tier, then reload | A failed revalidation may intentionally keep settled data      |
| Diagnose Electron target confusion | CDP target list / raw CDP                  | Use a distinct agent-browser session per CDP port              |
| Seed backend fixtures              | Public API first, raw SQL last             | Raw SQL must preserve product id and relation invariants       |

## Project-specific recipes

### Message-attached heterogeneous-agent errors

Inject a temporary assistant message through
`chat().internal_dispatchMessage`, then attach an `AgentRuntimeError`. Supported
guide codes are `auth_required`, `cli_not_found`, `overloaded`, and `rate_limit`;
other values follow the generic error path. Use a unique content marker, verify the
real rendered card, and delete the temporary message afterward.

### Infinite-scroll failure states

When the fixture is too short for the observer to fire, call the real load-more
store action rather than pretending to scroll. This covers the request, catch
path, and rendered retry row; it does not prove the observer gate itself. Use a
scrollable fixture when the observer behavior is the claim.

### Store exposure

`window.__LOBE_STORES.<name>` is a function returning the current state. Call it:

```js
window.__LOBE_STORES.chat();
```

It intentionally does not expose Zustand's `getState` or `setState`. If a test
repeatedly needs mutation, add a dev-only supported action or fixture command
instead of normalizing temporary `setState` HMR patches.

### Runtime proof

Client and server agent runtimes can produce the same visible result. Prove the
runtime with a server-only artifact: operation row, queue step, or enabled
main/server log namespace. Renderer state alone is not sufficient.

### Locale regression tests and desktop resource scanning

**Situation:** a locale-copy change needs a focused regression assertion while
the Electron dev renderer imports locale resources from the default resource tree.

**Doesn't work:** placing `*.test.ts` beside files in
`packages/locales/src/default/`. The desktop resource scan can include that module
in the renderer graph, which makes Vite optimize and execute `vitest` in the app.

**Works:** keep the assertion under the consuming feature's test directory and
import the locale resource there. Restart the isolated Electron instance after a
bad scan because the optimized dependency graph can remain poisoned.

## Detailed references

- [Probe field notes](./references/probe-field-notes.md) — all historical
  LobeHub findings, original identifiers, commands, and failure analysis.
- [Auth](./references/auth.md) — per-surface auth injection and recovery.
- [Dev server](./references/dev-server.md) — local stack and restart behavior.
- [Multi-instance Electron](./references/multi-instance.md) — pool, ports, CDP
  sessions, and user-data isolation.
- [Agent gateway](./references/agent-gateway.md) — closed-loop gateway probes.

## Adding a new learning

- Add a command or option to `app-probe.sh` when the probe is read-only,
  repeatable, and has a stable output contract. Add a smoke test with it.
- Add a concise recipe here when it is a recurring decision or supported
  mechanism.
- Add a field note only for a narrow incident, including Situation / Doesn't
  work / Works and evidence for every mechanism claim.
- Promote product-independent findings to the generic skill layer rather than
  duplicating them here.

## Seeded workspace agents: RBAC roles + real API creation are both required

- **Situation:** verifying workspace UI with a hand-seeded workspace (raw SQL
  inserts into `workspaces` / `workspace_members` / `agents`).
- **Doesn't work:** topics load but `agent.getAgentConfigById` fails FORBIDDEN —
  the cloud RBAC middleware reads `rbac_user_roles → roles → role_permissions →
permissions`, which raw member rows never create. And even after RBAC, a raw
  SQL `agents` row renders "助理不可用" (missing real config).
- **Works:** ① provision RBAC with the official util —
  `seedWorkspaceRoles(db, wsId)` + `assignWorkspaceRoleToUser(...)` from
  `packages/database/src/utils/seedWorkspaceRoles.ts` (run with bun from inside
  `packages/database`); ② create agents through the real API from the authed
  page (`POST /trpc/lambda/agent.createAgent` with the `X-Workspace-Id` header,
  `visibility: 'public' | 'private'`), then repoint seeded topics' `agent_id`.

## Duplicate @lobehub/ui instances crash the conversation route in dev

- **Situation:** after a floating-range `pnpm install` (this repo has no
  lockfile), `node_modules/.pnpm` can hold two `@lobehub/ui@X` peer-hash
  instances. The workspace agent conversation route then dies in the error
  boundary with `Please wrap your app with <ConfigProvider> (or <MotionProvider>)` thrown from `TypewriterEffect` — the two instances carry
  two React contexts. The sidebar-only routes may still work, which disguises
  the cause; clearing `node_modules/.vite` does NOT fix it.
- **Doesn't work:** clearing the Vite deps cache, restarting the dev server,
  `pnpm dedupe @lobehub/ui` (peer sets differ, instances survive).
- **Works:** temporarily add `resolve: { dedupe: ['@lobehub/ui', 'antd-style',
'motion', 'react', 'react-dom'] }` to the cloud root `vite.config.ts` +
  `rm -rf node_modules/.vite`, and REVERT the config after capturing evidence
  (snapshot the file first — it may carry uncommitted edits).

### C15. Desktop dev renderer dies on canary when `apps/desktop/stubs/types` lags `packages/types`

- **Situation**: `electron-dev.sh start` reaches CDP but the SPA never becomes interactive;
  `/tmp/electron-dev.log` shows `SyntaxError: The requested module '/apps/desktop/stubs/types/src/index.ts'
does not provide an export named 'MAX_ANALYSIS_...'`.
- **Doesn't work**: waiting longer, reinstalling deps, or reloading — the stub file genuinely lacks
  exports that canary code now imports (the stub is hand-synced and drifts).
- **Works**: snapshot the stub (`cp ... /tmp/...bak`), append the missing `export const` lines copied
  from `packages/types` (grep the missing name there for the real value), reload, and RESTORE the stub
  at teardown. PR #17436 removes the stub entirely; delete this entry once it lands.

### C16. agent-browser daemon hangs against Electron CDP — fall back to raw CDP over `ws`

- **Situation**: mid-run, every `agent-browser --cdp 9222` call (eval/snapshot/fill) times out while
  `curl http://localhost:9222/json` answers instantly — the daemon connection is wedged, not the app.
- **Doesn't work**: retrying agent-browser commands; they queue behind the wedged connection.
- **Works**: a \~30-line node script (repo has `ws`) that picks a target from `/json` by URL substring
  and speaks `Runtime.evaluate` (`awaitPromise:true, returnByValue:true`) / `Page.captureScreenshot`
  directly. Key targets: the SPA renderer is `app://renderer/...`; each in-app-browser page
  (WebContentsView) is its OWN page target (match by its site URL). See
  `.records/guest-eval.mjs` / `.records/guest-shot.mjs` from the 2026-07-22 browser-panel run.
- **Evidence caveat**: a renderer-target `Page.captureScreenshot` does NOT contain WebContentsView
  content (black hole where the page is), and the guest target's screenshot contains ONLY the page.
  For a composite (panel chrome + embedded page + in-page overlays) use OS capture with the window
  bounds from System Events: `screencapture -x -R"x,y,w,h"` — works even when the window sits on a
  secondary display at negative coordinates (where `capture-app-window.sh` fails with "could not
  create image from window").

### C17. Signing Electron into the LOCAL dev server (OIDC), fully agent-driven

- **Situation**: recreated test DB (or fresh profile) → Electron signed out; the saved snapshot's
  refresh token fails `signature verification failed`; the app must log into `localhost:3010`.
- **Doesn't work**: `requestAuthorization({ storageMode: 'cloud' })` — that targets production
  app.lobehub.com. Also the plain dev server rejects `/oidc/auth` with "OIDC is not enabled".
- **Works**, end to end:
  1. Dev server needs `JWKS_KEY` (that is what flips `ENABLE_OIDC`): generate once with
     `node scripts/generate-oidc-jwk.mjs`, export, restart dev.
  2. Restart Electron with `DEBUG='controllers:AuthCtr*'` — in dev, `logger.info` only reaches the
     terminal via the `debug` namespace, and the log line `Constructed authorization URL: ...` is the
     only place to harvest the PKCE authorize URL (shell.openExternal races it into the user's
     default browser, which just bounces to signin).
  3. FIRST write the target into the app config — `remoteServerService.setRemoteServerConfig({
active: true, remoteServerUrl: 'http://localhost:<port>', storageMode: 'selfHost' })` — THEN
     trigger `requestAuthorization({ storageMode: 'selfHost', remoteServerUrl: ... })` via CDP eval.
     `requestAuthorization` success only sets `active: true`; it never writes `remoteServerUrl`, so
     without the explicit config write the BackendProxy keeps routing every renderer call to the OLD
     server (symptom: main log says "Authorization successful" + token valid, renderer stays signed
     out, and the 401/502 stack paths point at the wrong repo's `.next/dev`). Grep the authorize URL
     from `/tmp/electron-dev.log`, open it in the seeded web session, click 确认登录；the consent is
     remembered, so later rounds complete without a click. Note the 60s polling window — if the web
     session must first do a full password login, the handoff times out; warm the session before
     triggering. After config + auth, reload the renderer; `app-probe.sh auth` flips signed-in.
  4. The desktop app expects the backend at a FIXED `localhost:3010`; if `init-dev-env.sh` allocated a
     different port, pin `ALLOC_SERVER_PORT=3010` in `.records/env/agent-testing-ports.env` and restart.

### C18. React 19 UI ignores bare `el.click()` from CDP — dispatch the full pointer sequence

- **Situation**: driving LobeHub UI (ActionIcon, dropdown items) via `Runtime.evaluate`; `el.click()`
  silently does nothing (no handler fires, no error).
- **Works**: dispatch `pointerdown → mousedown → pointerup → mouseup → click` (all
  `{bubbles:true, cancelable:true, view:window}`, PointerEvent for pointer\*). This is what the
  browser-panel run used for the camera button, the "+" dropdown trigger, and its menu items.

### C19. Legacy `electron-dev.sh start` runs on the USER'S OWN dev profile — and parallel sessions fight over ports and dev servers

- **Situation**: two agent-testing sessions (different worktrees/repos) run at the same time on one
  machine; or a run mutates login state that later turns out to belong to the user.
- **What bites**:
  1. **Legacy (no-instance-id) `electron-dev.sh start` uses the default userData**
     (`~/Library/Application Support/lobehub-desktop-dev`) — the user's own dev-app profile, not an
     isolated copy. Any selfHost re-auth you drive overwrites their `dataSyncConfig` and tokens.
     Prefer the pool form (`start <id>`), which copies login state into an isolated dir; if legacy
     mode was used, tell the user their dev-app login/server config was changed.
  2. **Cross-session port fights**: each workspace allocates ports independently from the same bases
     (3010/9876/5173), so two sessions can end up killing each other's listeners — the visible
     symptom is your `bun run dev` tree dying with SIGTERM ("Polite quit request") seconds-to-minutes
     after start, repeatedly, with no error of its own. `nohup`/`disown` does not help (the killer
     targets the process, not your task tree).
- **Works**: give YOUR stack unique ports by editing `.records/env/agent-testing-ports.env`
  (`ALLOC_SERVER_PORT`, `ALLOC_SPA_PORT`) to values far from the common bases (e.g. 3111 / 25999),
  restart, and re-point the Electron app at the new server (see C17 step 3). Also check
  `lsof -iTCP:<port>` plus the listener's `ps` cwd before blaming your own code — a listener from
  ANOTHER repo checkout answering on "your" port produces confusing wrong-stack error traces.

### E41. ✅ Electron main crashes with `electron.app undefined` — the agent harness leaks `ELECTRON_RUN_AS_NODE=1`

- **Situation**: `electron-dev.sh start` fails repeatedly; the instance log shows
  `TypeError: Cannot read properties of undefined (reading 'setName')` at `electron.app.setName(...)`
  with a plain `Node.js v24.x` banner, and the dev watcher then tears everything down. Rebuilding
  electron / reinstalling deps does not help; the same script worked in earlier sessions.
- **Cause (measured)**: the Claude Code agent session itself runs under Electron and its shell
  snapshot exports `ELECTRON_RUN_AS_NODE=1`. Every child inherits it, so the spawned Electron
  binary boots as PLAIN NODE — `require('electron')` returns a path string, `electron.app` is
  undefined. Whether a session carries the variable depends on how that session was started,
  which is why the symptom appears "randomly" across sessions.
- **Works**: strip it at the launch site: `env -u ELECTRON_RUN_AS_NODE .agents/acceptance/scripts/electron-dev.sh start <id>`.
  Check `env | grep ELECTRON` FIRST whenever an Electron dev boot dies before any window appears.
- **Also learned this run**:
  - Background holder tasks die when the agent session process cycles (context compaction spawns a
    new process and reaps the old task tree) — every "mystery SIGTERM" of Electron/dev-server today
    traced to session-lifetime, not to sibling sessions or a human. macOS has no `setsid(1)`;
    daemonize with python `os.fork()+os.setsid()` double-fork AND keep the leader alive, or accept
    the session-bound lifetime and re-start per session.
  - Running the full-stack web dev (`init-dev-env.sh dev`) and the desktop instance vite
    concurrently from ONE worktree makes both optimizers share `<root>/node_modules/.vite` —
    two cold optimizers clobber each other and dynamic imports 504 (`Outdated Optimize Dep`)
    indefinitely. Boot them sequentially (let one finish bundling before starting the other).

### Concurrent agent-browser cleanup must stay session-scoped

- **Situation:** A follow-up Web verification starts while unrelated
  `agent-browser` sessions are also running on the same machine. New sessions
  may hang if another task is concurrently restarting its browser daemon.
- **Doesn't work:** Running `agent-browser close --all` or killing every
  `agent-browser`/Chrome process. That destroys unrelated verification work and
  can race with another task recreating the daemon.
- **Works:** Close only the exact session names created by the current run,
  wait for the competing daemon restart to settle, then create one fresh,
  uniquely named session and reload the seeded auth state.

### E42. A dev server launched as a SANDBOXED background task gets SIGTERM-reaped \~1–2 min in — launch it unsandboxed

- **Situation**: starting `init-dev-env.sh dev` / bare `bun run dev` as a background task from an
  agent harness whose Bash tool sandboxes commands by default. The server boots, serves a few
  requests, then dies with exit 143; bun logs `terminated by signal SIGTERM (Polite quit request)`.
  Reproduced 3× in one run (recorded-PID path, bare unrecorded launch — both die), which
  masquerades as "another session keeps killing my server" when a parallel run is also active.
- **Doesn't work**: escaping the shared PID bookkeeping (bare `bun run dev` instead of the script)
  — the killer is not `stop-dev`; the sandbox supervisor reaps the background task's process tree
  shortly after the spawning tool call returns. Also note the kill can land mid-write and corrupt
  `.next` (E20 follows: /signin 307 ping-pong, auth POST without set-cookie).
- **Works**: launch the long-lived dev server with sandboxing disabled for that one command
  (e.g. the harness's dangerously-disable-sandbox flag). Measured: the same command that died
  at \~1–2 min three times survived 60s+ probes and the whole run once unsandboxed.
