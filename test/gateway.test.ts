import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGateway, gatewayStatus, restartGateway, stopGateway } from "../src/gateway";
import { cdpEndpoint, gatewayEndpoint, runtimeDir, type LocalAssistantConfig } from "../src/config";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "assistant-gateway-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const config: LocalAssistantConfig = {
    mode: "local-managed", profile: join(dir, "profile"), cdpPort: 19322, gatewayPort: port,
    gatewayBinary: join(dir, "gateway.cjs"), historySource: "test",
  };
  return { dir, config };
}

// A synthetic authenticated daemon; no Chrome or real profile access.
async function writeDaemon(path: string, revision: string) {
  await writeFile(path, `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const [host, port] = arg('-addr').split(':');
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + process.env.BROWSER_FETCH_TOKEN) {
    res.writeHead(401); res.end('{}'); return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({service: 'browser-fetch', pid: process.pid,
    chrome_url: arg('-chrome-url'), revision: ${JSON.stringify(revision)}}));
});
server.listen(Number(port), host);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o700 });
}

test("gateway stop is lazy/idempotent; restart serializes replacement and picks up the new executable", async () => {
  const { dir, config } = await fixture();
  try {
    assert.equal(await stopGateway(config), false);
    assert.deepEqual(await readdir(dir), []);
    await writeDaemon(config.gatewayBinary, "first");
    const [a, b] = await Promise.all([ensureGateway(config), ensureGateway(config)]);
    assert.equal(a.identity.pid, b.identity.pid);
    await assert.rejects(restartGateway({ ...config, gatewayBinary: join(dir, "missing") }), /executable not found/);
    assert.equal((await gatewayStatus(config))?.pid, a.identity.pid);
    await writeDaemon(config.gatewayBinary, "second");
    const restarted = await restartGateway(config);
    assert.notEqual(restarted.identity.pid, a.identity.pid);
    assert.equal(restarted.token, a.token);
    const response = await fetch(`${gatewayEndpoint(config)}/runtime`, { headers: { Authorization: `Bearer ${a.token}` } });
    assert.equal((await response.json() as { revision: string }).revision, "second");
    assert.equal(await stopGateway(config), true);
    assert.equal(await gatewayStatus(config), null);
    assert.equal(await stopGateway(config), false);
    // A stopped service remains eligible for lazy launch, retaining its token.
    const next = await ensureGateway(config);
    assert.equal(next.token, a.token);
    assert.notEqual(next.identity.pid, restarted.identity.pid);
  } finally {
    await stopGateway(config);
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway shutdown refuses occupied ports when credentials/runtime files are missing", async () => {
  const { dir, config } = await fixture();
  const listener = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen(config.gatewayPort, "127.0.0.1", resolve));
  try {
    await assert.rejects(stopGateway(config), /unverified service/);
    assert.deepEqual(await readdir(dir), []);
    await mkdir(runtimeDir(config), { recursive: true });
    await assert.rejects(stopGateway(config), /unverified service/);
    assert.deepEqual(await readdir(runtimeDir(config)), []);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway shutdown rejects unverified identities, unsafe PIDs and redirects without signaling", async () => {
  const { dir, config } = await fixture();
  const originalFetch = globalThis.fetch;
  const originalKill = process.kill;
  let signals = 0;
  try {
    await mkdir(runtimeDir(config), { recursive: true });
    await writeFile(join(runtimeDir(config), "token"), "test-token");
    process.kill = (() => { signals++; throw new Error("must not signal"); }) as typeof process.kill;
    const good = { service: "browser-fetch", pid: 12345, chrome_url: cdpEndpoint(config) };
    for (const bad of [
      { ...good, service: "other" }, { ...good, chrome_url: "http://127.0.0.1:9222" },
      ...[-1, 0, 1, 1.5, process.pid, 2_147_483_648].map((pid) => ({ ...good, pid })),
    ]) {
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.redirect, "error");
        return Response.json(bad);
      };
      await assert.rejects(stopGateway(config), /Refusing gateway/);
    }
    globalThis.fetch = async () => Response.json(good, { status: 401 });
    await assert.rejects(stopGateway(config), /Refusing gateway/);
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.redirect, "error");
      throw new Error("redirect rejected");
    };
    await assert.rejects(stopGateway(config), /Cannot verify/);
    assert.equal(signals, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.kill = originalKill;
    await rm(dir, { recursive: true, force: true });
  }
});
