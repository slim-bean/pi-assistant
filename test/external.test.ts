import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assistant from "../src/index";
import { loadConfig, applyEnvironment, externalToken, cdpEndpoint } from "../src/config";

test("external mode configures all clients without local launch/profile discovery and fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assistant-external-"));
  const env = { ...process.env }; const fetch = globalThis.fetch;
  const handlers = new Map<string, Function>(); const calls: string[] = [];
  let authenticated = true;
  try {
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, "token"), "external-secret\n");
    writeFileSync(join(dir, ".pi/assistant.json"), JSON.stringify({ mode:"external", gatewayUrl:"http://browser.example:8377/", tokenFile:"token", humanUrl:"https://viewer.example/" }));
    const cfg = loadConfig(dir); assert.ok(cfg.mode === "external");
    assert.equal(cdpEndpoint(cfg), "http://browser.example:8377/cdp");
    process.env.PI_DEVTOOLS_AUTO_LAUNCH = "1";
    process.env.PI_SEARCH_BROWSER_TOKEN = "wrong-ambient-token";
    const applied = applyEnvironment(cfg);
    assert.equal(process.env.PI_DEVTOOLS_AUTO_LAUNCH, "0");
    assert.equal(process.env.PI_SEARCH_BROWSER_TOKEN, undefined);
    assert.equal(process.env.PI_BROWSER_HISTORY_TOKEN_FILE, join(dir,"token"));
    assert.equal(process.env.PI_BROWSER_HISTORY_URL, cfg.gatewayUrl);
    assert.equal(externalToken(cfg), "external-secret");
    applied.restore();
    assert.equal(process.env.PI_DEVTOOLS_AUTO_LAUNCH, "1");
    globalThis.fetch = async (url, init) => {
      calls.push(String(url)); assert.equal(String(url), cfg.gatewayUrl+"/runtime");
      assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer external-secret");
      return authenticated ? Response.json({service:"browser-fetch",chrome_url:"http://127.0.0.1:9222",capabilities:{cdp:true,history:true},historyProtocol:2}) : Response.json({error:"unauthorized"},{status:401});
    };
    const pi = {
      on: (name:string, fn:Function) => handlers.set(name,fn), registerCommand() {}, getAllTools:()=>[],
      events:{ emit(channel:string, data:any) {
        if(channel==="pi-devtools:runtime:v1") { assert.equal(process.env.PI_DEVTOOLS_AUTO_LAUNCH,"0"); data.result=Promise.resolve({browser:"remote"}); }
        if(channel==="pi-search:capabilities:v1") data.result={browserOnly:true};
        if(channel==="pi-browser:capabilities:v1") data.result={remoteHistory:true,historyProtocol:2};
      } },
    };
    const ctx = {cwd:dir,ui:{notify(){},setStatus(){}}};
    assistant(pi as any); handlers.get("session_start")!({},ctx);
    assert.deepEqual(calls,[]); // no eager network/processes
    for(const toolName of ["web_fetch","browser_navigate","browser_history"]) {
      assert.equal(await handlers.get("tool_call")!({toolName},ctx),undefined);
    }
    const event={systemPromptOptions:{sections:{} as Record<string,string>}};
    handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.assistant,/Externally managed/);
    assert.match(event.systemPromptOptions.sections.assistant,/localhost.*browser host/);
    authenticated=false;
    assert.equal((await handlers.get("tool_call")!({toolName:"web_fetch"},ctx)).block,true);
    assert.deepEqual(readdirSync(dir).sort(),[".pi","token"]);
    handlers.get("session_shutdown")!();
    writeFileSync(join(dir,".pi/assistant.json"),'{"mode":"external","gatewayUrl":"http://user:secret@host"}');
    assert.throws(()=>loadConfig(dir),/without credentials/);
  } finally { globalThis.fetch=fetch; process.env=env; rmSync(dir,{recursive:true,force:true}); }
});
