import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import assistant from "../src/index";

async function harness() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), "assistant-commands-"));
  mkdirSync(join(dir, ".pi"));
  const handlers = new Map<string, Function>();
  let command: any;
  const operations: string[] = [];
  const notices: { message: string; level: string }[] = [];
  let supportsStop = true;
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (_name: string, cmd: any) => { command = cmd; },
    getAllTools: () => [],
    events: { emit(channel: string, request: any) {
      if (channel === "pi-devtools:capabilities:v1" && supportsStop) request.result = { managedStop: true };
      if (channel === "pi-devtools:runtime:v1") {
        operations.push(request.operation);
        request.result = Promise.resolve(null);
      }
      if (channel === "pi-search:capabilities:v1") request.result = { browserOnly: true };
    } },
  };
  const ctx = {
    cwd: dir, hasUI: true, waitForIdle: async () => {},
    ui: {
      notify(message: string, level: string) { notices.push({ message, level }); }, setStatus() {},
      confirm: async (_title: string, _message: string) => true,
    },
  };
  assistant(pi as any);
  return {
    dir, command, ctx, operations, notices,
    set supportsStop(value: boolean) { supportsStop = value; },
    start(mode: "external" | "local-managed") {
      const config = mode === "external"
        ? { mode, gatewayUrl: "http://browser.example:8377", tokenEnv: "TEST_ASSISTANT_TOKEN" }
        : { mode, profile: join(dir, "profile"), gatewayBinary: join(dir, "gateway"), gatewayPort };
      writeFileSync(join(dir, ".pi/assistant.json"), JSON.stringify(config));
      handlers.get("session_start")!({}, ctx);
      notices.length = 0;
    },
    close() { handlers.get("session_shutdown")!(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("command autocomplete and usage follow the active mode; external lifecycle commands never execute", async () => {
  const before = { ...process.env };
  process.env.TEST_ASSISTANT_TOKEN = "fixture-token";
  const h = await harness();
  try {
    assert.deepEqual(h.command.getArgumentCompletions("").map((a: any) => a.value), ["status", "show"]);
    h.start("local-managed");
    assert.deepEqual(h.command.getArgumentCompletions("").map((a: any) => a.value), ["status", "show", "start", "stop", "restart"]);
    assert.deepEqual(h.command.getArgumentCompletions("st").map((a: any) => a.value), ["status", "start", "stop"]);
    assert.equal(h.command.getArgumentCompletions("stop extra"), null);
    assert.equal(h.command.getArgumentCompletions("unknown"), null);
    h.start("external");
    assert.deepEqual(h.command.getArgumentCompletions("").map((a: any) => a.value), ["status", "show"]);
    for (const action of ["start", "stop", "restart"]) {
      await h.command.handler(action, h.ctx);
      assert.match(h.notices.at(-1)!.message, /only available in local-managed mode/);
      assert.equal(h.notices.at(-1)!.level, "error");
    }
    await h.command.handler("invalid", h.ctx);
    assert.equal(h.notices.at(-1)!.message, "Usage: /assistant [status|show]");
    assert.deepEqual(h.operations, []);
    assert.deepEqual(readdirSync(h.dir), [".pi"]);
  } finally { h.close(); process.env = before; }
});

test("local stop requires compatible devtools, confirms shared impact, and never launches on stop", async () => {
  const h = await harness();
  try {
    h.start("local-managed");
    h.supportsStop = false;
    await h.command.handler("stop", h.ctx);
    assert.match(h.notices.at(-1)!.message, /Update pi-devtools/);
    assert.deepEqual(h.operations, []);
    h.supportsStop = true;
    h.ctx.ui.confirm = async (_title, message) => {
      assert.match(message, /ALL conversations/);
      return false;
    };
    await h.command.handler("stop", h.ctx);
    await h.command.handler("restart", h.ctx);
    assert.deepEqual(h.operations, []);
    h.ctx.ui.confirm = async () => true;
    await h.command.handler("stop", h.ctx);
    assert.deepEqual(h.operations, ["status", "stop"]);
    assert.match(h.notices.at(-1)!.message, /are stopped/);
    assert.deepEqual(readdirSync(h.dir), [".pi"]);
    await h.command.handler("stop", h.ctx);
    assert.deepEqual(h.operations, ["status", "stop", "status", "stop"]);
  } finally { h.close(); }
});

test("a session switch during confirmation cancels shutdown", async () => {
  const h = await harness();
  try {
    h.start("local-managed");
    h.ctx.ui.confirm = async () => { h.start("local-managed"); return true; };
    await h.command.handler("stop", h.ctx);
    assert.deepEqual(h.operations, []);
    assert.match(h.notices.at(-1)!.message, /session changed/);
  } finally { h.close(); }
});
