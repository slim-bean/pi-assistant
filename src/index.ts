import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEnvironment, cdpEndpoint, gatewayEndpoint, loadConfig, runtimeDir, type AssistantConfig } from "./config";
import { ensureGateway, gatewayStatus } from "./gateway";
import { externalStatus } from "./external";

const instructions = readFileSync(new URL("./assistant.md", import.meta.url), "utf8");
const requiredTools = ["browser_navigate", "browser_tabs", "browser_dom", "browser_interact", "browser_history", "web_fetch", "web_search"];

export default function assistant(pi: ExtensionAPI): void {
  let config: AssistantConfig | undefined;
  let environment: ReturnType<typeof applyEnvironment> | undefined;
  let setupError: string | undefined;

  const runtime = (operation: "ensure" | "status" | "focus"): Promise<unknown> => {
    const request: { operation: typeof operation; result?: Promise<unknown> } = { operation };
    pi.events.emit("pi-devtools:runtime:v1", request);
    if (!request.result) throw new Error("pi-assistant requires an updated pi-devtools extension. Install/enable it and reload.");
    return request.result;
  };
  const checkConfig = (): AssistantConfig => {
    if (setupError || !config) throw new Error(setupError ?? "Assistant workspace has not initialized.");
    return config;
  };
  const ensure = async (kind: "browser" | "fetch" | "history", signal?: AbortSignal): Promise<void> => {
    const cfg = checkConfig();
    const activeEnvironment = environment;
    if (kind === "fetch") {
      const capabilities: { result?: { browserOnly: boolean } } = {};
      pi.events.emit("pi-search:capabilities:v1", capabilities);
      if (!capabilities.result?.browserOnly) throw new Error("Update pi-search: this workspace requires verified browser-only fetch support.");
    }
    if (cfg.mode === "external") {
      if (kind === "history") {
        const capabilities: { result?: { remoteHistory: boolean; historyProtocol?: number } } = {};
        pi.events.emit("pi-browser:capabilities:v1", capabilities);
        if (!capabilities.result?.remoteHistory || capabilities.result.historyProtocol !== 2) throw new Error("Update pi-browser: this workspace requires native history protocol v2 support.");
      }
      const remote = await externalStatus(cfg, signal);
      if (kind === "browser") {
        if (!remote.capabilities.cdp) throw new Error("External gateway has CDP disabled; enable it on the browser host.");
        await runtime("ensure"); // attach-only; no local process or identity file
      }
      if (kind === "history") {
        if (!remote.capabilities.history) throw new Error("External gateway has no native history root configured.");
        if (remote.historyProtocol !== 2) throw new Error("Update browser-fetch: native history protocol v2 is required.");
      }
      return;
    }
    if (kind === "history") return; // local history does not need a live browser
    await runtime("ensure");
    if (kind === "fetch") {
      const running = await ensureGateway(cfg);
      if (config !== cfg || environment !== activeEnvironment) throw new Error("Assistant session changed during startup; retry in the active session.");
      activeEnvironment!.setToken(running.token);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    environment?.restore();
    environment = undefined; config = undefined; setupError = undefined;
    try {
      config = loadConfig(ctx.cwd);
      environment = applyEnvironment(config);
      const names = new Set(pi.getAllTools().map((t) => t.name));
      const missing = requiredTools.filter((name) => !names.has(name));
      if (missing.length) ctx.ui.notify(`Assistant: missing tools: ${missing.join(", ")}. See pi-assistant/README.md.`, "warning");
      ctx.ui.setStatus("assistant", `assistant · ${config.mode === "external" ? "external browser" : `Chrome :${config.cdpPort}`} · browser-only reads`);
    } catch (error) {
      setupError = (error as Error).message; config = undefined;
      ctx.ui.notify(`Assistant setup error: ${setupError}`, "error");
      ctx.ui.setStatus("assistant", "assistant · configuration error");
    }
  });

  pi.on("before_agent_start", (event) => {
    let facts = `Browser tools unavailable until configuration is fixed: ${setupError}`;
    if (config?.mode === "local-managed") {
      facts = `Local managed browser: ${cdpEndpoint(config)}\nProfile: ${config.profile}\nHistory source: ${config.historySource}\n` +
        "Chrome launches automatically in the background and outlives pi. Its first window is minimized. Only browser_tabs focus or /assistant show should bring it forward for an explicit human handoff.";
    } else if (config?.mode === "external") {
      facts = `Externally managed browser gateway: ${config.gatewayUrl}\n` +
        "Chrome and history live on the browser host, not this machine. Kubernetes/the operator owns startup and restart. Never try to launch a local replacement or bypass the gateway. " +
        "localhost in browser navigation refers to the browser host, not the agent's container. browser_history searches the remote profile. " +
        `Human viewing: ${config.humanUrl ?? "use the operator's VNC/Guacamole connection"}. /assistant show selects the remote tab and prints the viewer link; it does not open a local browser.`;
    }
    event.systemPromptOptions.sections.assistant = `${instructions}\n\n## Current browser environment\n${facts}\n`;
  });

  pi.on("tool_call", async (event, ctx) => {
    const kind = event.toolName === "web_fetch" ? "fetch" : event.toolName === "browser_history" ? "history" :
      event.toolName.startsWith("browser_") ? "browser" : undefined;
    if (!kind) return;
    try {
      ctx.signal?.throwIfAborted();
      await ensure(kind, ctx.signal);
      ctx.signal?.throwIfAborted();
    } catch (error) {
      return { block: true, reason: `Assistant browser unavailable: ${(error as Error).message}` };
    }
  });

  pi.registerCommand("assistant", {
    description: "Assistant workspace: /assistant [status|start|show] (show is an explicit human handoff)",
    async handler(args, ctx) {
      try {
        const cfg = checkConfig();
        const action = args.trim() || "status";
        if (action === "start") { await ensure("fetch"); await ensure("browser"); }
        else if (action === "show") {
          await ensure("browser"); await runtime("focus");
          ctx.ui.notify(cfg.mode === "external" ? `Remote tab selected. View it at ${cfg.humanUrl ?? "your VNC/Guacamole connection (set humanUrl for a link)"}` : "Assistant Chrome brought forward for you.", "info");
          return;
        } else if (action !== "status") throw new Error("Usage: /assistant [status|start|show]");
        const browser = await runtime("status");
        const lines = [`Mode: ${cfg.mode}`, `CDP: ${cdpEndpoint(cfg)} (${browser ? "reachable" : "not reachable"})`, `Gateway: ${gatewayEndpoint(cfg)}`];
        if (cfg.mode === "external") {
          const remote = await externalStatus(cfg);
          lines.push(`Remote capabilities: CDP ${remote.capabilities.cdp ? "enabled" : "disabled"}; history ${remote.capabilities.history ? `configured (protocol ${remote.historyProtocol ?? "legacy"})` : "disabled"}`,
            "Lifecycle: external host (no local launch, token generation, or profile mount)", `Human viewer: ${cfg.humanUrl ?? "not configured"}`);
        } else {
          const gateway = await gatewayStatus(cfg);
          lines.push(`Profile: ${cfg.profile}`, `Gateway process: ${gateway ? `pid ${gateway.pid}` : "checked/launched on fetch"}`,
            `Gateway executable: ${cfg.gatewayBinary}`, `History: ${cfg.historySource} (${existsSync(join(cfg.profile, "Default", "History")) ? "database present" : "no Default database yet"})`, `Runtime/logs: ${runtimeDir(cfg)}`);
        }
        const names = new Set(pi.getAllTools().map((t) => t.name));
        const missing = [...requiredTools, "browser_read"].filter((name) => !names.has(name));
        lines.push("Page retrieval: browser-only; no direct fallback or llms.txt probe", "Tabs: per conversation, disposable; cookies/history retained",
          missing.length ? `Missing tools: ${missing.join(", ")}` : "All assistant tools available");
        ctx.ui.notify(lines.join("\n"), missing.length ? "warning" : "info");
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
  pi.on("session_shutdown", () => { environment?.restore(); environment = undefined; });
}
