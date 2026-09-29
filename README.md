# pi-assistant

A browser-first research and personal-assistant workspace for pi. Coordinates
**pi-devtools**, **pi-search**, **pi-browser-history**, and **browser-fetch**;
it does not replace their tools or implement another browser engine.

## Behavior

Local-managed mode is the default; existing configurations remain valid. In this mode:

- Chrome launches on first live-browser operation, not at pi startup. On macOS it
  launches without desktop activation or a startup window; the first window is
  created minimized. Tabs/worker tabs stay in the background. `/assistant show`
  deliberately restores and brings the window forward for login/MFA or inspection.
- Dedicated profile: `~/.local/share/pi-assistant/chrome-profile`.
- Loopback CDP **19322**, gateway **19377**; separate from ordinary Chrome and
  debugging on 9222. Unknown listeners are rejected, never silently adopted.
- All conversations using this configuration share one detached Chrome/gateway.
  Each conversation gets its own interactive tabs; fetch workers use separate tabs.
- Cookies, local storage and history persist. Tabs and actions are **not restored**.
  After closing Chrome, the next tool launches it again; the agent reconstructs
  its task and verifies state before acting. Closing pi does not close Chrome.
- All `web_fetch` page retrieval uses the shared Chrome. No direct fallback,
  Markdown negotiation, alternate-URL fetch, or automatic `llms.txt` probe.
  `web_search` still uses the configured public search API.
- `browser_read` reads the current live tab without navigating. It is provided by
  pi-search when pi-devtools is also loaded. DOM controls remain in `browser_dom`.
- Browser history includes a separately labeled `assistant` source, alongside
  ordinary browser profiles. Existing conversation/memory tools retain decisions.

## Local installation

Requires Node 22+, Chrome, and a built browser-fetch binary. Updated local checkouts
of all four projects are required for the integration channels and runtime identity.
Install dependencies in pi-assistant, pi-devtools and pi-search (`npm install`).

```bash
cd ~/projects/browser-fetch
mkdir -p bin
go build -o bin/browser-fetch .

cd ~/projects/discussions/general
# Install components only if not already loaded globally (never load two copies).
pi install -l ~/projects/pi-devtools
pi install -l ~/projects/pi-search
pi install -l ~/projects/pi-browser
pi install -l ~/projects/pi-assistant
```

If pi-search is already loaded as an explicit extension file, keep that mechanism
instead of also installing its package. `/reload` in existing pi sessions.

Add `.pi/assistant.json` in the **working directory**:

```json
{
  "profile": "~/.local/share/pi-assistant/chrome-profile",
  "cdpPort": 19322,
  "gatewayPort": 19377,
  "gatewayBinary": "~/projects/browser-fetch/bin/browser-fetch",
  "historySource": "assistant"
}
```

All fields are optional. The default gateway executable is
`~/.local/bin/browser-fetch`; other defaults match the example. Relative paths
resolve from the working directory. Unknown keys and invalid ports are errors.
Use the same profile and ports in every conversation that should share Chrome.
Do not point this at a personal/default Chrome profile. No tools/processes launch
until needed. Project trust must permit loading the package.

```
/assistant status     # configuration, verified endpoints, history and tool availability
/assistant start      # optional background launch of Chrome and gateway
/assistant show       # explicitly bring Chrome forward (human handoff)
```

You can log into sites in the assistant Chrome window. No passwords or cookies
need to be passed to pi. Human login/MFA/challenge assistance remains interactive.

## External browser / containers

Install the same pi extensions in the agent container, but let the existing
browser-fetch pod own Chrome, its profile PVC, and restarts. **One gateway URL/port**
serves fetch, authenticated CDP (discovery + WebSockets), and native history v2:

```json
{
  "mode": "external",
  "gatewayUrl": "http://browser-fetch.browser-test.svc.cluster.local:8377",
  "tokenFile": "/run/secrets/browser-fetch/token",
  "humanUrl": "https://guacamole.example/"
}
```

Use the gateway's **root token**. Reader/driver tokens deliberately cannot access
raw CDP, history or runtime inspection; the restricted finance session/macro API is
a different capability and is not driven through pi-devtools.

Alternatively omit `tokenFile` and set `PI_ASSISTANT_GATEWAY_TOKEN`, or name a different
variable with `tokenEnv`. No literal token goes in this config. Token files are read
on requests/connections so projected Secret updates can take effect; reload after
changing an environment-sourced token. `gatewayUrl` may include a reverse-proxy path
prefix. See browser-fetch's `-public-url` for discovery behind TLS/path-rewriting proxies.

External mode:
- Derives CDP at `<gatewayUrl>/cdp`, fetch at `/fetch`, history at `/history/sources`
  and `/history/query`. pi-browser parses/ranks/formats locally; the server only reads
  bounded Chromium records.
