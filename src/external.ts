import { externalToken, gatewayEndpoint, type ExternalAssistantConfig } from "./config";

export interface ExternalRuntime { service: "browser-fetch"; capabilities: { cdp: boolean; history: boolean }; historyProtocol?: number }
export async function externalStatus(config: ExternalAssistantConfig, signal?: AbortSignal): Promise<ExternalRuntime> {
  const response = await fetch(`${gatewayEndpoint(config)}/runtime`, {
    headers: { Authorization: `Bearer ${externalToken(config)}` }, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`External browser gateway returned HTTP ${response.status}; check endpoint and credentials. No local fallback.`);
  const result = await response.json() as ExternalRuntime;
  if (result.service !== "browser-fetch" || typeof result.capabilities?.cdp !== "boolean" || typeof result.capabilities?.history !== "boolean") {
    throw new Error("External endpoint is not a compatible browser-fetch gateway; update the server for CDP/history support.");
  }
  // Server-internal chrome_url legitimately differs from the client-facing CDP
  // URL. Both protected interfaces are derived from the same authenticated base.
  return result;
}
