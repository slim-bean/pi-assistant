# pi-assistant

Workspace policy and lifecycle glue for pi-search, pi-devtools, pi-browser-history,
and browser-fetch. Keep browser capabilities in those projects; do not duplicate
or register competing tools here. Read README.md before making changes.

- `src/config.ts`: validated `.pi/assistant.json`, environment integration and restoration.
- `src/gateway.ts`: local detached gateway lifecycle; start/stop/restart share a lock.
  Shutdown signals only a freshly authenticated PID; no stale-PID kills or escalation.
  Restart runs the configured binary, never builds/downloads, and retains Chrome.
- `src/external.ts`: authenticated remote service/capability checks. External mode
  never launches processes, creates credentials, or assumes local profile files.
- `src/index.ts`: session hooks, assistant prompt, mode-aware `/assistant` completions.
  Start/stop/restart are local-only; check devtools managedStop support before stop.
  Confirm shared-service impact when UI is available. External mode exposes status/show.
- `src/assistant.md`: always-on behavioral instructions, not an optional skill.
- Inter-extension calls use documented versioned pi.events channels, not private imports.
- Never start sockets/processes in the extension factory. Launch only on browser use.
- One profile/endpoint across pi processes; each conversation owns disposable tabs.
- Never terminate shared services on pi exit. Only explicit local commands may stop
  them; stop is not a persistent pause. Never adopt or terminate an unverified listener.
  Browser shutdown belongs in pi-devtools, accessed through its versioned event API.
- Credentials, runtime logs and profile data stay outside the repo, owner-readable.
- External mode derives all agent interfaces from one gateway URL. Never compare
  its proxied CDP URL to the server's internal Chrome URL. History uses the remote
  native history v2 protocol, never a helper/v1 or silent local fallback. Raw CDP,
  history and runtime inspection require the root token; finance reader/driver
  tokens are intentionally insufficient. Keep tokens out of config/logs.
- No automatic replay/restoration of browser actions. Prompt guidance is not a sandbox.

Run `npm test` and `npm run typecheck`. Live checks in `test/live.ts` use a separate
temporary profile/ports, never the user's normal browser. Keep standalone projects'
defaults intact. No model calls are needed for the test suite.
