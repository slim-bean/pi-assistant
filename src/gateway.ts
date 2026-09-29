import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, writeFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
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
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
    throw new Error(`Cannot verify the gateway at ${gatewayEndpoint(config)}: ${(error as Error).message}`);
  }
  const identity = await response.json().catch(() => null) as GatewayIdentity | null;
  if (!response.ok || identity?.service !== "browser-fetch" || identity.chrome_url !== cdpEndpoint(config) || !Number.isInteger(identity.pid)) {
    throw new Error(`Refusing gateway at ${gatewayEndpoint(config)}: authentication or browser identity mismatch. ` +
      "Use a free gateway port, or the matching profile/configuration. No unrelated service was touched.");
  }
  return identity;
}

/** Shared daemon, never a session-scoped background job. No shutdown on pi exit. */
export async function ensureGateway(config: LocalAssistantConfig): Promise<{ token: string; identity: GatewayIdentity }> {
  const dir = runtimeDir(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const release = await lockfile.lock(dir, {
    stale: 60_000, update: 10_000, retries: { retries: 150, minTimeout: 500, maxTimeout: 500 },
  });
  try {
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
    await access(config.gatewayBinary, constants.X_OK).catch(() => {
      throw new Error(`browser-fetch executable not found: ${config.gatewayBinary}. Build it and set gatewayBinary in .pi/assistant.json.`);
    });
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
  } finally { await release(); }
}
