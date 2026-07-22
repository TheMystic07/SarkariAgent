import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface LlmConfig {
  provider: "local" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey: string;
  // Hybrid vision fallback: turns that include a photo route here (a
  // vision-capable OpenAI-compatible endpoint) while text turns use the primary.
  visionEnabled?: boolean;
  visionBaseUrl?: string;
  visionModel?: string;
  visionApiKey?: string;
}

export interface Endpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

let cfg: LlmConfig | null = null;

function configFile(): string {
  return path.join(process.env.DATA_DIR ?? "./data", "config.json");
}

function fromEnv(): LlmConfig {
  return {
    provider: process.env.LLM_PROVIDER === "anthropic" ? "anthropic" : "local",
    baseUrl: (process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:8000/v1").replace(/\/$/, ""),
    model: process.env.LOCAL_LLM_MODEL ?? "local",
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "",
    visionEnabled: process.env.VISION_BASE_URL ? true : false,
    visionBaseUrl: (process.env.VISION_BASE_URL ?? "").replace(/\/$/, ""),
    visionModel: process.env.VISION_MODEL ?? "",
    visionApiKey: process.env.VISION_API_KEY ?? "",
  };
}

/** The endpoint for text turns. */
export function primaryEndpoint(): Endpoint {
  const c = getConfig();
  return { baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey };
}

/** The endpoint for image turns, if a hybrid vision fallback is configured. */
export function visionEndpoint(): Endpoint | null {
  const c = getConfig();
  if (!c.visionEnabled || !c.visionBaseUrl || !c.visionModel) return null;
  return { baseUrl: c.visionBaseUrl, model: c.visionModel, apiKey: c.visionApiKey ?? "" };
}

/** Test helper: drop the in-memory cache so the next getConfig re-reads env/file. */
export function resetConfigCache(): void {
  cfg = null;
}

/** Current config — persisted config file wins over env, cached in memory. */
export function getConfig(): LlmConfig {
  if (cfg) return cfg;
  try {
    const saved = JSON.parse(readFileSync(configFile(), "utf8")) as Partial<LlmConfig>;
    cfg = { ...fromEnv(), ...saved };
  } catch {
    cfg = fromEnv();
  }
  return cfg;
}

/** Update config at runtime (dashboard) and persist. Takes effect on the next agent turn. */
export async function setConfig(update: Partial<LlmConfig>): Promise<LlmConfig> {
  const next = { ...getConfig(), ...update };
  next.baseUrl = next.baseUrl.replace(/\/$/, "");
  cfg = next;
  mkdirSync(path.dirname(configFile()), { recursive: true });
  await Bun.write(configFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Ping a chat endpoint with a tiny request to verify it works. */
export async function testConnection(c: Pick<LlmConfig, "baseUrl" | "model" | "apiKey">): Promise<{
  ok: boolean;
  ms?: number;
  detail: string;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${c.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, messages: [{ role: "user", content: "Reply with: OK" }], max_completion_tokens: 8 }),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    let reply = "";
    try {
      reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
    } catch {
      /* non-JSON */
    }
    return { ok: true, ms, detail: `Responded in ${ms}ms${reply ? ` — "${reply.slice(0, 40)}"` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
