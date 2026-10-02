import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, writeFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import lockfile from "proper-lockfile";
import { cdpEndpoint, gatewayEndpoint, runtimeDir, type LocalAssistantConfig } from "./config";

export interface GatewayIdentity { service: "browser-fetch"; pid: number; chrome_url: string }

export async function gatewayStatus(config: LocalAssistantConfig, token?: string): Promise<GatewayIdentity | null> {
  if (!token) {
    try { token = (await readFile(join(runtimeDir(config), "token"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  let response: Response;
  try {
    response = await fetch(`${gatewayEndpoint(config)}/runtime`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
    throw new Error(`Cannot verify the gateway at ${gatewayEndpoint(config)}: ${(error as Error).message}`);
  }
  const identity = await response.json().catch(() => null) as GatewayIdentity | null;
  if (!response.ok || identity?.service !== "browser-fetch" || identity.chrome_url !== cdpEndpoint(config) ||
      !Number.isInteger(identity.pid) || identity.pid <= 1 || identity.pid > 2_147_483_647 || identity.pid === process.pid) {
    throw new Error(`Refusing gateway at ${gatewayEndpoint(config)}: authentication or browser identity mismatch. ` +
      "Use a free gateway port, or the matching profile/configuration. No unrelated service was touched.");
  }
  return identity;
}

async function withGatewayLock<T>(config: LocalAssistantConfig, action: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(runtimeDir(config), {
    stale: 60_000, update: 10_000, retries: { retries: 150, minTimeout: 500, maxTimeout: 500 },
  });
  try { return await action(); } finally { await release(); }
}

async function prepareRuntime(config: LocalAssistantConfig): Promise<void> {
  await mkdir(runtimeDir(config), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir(config), 0o700);
}

async function checkBinary(config: LocalAssistantConfig): Promise<void> {
  await access(config.gatewayBinary, constants.X_OK).catch(() => {
    throw new Error(`browser-fetch executable not found: ${config.gatewayBinary}. Build it and set gatewayBinary in .pi/assistant.json.`);
  });
}

/** Shared daemon, never a session-scoped background job. No shutdown on pi exit. */
export async function ensureGateway(config: LocalAssistantConfig): Promise<{ token: string; identity: GatewayIdentity }> {
  await prepareRuntime(config);
  return withGatewayLock(config, () => ensureGatewayLocked(config));
}

/** Restart only the gateway, from the currently configured binary. Keep Chrome/tabs intact. */
export async function restartGateway(config: LocalAssistantConfig): Promise<{ token: string; identity: GatewayIdentity }> {
  await prepareRuntime(config);
  return withGatewayLock(config, async () => {
    await checkBinary(config); // do not stop a working service for a missing replacement
    await stopGatewayLocked(config);
    return ensureGatewayLocked(config);
  });
}

async function assertGatewayPortFree(config: LocalAssistantConfig): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: config.gatewayPort });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED"));
    socket.setTimeout(1_000, () => done(true));
  });
  if (occupied) throw new Error(`Cannot verify gateway shutdown: port ${config.gatewayPort} is occupied by an unverified service. Nothing else was stopped.`);
}

/** Explicit stop is idempotent and never creates credentials or launches a process. */
export async function stopGateway(config: LocalAssistantConfig): Promise<boolean> {
  try { await access(runtimeDir(config)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await assertGatewayPortFree(config);
    return false;
  }
  return withGatewayLock(config, () => stopGatewayLocked(config));
}

async function stopGatewayLocked(config: LocalAssistantConfig): Promise<boolean> {
  // Read the authenticated live identity; never kill from a stale PID file or port scan.
  const identity = await gatewayStatus(config);
  if (!identity) { await assertGatewayPortFree(config); return false; }
  try { process.kill(identity.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  const deadline = Date.now() + 15_000; // server has a 10-second graceful shutdown budget
  while (Date.now() < deadline) {
    try { process.kill(identity.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway pid ${identity.pid} did not exit after SIGTERM; no force-kill was attempted. See ${join(runtimeDir(config), "gateway.log")}`);
}

async function ensureGatewayLocked(config: LocalAssistantConfig): Promise<{ token: string; identity: GatewayIdentity }> {
  const dir = runtimeDir(config);
  const tokenPath = join(dir, "token");
  let token: string;
  try { token = (await readFile(tokenPath, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token, { flag: "wx", mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid gateway token file: ${tokenPath}`);
  await chmod(tokenPath, 0o600);
  const existing = await gatewayStatus(config, token);
  if (existing) return { token, identity: existing };
  await checkBinary(config);
  const logPath = join(dir, "gateway.log");
  const log = await open(logPath, "a", 0o600);
  const child = spawn(config.gatewayBinary, [
    "-addr", `127.0.0.1:${config.gatewayPort}`, "-chrome-url", cdpEndpoint(config),
    "-allow-no-token=false", "-allow-private=false", "-metrics-auth=true", "-debug=false", "-background-tabs=true",
    "-request-timeout=3m", "-assist-timeout=90s",
  ], {
    detached: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, BROWSER_FETCH_TOKEN: token },
  });
  let failure: Error | undefined;
  child.on("error", (error) => { failure = error; });
  child.unref();
  await log.close();
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) break;
    const identity = await gatewayStatus(config, token);
    if (identity) return { token, identity };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`browser-fetch did not become ready. See ${logPath}`);
}