- Never starts local Chrome/gateway, creates a token, or mounts/discovers the remote
  profile locally. No local fallback when the remote service is unavailable.
- `/assistant start` checks readiness, not Kubernetes lifecycle. `/assistant show`
  selects/restores a remote tab and prints `humanUrl`; it doesn't open a local browser.
- `browser_history` searches only the remote profile sources; it does not silently
  search the agent container or your laptop. No human viewer URL is required for tools.
- Requires updated pi-devtools, pi-search, pi-browser and browser-fetch. Capabilities
  and history protocol v2 are checked before use. An unavailable native history root
  fails explicitly. No Node helper or cross-repository image pin is needed.
- `localhost` in a browser URL refers to the browser pod, not the agent sandbox.

Only **8377** is needed for agent traffic. Existing VNC/Guacamole access remains a
separate optional human path. Chrome's raw CDP stays on browser-pod loopback. No
Yono policy changes are made by this package: grant the intended sandbox access to
the gateway endpoint separately. The shared bearer token grants full browser control,
including cookie access; it is not a read-only or per-tab authorization boundary.

See `../browser-fetch/deploy/kubernetes/README.md` for server/image setup. The agent
image needs the pi packages and Node, not Chrome, Xvfb or a browser-fetch executable.

## Integration contracts

The package applies documented process-local environment settings at session start
and restores them on shutdown/reload; it does not rewrite global pi settings:

- pi-devtools: `PI_DEVTOOLS_CDP_URL`, `PI_DEVTOOLS_PROFILE`, `PI_DEVTOOLS_AUTO_LAUNCH=1`,
  `PI_DEVTOOLS_BACKGROUND=1` (no startup window; macOS LaunchServices background launch).
- pi-search: `PI_SEARCH_FETCH_MODE=browser-only`, `PI_SEARCH_BROWSER_URL`, token,
  180-second fetch budget and 90-second human-assistance budget.
- pi-browser: adds `{browser, dir}` to `PI_BROWSER_HISTORY_CHROMIUM_ROOTS` (JSON array).

Pi event bus channel `pi-devtools:runtime:v1` accepts
`{operation: "ensure" | "status" | "focus", result?: Promise<unknown>}`. The responder sets
`result` synchronously. Missing responder = incompatible/missing pi-devtools.
`ensure` launches only with managed auto-launch enabled, otherwise checks the
external endpoint without launching. `status` probes without launching; `focus`
is an explicit human handoff. pi-search advertises browser-only
support via `pi-search:capabilities:v1`; a missing capability blocks web_fetch.
pi-browser advertises remote history and `historyProtocol: 2` via
`pi-browser:capabilities:v1`. pi-search
uses `pi-devtools:snapshot:v1` for current-tab extraction.
These channels avoid importing private files or relying on shared module instances.

In external mode, the package sets `PI_DEVTOOLS_AUTO_LAUNCH=0`, the remote CDP/fetch/
history endpoints and their `*_TOKEN` or `*_TOKEN_FILE` variables. It does not compare
the server's internal `chrome_url` with the client-facing proxy URL.

browser-fetch's authenticated `GET /runtime` identifies the service and capabilities.
In local mode it also checks the configured Chrome endpoint. Gateway tokens/logs are under `<profile>/.pi-assistant/`, with
owner-only permissions. Cross-process heartbeat locks serialize startup. A crashed
launcher's lock can take about a minute to expire. No watchdog immediately undoes
a manual browser close; reopening occurs only on the next browser operation.

## Privacy and authority

Standing instructions are in `src/assistant.md`, always injected as a system-prompt
section (not a skill the model might forget to load). They prioritize assistant
work, source verification, private-data handling, human authorization, and no action
replay. Pi's generated tool instructions, skill discovery and user addenda remain.
No speculative workflow skills are bundled yet.

**This is not a sandbox or enforced read-only mode.** There are no semantic send/
delete/purchase approval gates yet; clear-authorization rules are model instructions.
Arbitrary JS, shell commands and authenticated UI interaction remain powerful. CDP
stays on browser-host loopback; external mode exposes its authority through the
bearer-authenticated gateway. Another process on the browser host can still reach
raw CDP. A dedicated profile still
contains every account you log into. Rendered content is sent to your model provider;
pi transcripts, history snapshot caches, screenshots and gateway logs can contain
private content. Public API search and non-browser tools are outside browser-only
fetch routing. Use appropriately scoped accounts and explicit task boundaries.

## Development

```bash
npm test
npm run typecheck
npx tsx test/live.ts  # launches temporary-profile Chrome and a gateway; cleans up
```

The live test uses separate ports and synthetic pages, exercises concurrent pi-like
clients and browser restart, and never inspects personal history/accounts. It needs
the adjacent local checkouts and built browser-fetch binary. No model calls.
