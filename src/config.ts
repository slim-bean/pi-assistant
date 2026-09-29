import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export interface LocalAssistantConfig {
  mode: "local-managed";
  profile: string; cdpPort: number; gatewayPort: number; gatewayBinary: string; historySource: string;
}
export interface ExternalAssistantConfig {
  mode: "external";
  gatewayUrl: string;
  tokenEnv: string;
  tokenFile?: string;
  humanUrl?: string;
}
export type AssistantConfig = LocalAssistantConfig | ExternalAssistantConfig;
export const expandPath = (path: string, cwd: string): string => resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));

function baseURL(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be an http(s) URL without credentials/query/fragment`);
  return url.toString().replace(/\/+$/, "");
}
export function loadConfig(cwd: string): AssistantConfig {
  const file = join(cwd, ".pi", "assistant.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} must contain an object.`);
  const mode = raw.mode === undefined ? "local-managed" : raw.mode;
  if (mode !== "local-managed" && mode !== "external") throw new Error("assistant.mode must be local-managed or external");
  const allowed = mode === "external" ? ["mode", "gatewayUrl", "tokenEnv", "tokenFile", "humanUrl"] :
    ["mode", "profile", "cdpPort", "gatewayPort", "gatewayBinary", "historySource"];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(`Unknown ${mode} assistant setting: ${key}`);
  if (mode === "external") {
    const tokenEnv = raw.tokenEnv ?? "PI_ASSISTANT_GATEWAY_TOKEN";
    if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error("tokenEnv must name an environment variable");
    if (raw.tokenFile !== undefined && (typeof raw.tokenFile !== "string" || !raw.tokenFile.trim())) throw new Error("tokenFile must be a path");
    if (raw.humanUrl !== undefined) {
      if (typeof raw.humanUrl !== "string") throw new Error("humanUrl must be an http(s) viewer URL");
      const viewer = new URL(raw.humanUrl);
      if (!["http:", "https:"].includes(viewer.protocol) || viewer.username || viewer.password) throw new Error("humanUrl must be an http(s) viewer URL without credentials");
    }
    return { mode, gatewayUrl: baseURL(raw.gatewayUrl, "gatewayUrl"), tokenEnv,
      tokenFile: raw.tokenFile ? expandPath(raw.tokenFile, cwd) : undefined, humanUrl: raw.humanUrl };
  }
  const config: LocalAssistantConfig = {
    mode, profile: "~/.local/share/pi-assistant/chrome-profile", cdpPort: 19322, gatewayPort: 19377,
    gatewayBinary: "~/.local/bin/browser-fetch", historySource: "assistant", ...raw,
  };
  for (const key of ["profile", "gatewayBinary", "historySource"] as const) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`assistant.${key} must be a nonempty string.`);
  }
  for (const key of ["cdpPort", "gatewayPort"] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535) throw new Error(`assistant.${key} must be a port between 1024 and 65535.`);
  }
  if (config.cdpPort === config.gatewayPort) throw new Error("CDP and gateway ports must differ.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.historySource)) throw new Error("historySource must be a lowercase source id.");
  config.profile = expandPath(config.profile, cwd);
  config.gatewayBinary = expandPath(config.gatewayBinary, cwd);
  return config;
}

export const gatewayEndpoint = (c: AssistantConfig): string => c.mode === "external" ? c.gatewayUrl : `http://127.0.0.1:${c.gatewayPort}`;
export const cdpEndpoint = (c: AssistantConfig): string => c.mode === "external" ? `${c.gatewayUrl}/cdp` : `http://127.0.0.1:${c.cdpPort}`;
export const runtimeDir = (c: LocalAssistantConfig): string => join(c.profile, ".pi-assistant");
export function externalToken(c: ExternalAssistantConfig): string {
  const token = (c.tokenFile ? readFileSync(c.tokenFile, "utf8") : process.env[c.tokenEnv])?.trim();
  if (token && /[\r\n]/.test(token)) throw new Error("External gateway token contains an embedded newline");
  if (!token) throw new Error(`External browser requires ${c.tokenFile ? "a nonempty tokenFile" : c.tokenEnv}`);
  return token;
}

/** Reversible process-local configuration. External mode never mounts/discovers a local profile. */
export function applyEnvironment(config: AssistantConfig): { setToken(token: string): void; restore(): void } {
  const values: Record<string, string | undefined> = {
    PI_DEVTOOLS_CDP_URL: cdpEndpoint(config), PI_SEARCH_FETCH_MODE: "browser-only",
    PI_SEARCH_BROWSER_URL: gatewayEndpoint(config), PI_SEARCH_BROWSER_TIMEOUT_MS: "180000", PI_SEARCH_BROWSER_ASSIST_MS: "90000",
    PI_DEVTOOLS_CDP_TOKEN: undefined, PI_DEVTOOLS_CDP_TOKEN_FILE: undefined,
    PI_SEARCH_BROWSER_TOKEN: undefined, PI_SEARCH_BROWSER_TOKEN_FILE: undefined,
    PI_BROWSER_HISTORY_TOKEN: undefined, PI_BROWSER_HISTORY_TOKEN_FILE: undefined,
    PI_BROWSER_HISTORY_URL: undefined,
  };
  if (config.mode === "external") {
    const token = externalToken(config);
    values.PI_DEVTOOLS_AUTO_LAUNCH = "0";
    values.PI_DEVTOOLS_BACKGROUND = "1"; // background tab/window policy; auto-launch remains disabled
    values.PI_BROWSER_HISTORY_URL = config.gatewayUrl;
    for (const prefix of ["PI_DEVTOOLS_CDP", "PI_SEARCH_BROWSER", "PI_BROWSER_HISTORY"]) {
      values[`${prefix}_TOKEN_FILE`] = config.tokenFile;
      values[`${prefix}_TOKEN`] = config.tokenFile ? undefined : token;
    }
  } else {
    const roots = JSON.parse(process.env.PI_BROWSER_HISTORY_CHROMIUM_ROOTS || "[]");
    if (!Array.isArray(roots)) throw new Error("PI_BROWSER_HISTORY_CHROMIUM_ROOTS must be an array.");
    Object.assign(values, {
      PI_DEVTOOLS_PROFILE: config.profile, PI_DEVTOOLS_AUTO_LAUNCH: "1", PI_DEVTOOLS_BACKGROUND: "1",
      PI_BROWSER_HISTORY_CHROMIUM_ROOTS: JSON.stringify([...roots.filter((r) => r?.dir !== config.profile), { browser: config.historySource, dir: config.profile }]),
    });
  }
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string | undefined) => {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    values[key] = value;
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  for (const [key, value] of Object.entries(values)) set(key, value);
  return {
    setToken: (token) => set("PI_SEARCH_BROWSER_TOKEN", token),
    restore() {
      for (const [key, value] of previous) {
        if (process.env[key] !== values[key]) continue;
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      previous.clear();
    },
  };
}
