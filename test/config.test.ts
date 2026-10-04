import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assistant from "../src/index";
import { loadConfig, applyEnvironment } from "../src/config";

test("configuration validation and reversible process-local overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assistant-config-"));
  const env = { ...process.env };
  try {
    mkdirSync(join(dir, ".pi"));
    const defaults = loadConfig(dir);
    assert.ok(defaults.mode === "local-managed");
    assert.equal(defaults.cdpPort, 19322);
    assert.equal(defaults.gatewayPort, 19377);
    writeFileSync(join(dir, ".pi", "assistant.json"), JSON.stringify({ profile: "profile", gatewayBinary: "gateway" }));
    const config = loadConfig(dir);
    assert.ok(config.mode === "local-managed");
    assert.equal(config.profile, join(dir, "profile"));
    process.env.PI_SEARCH_FETCH_MODE = "auto";
    process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS = '[{"browser":"other","dir":"/tmp/other"}]';
    const applied = applyEnvironment(config);
    assert.equal(process.env.PI_SEARCH_FETCH_MODE, "browser-only");
    assert.equal(JSON.parse(process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS!).length, 2);
    applied.setToken("test-secret");
    applied.restore();
    assert.equal(process.env.PI_SEARCH_FETCH_MODE, "auto");
    assert.notEqual(process.env.PI_SEARCH_BROWSER_TOKEN, "test-secret");
    for (const bad of [{ cdpPort: 1 }, { gatewayPort: 19322 }, { historySource: "bad label" }, { typo: true }]) {
      writeFileSync(join(dir, ".pi", "assistant.json"), JSON.stringify(bad));
      assert.throws(() => loadConfig(dir));
    }
  } finally { process.env = env; rmSync(dir, { recursive: true, force: true }); }
});

test("extension is lazy, injects standing instructions, fails closed, and restores environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assistant-hooks-"));
  const before = process.env.PI_SEARCH_FETCH_MODE;
  const handlers = new Map<string, Function>();
  const emitted: string[] = [];
  const statuses = new Map<string, string>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {}, getAllTools: () => [],
    events: { emit: (channel: string) => emitted.push(channel) },
  };
  const ctx = { cwd: dir, ui: { notify() {}, setStatus(key: string, value: string) { statuses.set(key, value); } } };
  try {
    assistant(pi as any);
    assert.deepEqual(emitted, []);
    handlers.get("session_start")!({}, ctx);
    assert.deepEqual(emitted, []);
    assert.equal(statuses.get("assistant"), "🌐 :19322 brw");
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.assistant, /primary role here is a research partner/);
    assert.match(event.systemPromptOptions.sections.assistant, /not a security/);
    await handlers.get("tool_call")!({ toolName: "browser_history" }, ctx);
    assert.deepEqual(emitted, []);
    const result = await handlers.get("tool_call")!({ toolName: "web_fetch" }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /Update pi-search/);
    const navigation = await handlers.get("tool_call")!({ toolName: "browser_navigate" }, ctx);
    assert.equal(navigation.block, true);
    assert.match(navigation.reason, /updated pi-devtools/);
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "assistant.json"), '{"cdpPort":1}');
    handlers.get("session_start")!({}, ctx);
    assert.equal(statuses.get("assistant"), "🌐 cfg!");
  } finally {
    handlers.get("session_shutdown")!();
    assert.equal(process.env.PI_SEARCH_FETCH_MODE, before);
    rmSync(dir, { recursive: true, force: true });
  }
});
