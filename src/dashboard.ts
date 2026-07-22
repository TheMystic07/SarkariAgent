import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getConfig, setConfig, testConnection } from "./config";

function tokenFile(): string {
  return path.join(process.env.DATA_DIR ?? "./data", "dashboard-token.txt");
}

/** Stable dashboard token: env var, else a persisted generated one. */
export function dashboardToken(): string {
  if (process.env.DASHBOARD_TOKEN) return process.env.DASHBOARD_TOKEN;
  try {
    return readFileSync(tokenFile(), "utf8").trim();
  } catch {
    const t = randomUUID().replace(/-/g, "");
    mkdirSync(path.dirname(tokenFile()), { recursive: true });
    writeFileSync(tokenFile(), t);
    return t;
  }
}

function authed(req: Request, token: string): boolean {
  const h = req.headers.get("authorization") ?? "";
  return h === `Bearer ${token}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function startDashboard(): void {
  const token = dashboardToken();
  const port = Number(process.env.DASHBOARD_PORT ?? 8787);
  const hostname = process.env.DASHBOARD_HOST ?? "127.0.0.1";

  Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authed(req, token)) return json({ error: "unauthorized" }, 401);

        if (req.method === "GET" && url.pathname === "/api/config") {
          const c = getConfig();
          return json({
            provider: c.provider,
            baseUrl: c.baseUrl,
            model: c.model,
            hasKey: Boolean(c.apiKey),
            visionEnabled: Boolean(c.visionEnabled),
            visionBaseUrl: c.visionBaseUrl ?? "",
            visionModel: c.visionModel ?? "",
            hasVisionKey: Boolean(c.visionApiKey),
          });
        }

        if (req.method === "POST" && url.pathname === "/api/config") {
          const body = (await req.json().catch(() => ({}))) as Record<string, string | boolean>;
          const update: Partial<Parameters<typeof setConfig>[0]> = {};
          if (body.provider === "local" || body.provider === "anthropic") update.provider = body.provider;
          if (typeof body.baseUrl === "string") update.baseUrl = body.baseUrl.trim();
          if (typeof body.model === "string") update.model = body.model.trim();
          if (typeof body.apiKey === "string" && body.apiKey.length > 0) update.apiKey = body.apiKey;
          if (typeof body.visionEnabled === "boolean") update.visionEnabled = body.visionEnabled;
          if (typeof body.visionBaseUrl === "string") update.visionBaseUrl = body.visionBaseUrl.trim();
          if (typeof body.visionModel === "string") update.visionModel = body.visionModel.trim();
          if (typeof body.visionApiKey === "string" && body.visionApiKey.length > 0) update.visionApiKey = body.visionApiKey;
          const c = await setConfig(update);
          return json({
            provider: c.provider,
            baseUrl: c.baseUrl,
            model: c.model,
            hasKey: Boolean(c.apiKey),
            visionEnabled: Boolean(c.visionEnabled),
            visionBaseUrl: c.visionBaseUrl ?? "",
            visionModel: c.visionModel ?? "",
            hasVisionKey: Boolean(c.visionApiKey),
          });
        }

        if (req.method === "POST" && url.pathname === "/api/test") {
          const body = (await req.json().catch(() => ({}))) as Record<string, string>;
          const c = getConfig();
          const vision = body.which === "vision";
          const result = await testConnection({
            baseUrl: (body.baseUrl || (vision ? c.visionBaseUrl : c.baseUrl) || "").trim(),
            model: (body.model || (vision ? c.visionModel : c.model) || "").trim(),
            apiKey: body.apiKey && body.apiKey.length > 0 ? body.apiKey : (vision ? c.visionApiKey : c.apiKey) ?? "",
          });
          return json(result);
        }

        return json({ error: "not found" }, 404);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const shown = hostname === "0.0.0.0" ? "<server-ip>" : hostname;
  console.log(`Dashboard: http://${shown}:${port}  (token: ${token})`);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sarkari Agent — Control</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --line:#2a2f3a; --fg:#e6e9ef; --muted:#8a91a0; --acc:#4c8bf5; --ok:#3ecf8e; --bad:#f56b6b; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; }
  .wrap { max-width:620px; margin:40px auto; padding:0 16px; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  label { display:block; font-size:13px; color:var(--muted); margin:14px 0 6px; }
  input,select { width:100%; padding:10px 12px; background:#0f1115; border:1px solid var(--line); border-radius:8px; color:var(--fg); font-size:14px; }
  input:focus,select:focus { outline:none; border-color:var(--acc); }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
  button { padding:10px 16px; border:0; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
  .primary { background:var(--acc); color:#fff; } .ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
  .status { margin-top:14px; padding:10px 12px; border-radius:8px; font-size:13px; display:none; white-space:pre-wrap; word-break:break-word; }
  .status.ok { background:rgba(62,207,142,.12); color:var(--ok); display:block; }
  .status.bad { background:rgba(245,107,107,.12); color:var(--bad); display:block; }
  .presets button { background:#232734; color:var(--fg); font-weight:500; font-size:13px; margin:0 8px 8px 0; }
  .cur { font-size:13px; color:var(--muted); }
  .cur b { color:var(--fg); }
</style></head>
<body><div class="wrap">
  <h1>Sarkari Agent — Control</h1>
  <p class="sub">Switch the AI model at runtime. No restart needed.</p>

  <div id="login" class="card">
    <label>Dashboard token</label>
    <input id="tok" type="password" placeholder="paste the token from the server log">
    <div class="row"><button class="primary" onclick="save_tok()">Unlock</button></div>
    <div id="loginErr" class="status"></div>
  </div>

  <div id="app" style="display:none">
    <div class="card">
      <div class="cur">Currently: <b id="curProv"></b> · <b id="curModel"></b> · <span id="curUrl"></span></div>
    </div>
    <div class="card">
      <div class="presets">
        <div style="color:var(--muted);font-size:13px;margin-bottom:8px">Presets</div>
        <button onclick="preset('azure')">Azure GPT-5.5</button>
        <button onclick="preset('cerebras')">Cerebras (GPT-OSS 120B)</button>
        <button onclick="preset('cerebras_glm')">Cerebras (GLM-4.7 355B)</button>
        <button onclick="preset('vllm')">Local unsloth (vLLM)</button>
        <button onclick="preset('llama')">Local (llama.cpp)</button>
        <button onclick="preset('openai')">OpenAI</button>
      </div>
      <label>Provider</label>
      <select id="provider">
        <option value="local">OpenAI-compatible (GPT / unsloth / vLLM / llama.cpp / any)</option>
        <option value="anthropic">Anthropic (Claude)</option>
      </select>
      <label>Base URL (OpenAI-compatible endpoint, ending in /v1)</label>
      <input id="baseUrl" placeholder="https://…/openai/v1  or  http://localhost:8000/v1">
      <label>Model / deployment name</label>
      <input id="model" placeholder="gpt-5.5  /  unsloth-model">
      <label>API key <span id="keyNote" style="color:var(--muted)"></span></label>
      <input id="apiKey" type="password" placeholder="leave blank to keep the current key">
      <div class="row">
        <button class="ghost" onclick="test('primary')">Test connection</button>
        <button class="primary" onclick="apply()">Save &amp; apply</button>
      </div>
      <div id="st" class="status"></div>
    </div>

    <div class="card">
      <label style="display:flex;align-items:center;gap:8px;margin:0;cursor:pointer">
        <input type="checkbox" id="visionEnabled" style="width:auto" onchange="toggleVision()"> Hybrid vision fallback
      </label>
      <p class="sub" style="font-size:12px;margin:6px 0 0">Text messages use the fast model above; messages with a photo are routed to a vision-capable model (e.g. Azure GPT-5.5) so the agent can read documents.</p>
      <div id="visionFields" style="display:none">
        <label>Vision base URL</label>
        <input id="visionBaseUrl" placeholder="https://…/openai/v1">
        <label>Vision model</label>
        <input id="visionModel" placeholder="gpt-5.5">
        <label>Vision API key <span id="vkeyNote" style="color:var(--muted)"></span></label>
        <input id="visionApiKey" type="password" placeholder="leave blank to keep the current key">
        <div class="row"><button class="ghost" onclick="test('vision')">Test vision</button></div>
        <div id="vst" class="status"></div>
      </div>
    </div>
    <p class="sub" style="font-size:12px">The Anthropic provider ignores Base URL/model and uses claude-opus-4-8 with ANTHROPIC_API_KEY.</p>
  </div>
</div>
<script>
let TOK = localStorage.getItem("sa_tok") || "";
function hdr(){ return { "content-type":"application/json", "authorization":"Bearer "+TOK }; }
async function save_tok(){ TOK = document.getElementById("tok").value.trim(); localStorage.setItem("sa_tok",TOK); load(); }
async function load(){
  const r = await fetch("/api/config",{headers:hdr()});
  if(r.status===401){ document.getElementById("loginErr").className="status bad"; document.getElementById("loginErr").textContent="Wrong token."; return; }
  const c = await r.json();
  document.getElementById("login").style.display="none";
  document.getElementById("app").style.display="block";
  document.getElementById("provider").value=c.provider;
  document.getElementById("baseUrl").value=c.baseUrl;
  document.getElementById("model").value=c.model;
  document.getElementById("keyNote").textContent = c.hasKey ? "(a key is set)" : "(no key set)";
  document.getElementById("visionEnabled").checked = c.visionEnabled;
  document.getElementById("visionBaseUrl").value = c.visionBaseUrl||"";
  document.getElementById("visionModel").value = c.visionModel||"";
  document.getElementById("vkeyNote").textContent = c.hasVisionKey ? "(a key is set)" : "(no key set)";
  document.getElementById("visionFields").style.display = c.visionEnabled ? "block" : "none";
  document.getElementById("curProv").textContent = c.visionEnabled ? c.provider+" + vision" : c.provider;
  document.getElementById("curModel").textContent=c.model;
  document.getElementById("curUrl").textContent=c.baseUrl;
}
function toggleVision(){ document.getElementById("visionFields").style.display = document.getElementById("visionEnabled").checked ? "block":"none"; }
function preset(k){
  const p={
    azure:{provider:"local",baseUrl:"https://<resource>.services.ai.azure.com/openai/v1",model:"gpt-5.5"},
    cerebras:{provider:"local",baseUrl:"https://api.cerebras.ai/v1",model:"gpt-oss-120b"},
    cerebras_glm:{provider:"local",baseUrl:"https://api.cerebras.ai/v1",model:"zai-glm-4.7"},
    vllm:{provider:"local",baseUrl:"http://localhost:8000/v1",model:"unsloth-model"},
    llama:{provider:"local",baseUrl:"http://127.0.0.1:8080/v1",model:"default"},
    openai:{provider:"local",baseUrl:"https://api.openai.com/v1",model:"gpt-4o"},
  }[k];
  document.getElementById("provider").value=p.provider;
  document.getElementById("baseUrl").value=p.baseUrl;
  document.getElementById("model").value=p.model;
}
function body(){ return JSON.stringify({
  provider:document.getElementById("provider").value, baseUrl:document.getElementById("baseUrl").value, model:document.getElementById("model").value, apiKey:document.getElementById("apiKey").value,
  visionEnabled:document.getElementById("visionEnabled").checked, visionBaseUrl:document.getElementById("visionBaseUrl").value, visionModel:document.getElementById("visionModel").value, visionApiKey:document.getElementById("visionApiKey").value
}); }
function show(el,ok,msg){ el.className="status "+(ok?"ok":"bad"); el.textContent=msg; }
async function test(which){
  const st=document.getElementById(which==="vision"?"vst":"st"); show(st,true,"Testing…");
  const payload = which==="vision"
    ? { which:"vision", baseUrl:document.getElementById("visionBaseUrl").value, model:document.getElementById("visionModel").value, apiKey:document.getElementById("visionApiKey").value }
    : { baseUrl:document.getElementById("baseUrl").value, model:document.getElementById("model").value, apiKey:document.getElementById("apiKey").value };
  const r=await fetch("/api/test",{method:"POST",headers:hdr(),body:JSON.stringify(payload)});
  const d=await r.json(); show(st,d.ok,(d.ok?"✓ ":"✗ ")+d.detail);
}
async function apply(){
  const st=document.getElementById("st"); show(st,true,"Saving…");
  const r=await fetch("/api/config",{method:"POST",headers:hdr(),body:body()});
  if(!r.ok){ show(st,false,"Save failed."); return; }
  document.getElementById("apiKey").value=""; document.getElementById("visionApiKey").value="";
  await load(); show(st,true,"✓ Saved. New messages now use this config.");
}
if(TOK) load();
</script></body></html>`;
