import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEnvironment, cdpEndpoint, gatewayEndpoint, loadConfig, runtimeDir, type AssistantConfig } from "./config";
import { ensureGateway, gatewayStatus, restartGateway, stopGateway } from "./gateway";
import { externalStatus } from "./external";

const instructions = readFileSync(new URL("./assistant.md", import.meta.url), "utf8");
const requiredTools = ["browser_navigate", "browser_tabs", "browser_dom", "browser_interact", "browser_history", "web_fetch", "web_search"];

export default function assistant(pi: ExtensionAPI): void {
  let config: AssistantConfig | undefined;
  let environment: ReturnType<typeof applyEnvironment> | undefined;
  let setupError: string | undefined;

  const runtime = (operation: "ensure" | "status" | "focus" | "stop"): Promise<unknown> => {
    const request: { operation: typeof operation; result?: Promise<unknown> } = { operation };
    pi.events.emit("pi-devtools:runtime:v1", request);
    if (!request.result) throw new Error("pi-assistant requires an updated pi-devtools extension. Install/enable it and reload.");
    return request.result;
  };
  const checkConfig = (): AssistantConfig => {
    if (setupError || !config) throw new Error(setupError ?? "Assistant workspace has not initialized.");
    return config;
  };
  const checkFetchSupport = (): void => {
    const capabilities: { result?: { browserOnly: boolean } } = {};
    pi.events.emit("pi-search:capabilities:v1", capabilities);
    if (!capabilities.result?.browserOnly) throw new Error("Update pi-search: this workspace requires verified browser-only fetch support.");
  };
  const ensure = async (kind: "browser" | "fetch" | "history", signal?: AbortSignal): Promise<void> => {
    const cfg = checkConfig();
    const activeEnvironment = environment;
    if (kind === "fetch") checkFetchSupport();
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

  const actions = () => [
    { value: "status", label: "status", description: "Show configuration and service status" },
    { value: "show", label: "show", description: "Human handoff: show Chrome or the remote viewer link" },
    ...(config?.mode === "local-managed" ? [
      { value: "start", label: "start", description: "Start shared Chrome and gateway in the background" },
      { value: "stop", label: "stop", description: "Stop shared gateway and Chrome (all conversations)" },
      { value: "restart", label: "restart", description: "Restart gateway from the configured binary; keep Chrome and tabs" },
    ] : []),
  ];
  pi.registerCommand("assistant", {
    description: "Assistant workspace controls (Tab for available actions)",
    getArgumentCompletions(prefix) {
      const matches = actions().filter((action) => action.value.startsWith(prefix));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      try {
        const cfg = checkConfig();
        const activeEnvironment = environment;
        const action = args.trim() || "status";
        const usage = `Usage: /assistant [${actions().map((a) => a.value).join("|")}]`;
        if (["start", "stop", "restart"].includes(action) && cfg.mode !== "local-managed") {
          throw new Error(`/assistant ${action} is only available in local-managed mode. The external host owns service lifecycle. ${usage}`);
        }
        if (!actions().some((a) => a.value === action)) throw new Error(usage);
        if (cfg.mode === "local-managed" && (action === "stop" || action === "restart")) {
          if (action === "stop") {
            const capabilities: { result?: { managedStop: boolean } } = {};
            pi.events.emit("pi-devtools:capabilities:v1", capabilities);
            if (!capabilities.result?.managedStop) throw new Error("Update pi-devtools and reload: managed stop support is required. Nothing was stopped.");
          } else checkFetchSupport();
          const warning = action === "stop"
            ? "Stop the shared gateway and Chrome for ALL conversations? Tabs and unsaved page state will be lost; cookies/history remain. The next browser operation can start them again."
            : "Restart the shared gateway from the configured executable? In-flight fetches in ALL conversations may fail. Chrome and interactive tabs stay open. This does not rebuild or download anything.";
          if (ctx.hasUI && !(await ctx.ui.confirm(`Assistant ${action}`, warning))) return;
          if (!ctx.hasUI) ctx.ui.notify(warning, "warning");
          await ctx.waitForIdle();
          const checkActive = () => {
            if (config !== cfg || environment !== activeEnvironment) throw new Error("Assistant session changed; retry in the active session.");
          };
          checkActive();
          if (action === "stop") {
            await runtime("status"); // verify the browser before stopping either service
            checkActive();
            await stopGateway(cfg);
            checkActive();
            try { await runtime("stop"); }
            catch (error) { throw new Error(`Gateway stop completed, but Chrome stop failed: ${(error as Error).message}`); }
            ctx.ui.notify("Shared gateway and Chrome are stopped. Profile retained. The next browser operation can start them again.", "info");
          } else {
            await ensure("browser");
            checkActive();
            const running = await restartGateway(cfg);
            checkActive();
            activeEnvironment!.setToken(running.token);
            ctx.ui.notify(`Gateway restarted (pid ${running.identity.pid}) from ${cfg.gatewayBinary}. Chrome and interactive tabs retained.`, "info");
          }
          return;
        }
        if (action === "start") { await ensure("fetch"); await ensure("browser"); }
        else if (action === "show") {
          await ensure("browser"); await runtime("focus");
          ctx.ui.notify(cfg.mode === "external" ? `Remote tab selected. View it at ${cfg.humanUrl ?? "your VNC/Guacamole connection (set humanUrl for a link)"}` : "Assistant Chrome brought forward for you.", "info");
          return;
        }
        const browser = await runtime("status");
        const lines = [`Mode: ${cfg.mode}`, `CDP: ${cdpEndpoint(cfg)} (${browser ? "reachable" : "not reachable"})`, `Gateway: ${gatewayEndpoint(cfg)}`];
        if (cfg.mode === "external") {
          const remote = await externalStatus(cfg);
          lines.push(`Remote capabilities: CDP ${remote.capabilities.cdp ? "enabled" : "disabled"}; history ${remote.capabilities.history ? `configured (protocol ${remote.historyProtocol ?? "legacy"})` : "disabled"}`,
            "Lifecycle: external host (no local launch, token generation, or profile mount)", `Human viewer: ${cfg.humanUrl ?? "not configured"}`);
        } else {
          const gateway = await gatewayStatus(cfg);
          lines.push(`Profile: ${cfg.profile}`, `Gateway process: ${gateway ? `pid ${gateway.pid}` : "not verified/running; launched on fetch"}`,
            `Gateway executable: ${cfg.gatewayBinary} (rebuild/replace manually, then /assistant restart)`, `History: ${cfg.historySource} (${existsSync(join(cfg.profile, "Default", "History")) ? "database present" : "no Default database yet"})`, `Runtime/logs: ${runtimeDir(cfg)}`);
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
