/** No model calls or personal profile access. Requires adjacent checkouts + built gateway. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtoolsSession } from "../../pi-devtools/src/session.ts";
import { launchChrome, probe, stopChrome } from "../../pi-devtools/src/launch.ts";
import { fetchReadable, extractFromHtml } from "../../pi-search/src/fetch/fetch.ts";
import { discoverSources } from "../../pi-browser/extension/sources.ts";
import { HistoryStore } from "../../pi-browser/extension/search.ts";
import { parseQuery } from "../../pi-browser/extension/query.ts";
import { applyEnvironment, cdpEndpoint, gatewayEndpoint, runtimeDir, type AssistantConfig, type ExternalAssistantConfig } from "../src/config.ts";
import { ensureGateway, restartGateway, stopGateway, gatewayStatus } from "../src/gateway.ts";
import { searchRemoteHistory } from "../../pi-browser/extension/remote.ts";
import { externalStatus } from "../src/external.ts";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "pi-assistant-live-"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><head><title>Assistant fixture</title></head><body><article><h1>Assistant fixture</h1>
    <p>Cookie: ${req.headers.cookie ?? "none"}</p><p>${"Synthetic readable content. ".repeat(80)}</p>
    <button onclick="document.querySelector('#state').textContent='changed'">Change</button>
    <p id="state">original</p><a href="/next">Next</a></article></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const fixture = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const binary = resolve(root, "../browser-fetch/bin/browser-fetch");
const wrapper = join(temp, "gateway-fixture.sh");
// Only this isolated test permits loopback fixture targets; production remains guarded.
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(wrapper, `#!/bin/sh\nunset BROWSER_FETCH_HISTORY_COMMAND BROWSER_FETCH_MACRO_STORE BROWSER_FETCH_DRIVER_TOKEN BROWSER_FETCH_READER_TOKEN BROWSER_FETCH_ALLOW_HOSTS\nexport PATH=/nonexistent\nexec ${quote(binary)} "$@" -allow-private=true -host-gap=0 -host-jitter=0 -enable-cdp -history-root=${quote(join(temp, "profile"))} -history-source=assistant-test\n`, { mode: 0o700 });
const config: AssistantConfig = {
  mode: "local-managed", profile: join(temp, "profile"), cdpPort: await freePort(), gatewayPort: await freePort(),
  gatewayBinary: wrapper, historySource: "assistant-test",
};
const environment = applyEnvironment(config);
const previousHistoryCache = process.env.PI_BROWSER_HISTORY_CACHE;
process.env.PI_BROWSER_HISTORY_CACHE = join(temp, "history-cache");
const sessions = [new DevtoolsSession(), new DevtoolsSession(), new DevtoolsSession()];
let gatewayPid: number | undefined;
const frontmost = async () => process.platform === "darwin"
  ? (await exec("/usr/bin/lsappinfo", ["front"])).stdout.trim() : "not-macos";
const originalFront = await frontmost();
const focusChanges = new Set<string>();
let samplingFocus = false;
const focusTimer = setInterval(async () => {
  if (samplingFocus) return;
  samplingFocus = true;
  try { const front = await frontmost(); if (front !== originalFront) focusChanges.add(front); }
  finally { samplingFocus = false; }
}, 75);
const check = (message: string) => console.log(`ok   ${message}`);
const child = async (mode: string) => JSON.parse((await exec(join(root, "node_modules/.bin/tsx"),
  [join(root, "test/launch-child.ts"), mode], {
    env: { ...process.env, TEST_ASSISTANT_CONFIG: JSON.stringify(config) }, timeout: 90_000,
  })).stdout.trim());
async function closeChrome(): Promise<void> {
  const v = await probe();
  if (!v) return;
  const browser = await sessions[0].connect();
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.close").catch(() => {});
  for (let i = 0; i < 100; i++) {
    if (!(await probe(200))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Allow a graceful profile flush and release of Chrome's own SingletonLock.
  await new Promise((r) => setTimeout(r, 1500));
}
try {
  const started = await Promise.all([child("chrome"), child("chrome")]);
  assert.equal(started[0].webSocketDebuggerUrl, started[1].webSocketDebuggerUrl);
  const firstIdentity = JSON.parse(await readFile(join(config.profile, ".pi-devtools-runtime.json"), "utf8"));
  check("two processes share one verified Chrome launch");
  const a = await sessions[0].getPage();
  const b = await sessions[1].getPage();
  assert.notEqual(await sessions[0].pageId(a), await sessions[1].pageId(b));
  await a.context().addCookies([{ name: "session", value: "shared", url: fixture, expires: Date.now() / 1000 + 3600 }]);
  await Promise.all([a.goto(fixture), b.goto(fixture)]);
  assert.match(await b.locator("body").innerText(), /session=shared/);
  await a.getByRole("button", { name: "Change" }).click();
  assert.equal(await b.locator("#state").innerText(), "original");
  assert.match(extractFromHtml(await a.content(), a.url(), "markdown").content, /changed/);
  check("independent tabs share login cookies, not form/DOM state; current-tab extraction sees interactions");

  const gateways = await Promise.all([child("gateway"), child("gateway")]);
  assert.equal(gateways[0].pid, gateways[1].pid);
  gatewayPid = gateways[0].pid;
  const running = await ensureGateway(config);
  environment.setToken(running.token);
  check("two processes share one authenticated gateway");
  const fetched = await fetchReadable(fixture);
  assert.match(fetched.content, /session=shared/);
  assert.equal(fetched.llmsTxt, null);
  assert.equal(await a.locator("#state").innerText(), "changed");
  const before = new Set(await Promise.all((await sessions[2].listPages()).map((p) => sessions[2].pageId(p))));
  const c = await sessions[2].getPage();
  assert.equal(before.has(await sessions[2].pageId(c)), false);
  check("browser-only fetch shares cookies without disturbing interactive tabs; no blank worker adoption");

  const priorGatewayPid = gatewayPid;
  const priorTabId = await sessions[0].pageId(a);
  const restartedGateway = await restartGateway(config);
  gatewayPid = restartedGateway.identity.pid;
  assert.notEqual(gatewayPid, priorGatewayPid);
  assert.equal(restartedGateway.token, running.token);
  assert.equal(await sessions[0].pageId(a), priorTabId);
  assert.equal(await a.locator("#state").innerText(), "changed");
  assert.match((await fetchReadable(fixture)).content, /session=shared/);
  check("explicit gateway restart retains Chrome, interactive state and credentials");

  await exec("go", ["test", "-race", "./internal/browser", "-run", "^(TestLivePoolRecovery|TestZZLiveWorkerContext)$", "-count=1", "-v"], {
    cwd: resolve(root, "../browser-fetch"),
    env: { ...process.env, BROWSER_FETCH_TEST_CDP_URL: cdpEndpoint(config), BROWSER_FETCH_TEST_CHROME_URL: cdpEndpoint(config) }, timeout: 120_000,
  });
  assert.equal(await a.locator("#state").innerText(), "changed");
  check("worker context and connection recovery regressions pass without browser restart or action replay; caller cancellation preserves healthy workers");

  await closeChrome();
  await assert.rejects(sessions[0].getPage(), /Browser state reset/);
  const newIdentity = JSON.parse(await readFile(join(config.profile, ".pi-devtools-runtime.json"), "utf8"));
  assert.notEqual(firstIdentity.websocket, newIdentity.websocket);
  // Fetch first: the gateway must also be able to create the initial minimized
  // window without stealing focus, before any interactive client owns a tab.
  const again = await fetchReadable(fixture);
  assert.match(again.content, /session=shared/);
  const recreated = await sessions[0].getPage(true);
  await recreated.goto(fixture);
  assert.match(await recreated.locator("body").innerText(), /session=shared/);
  assert.equal(await recreated.locator("#state").innerText(), "original");
  assert.ok((await recreated.screenshot({ scale: "css" })).length > 1000);
  assert.equal((await ensureGateway(config)).identity.pid, gatewayPid);
  check("restart is explicit, cookies persist, tabs are recreated, and the existing gateway gets a fresh pool");

  const sources = discoverSources({ extraChromiumRoots: [{ browser: "assistant-test", dir: config.profile }], includeDefaults: false });
  assert.equal(sources[0]?.id, "assistant-test");
  const history = new HistoryStore(sources);
  try {
    const result = history.search(parseQuery("Assistant fixture"));
    assert.ok(result.entries.some((entry) => entry.url.startsWith(fixture)));
  } finally { history.close(); }
  check("custom-profile history discovery and querying actual synthetic visits");

  const externalConfig: ExternalAssistantConfig = { mode: "external", gatewayUrl: gatewayEndpoint(config), tokenEnv: "UNUSED", tokenFile: join(runtimeDir(config), "token") };
  let remoteEnvironment = applyEnvironment(externalConfig);
  const remoteA = new DevtoolsSession();
  const remoteB = new DevtoolsSession();
  try {
    assert.equal((await externalStatus(externalConfig)).capabilities.cdp, true);
    assert.equal((await externalStatus(externalConfig)).capabilities.history, true);
    assert.equal((await externalStatus(externalConfig)).historyProtocol, 2);
    const remotePage = await remoteA.getPage();
    const otherPage = await remoteB.getPage();
    assert.notEqual(await remoteA.pageId(remotePage), await remoteB.pageId(otherPage));
    await remotePage.goto(fixture);
    await remotePage.getByRole("button", { name: "Change" }).click();
    assert.equal(await remotePage.locator("#state").innerText(), "changed");
    assert.ok((await remotePage.screenshot({ scale: "css" })).length > 1000);
    const remoteFetch = await fetchReadable(fixture);
    assert.match(remoteFetch.content, /session=shared/);
    assert.equal(await remotePage.locator("#state").innerText(), "changed");
    const remoteHistory = await searchRemoteHistory({ query: "Assistant fixture", browsers: ["assistant-test"] });
    assert.ok(remoteHistory.details.entries.some((e) => e.url.startsWith(fixture)));
    check("one authenticated gateway port serves CDP, fetch, screenshots, interaction and native history (server PATH has no Node)");

    await closeChrome();
    await assert.rejects(remoteA.getPage(), /Cannot reach Chrome/);
    const unchanged = JSON.parse(await readFile(join(config.profile, ".pi-devtools-runtime.json"), "utf8"));
    assert.equal(unchanged.websocket, newIdentity.websocket); // external mode did not launch a replacement
    remoteEnvironment.restore();
    await launchChrome(); // simulate the external supervisor, not the agent
    remoteEnvironment = applyEnvironment(externalConfig);
    await assert.rejects(remoteA.getPage(), /Browser state reset/);
    const fresh = await remoteA.getPage(true);
    await fresh.goto(fixture);
    assert.match(await fresh.locator("body").innerText(), /session=shared/);
    assert.match((await fetchReadable(fixture)).content, /session=shared/);
    check("remote outage never launches locally; CDP rediscovery and fetch recover after an externally owned restart");
  } finally {
    await remoteA.close(); await remoteB.close(); remoteEnvironment.restore();
  }

  const endpoint = process.env.PI_DEVTOOLS_CDP_URL;
  process.env.PI_DEVTOOLS_CDP_URL = fixture; // occupied non-CDP HTTP listener
  try {
    await assert.rejects(launchChrome(), /occupied/);
    await assert.rejects(stopChrome(), /occupied/);
  }
  finally { process.env.PI_DEVTOOLS_CDP_URL = endpoint; }
  check("occupied unrelated debug endpoint is rejected");
  assert.equal((await fetch(`${gatewayEndpoint(config)}/runtime`)).status, 401);
  check("gateway identity is authenticated");

  const identityPath = join(config.profile, ".pi-devtools-runtime.json");
  const validIdentity = await readFile(identityPath, "utf8");
  await writeFile(identityPath, JSON.stringify({ ...JSON.parse(validIdentity), websocket: "ws://wrong-browser" }));
  try { await assert.rejects(stopChrome(), /not the managed Chrome/); }
  finally { await writeFile(identityPath, validIdentity); }
  assert.ok(await probe());
  await sessions[0].getPage(true); // own a tab in the current browser run
  assert.equal(await stopGateway(config), true);
  gatewayPid = undefined;
  assert.equal(await stopChrome(), true);
  assert.equal(await gatewayStatus(config), null);
  assert.equal(await probe(), null);
  assert.equal(await stopGateway(config), false);
  assert.equal(await stopChrome(), false);
  check("explicit shutdown verifies browser identity, stops both services, and is idempotent");
  await assert.rejects(sessions[0].getPage(), /Browser state reset/);
  const afterStop = await sessions[0].getPage(true);
  await afterStop.goto(fixture);
  assert.match(await afterStop.locator("body").innerText(), /session=shared/);
  const resumed = await ensureGateway(config);
  gatewayPid = resumed.identity.pid;
  assert.equal(resumed.token, running.token);
  check("next use relaunches after explicit stop, preserving cookies and reporting lost tab state");
  assert.deepEqual([...focusChanges], [], "background browser work changed the foreground application (or user switched apps during this test)");
  assert.equal(await frontmost(), originalFront);
  check("launch, tab creation, interaction, fetch workers and restart preserve desktop focus");
  console.log("all live checks passed");
} finally {
  clearInterval(focusTimer);
  await closeChrome().catch(console.error);
  for (const session of sessions) await session.close();
  if (gatewayPid) { try { process.kill(gatewayPid, "SIGTERM"); } catch {} }
  server.closeAllConnections();
  server.close();
  environment.restore();
  if (previousHistoryCache === undefined) delete process.env.PI_BROWSER_HISTORY_CACHE;
  else process.env.PI_BROWSER_HISTORY_CACHE = previousHistoryCache;
  await new Promise((r) => setTimeout(r, 500));
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
