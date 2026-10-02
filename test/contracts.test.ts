import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Use the installed host's peer aliases, just as pi does. No second pi install.
const piRoot = process.env.PI_ROOT ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const hostRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
  "@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "typebox": join(piRoot, "node_modules/typebox/build/index.mjs"),
} });

function harness() {
  const bus = new EventEmitter();
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: { on: (name: string, handler: (...args: any[]) => void) => bus.on(name, handler), emit: (name: string, data: unknown) => bus.emit(name, data) },
    registerTool(tool: any) { assert.equal(tools.has(tool.name), false, `duplicate tool ${tool.name}`); tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], registerCommand() {}, registerFlag() {}, getFlag() {},
  };
  return { pi, tools, async start() { for (const handler of handlers.get("session_start") ?? []) await handler({}, {}); } };
}

test("real extension factories register without launching and compose current-tab reading", async () => {
  const devtools = await jiti.import("../../pi-devtools/src/index.ts", { default: true });
  const search = await jiti.import("../../pi-search/src/index.ts", { default: true });
  const standalone = harness();
  search(standalone.pi);
  await standalone.start();
  assert.deepEqual([...standalone.tools.keys()], ["web_search", "web_fetch"]);

  const browser = harness();
  devtools(browser.pi); // registration alone must not connect or launch
  for (const tool of browser.tools.values()) assert.equal(tool.executionMode, "sequential");
  assert.ok(browser.tools.get("browser_tabs").parameters.properties.id);
  const devtoolsCapabilities: any = {};
  browser.pi.events.emit("pi-devtools:capabilities:v1", devtoolsCapabilities);
  assert.equal(devtoolsCapabilities.result.managedStop, true);
  const previousAutoLaunch = process.env.PI_DEVTOOLS_AUTO_LAUNCH;
  try {
    process.env.PI_DEVTOOLS_AUTO_LAUNCH = "0";
    const stop: any = { operation: "stop" };
    browser.pi.events.emit("pi-devtools:runtime:v1", stop);
    await assert.rejects(stop.result, /requires local managed mode/);
  } finally {
    if (previousAutoLaunch === undefined) delete process.env.PI_DEVTOOLS_AUTO_LAUNCH;
    else process.env.PI_DEVTOOLS_AUTO_LAUNCH = previousAutoLaunch;
  }

  const combined = harness();
  combined.tools.set("browser_dom", { name: "browser_dom" });
  search(combined.pi);
  await combined.start();
  await combined.start(); // no duplicate browser_read on session change
  const capabilities: any = {};
  combined.pi.events.emit("pi-search:capabilities:v1", capabilities);
  assert.equal(capabilities.result.browserOnly, true);
  combined.pi.events.on("pi-devtools:snapshot:v1", (request: any) => {
    request.result = Promise.resolve({ url: "https://fixture.example", title: "Live tab", html: "<html><body><article><h1>Live tab</h1><p>Already interacted with.</p></article></body></html>" });
  });
  const read = combined.tools.get("browser_read");
  assert.equal(read.executionMode, "sequential");
  const result = await read.execute("test", { maxChars: 5000 });
  assert.match(result.content[0].text, /Already interacted with/);
  assert.equal(result.details.url, "https://fixture.example");
});
