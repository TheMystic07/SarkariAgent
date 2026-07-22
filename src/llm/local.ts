import { SYSTEM_PROMPT, type UserBlock } from "../prompt";
import { makeTools, type ToolCtx } from "../tools";
import { primaryEndpoint, type Endpoint } from "../config";

export interface Usage {
  input: number;
  output: number;
}

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: {
    id: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
  tool_call_id?: string;
  _usage?: Usage;
}

function headers(ep: Endpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to the chat endpoint with a request timeout and retries on transient
 * failures (429 / 5xx / network) so a momentary blip doesn't kill a turn.
 */
async function callLLM(body: Record<string, unknown>, stream: boolean, ep: Endpoint): Promise<Response> {
  const timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 120_000);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: headers(ep),
        body: JSON.stringify({ ...body, stream }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Retry only genuinely transient throttling (429) and 503 overloaded —
      // not other 5xx (e.g. a 500 "image not supported", which must fall through
      // to the vision-fallback path immediately).
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        const retryAfter = Number(res.headers.get("retry-after")) || Math.pow(2, attempt);
        await sleep(retryAfter * 1000);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        await sleep(Math.pow(2, attempt) * 700);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM request failed");
}

/**
 * SSE-streamed chat completion: assembles the full assistant message from
 * deltas while reporting growing answer text via onDelta. Tool-call argument
 * fragments arrive index-keyed and are concatenated.
 */
async function streamChat(
  body: Record<string, unknown>,
  ep: Endpoint,
  onDelta?: (partial: string) => void,
): Promise<ChatMessage> {
  const res = await callLLM({ ...body, stream_options: { include_usage: true } }, true, ep);
  if (!res.ok || !res.body) {
    throw new Error(`Local LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  let content = "";
  let usage: Usage | undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) {
        usage = { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 };
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta?.(content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        calls[idx] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[idx]!.id = tc.id;
        if (tc.function?.name) calls[idx]!.name += tc.function.name;
        if (tc.function?.arguments) calls[idx]!.args += tc.function.arguments;
      }
    }
  }

  const msg: ChatMessage = { role: "assistant", content, _usage: usage };
  const validCalls = calls.filter(Boolean);
  if (validCalls.length) {
    msg.tool_calls = validCalls.map((c, i) => ({
      id: c.id || `call_${i}`,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
  }
  return msg;
}

async function completeChat(body: Record<string, unknown>, ep: Endpoint): Promise<ChatMessage> {
  const res = await callLLM(body, false, ep);
  if (!res.ok) {
    throw new Error(`Local LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("Local LLM returned no choices — check LOCAL_LLM_BASE_URL and model");
  if (data.usage) msg._usage = { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 };
  return msg;
}

/**
 * Agent loop against an OpenAI-compatible local endpoint (unsloth serving
 * via vLLM / llama.cpp). Requires a model with function-calling support;
 * vision blocks work only if the served model is a VLM.
 */
export async function runTurnLocal(ctx: ToolCtx, blocks: UserBlock[], ep: Endpoint = primaryEndpoint()): Promise<string> {
  const tools = makeTools(ctx);
  const toolDefs = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const hasImages = blocks.some((b) => b.type === "image");
  const userContent =
    blocks.length === 1 && blocks[0]!.type === "text"
      ? blocks[0]!.text
      : blocks.map((b) =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.base64}` } },
        );

  // Text-only stand-in for models without vision: the saved file_name from the
  // accompanying text block keeps captions and compress_image working.
  const textOnlyContent = () =>
    blocks.map((b) => (b.type === "text" ? b.text : "[photo attached]")).join("\n") +
    "\n(Note: the current model cannot view images, so you CANNOT read this photo's contents. If the user wanted details extracted from it, apologise briefly and ask them to type the details instead. You CAN still compress the photo with compress_image using the file_name above.)";

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...ctx.session.history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: userContent },
  ];
  const userTurnIdx = messages.length - 1;

  const useStream = process.env.LOCAL_LLM_STREAM !== "off";
  let imageFallbackUsed = false;
  const maxIterations = Number(process.env.MAX_AGENT_ITERATIONS ?? 40);
  const total: Usage = { input: 0, output: 0 };
  let calls = 0;
  // Harness state: stuck-loop detection + stale-snapshot pruning.
  const SNAPSHOT_TOOLS = new Set(["browser_open", "browser_read", "browser_click", "browser_wait"]);
  const snapshotIdx: number[] = [];
  let lastSig = "";
  let repeat = 0;
  let noChangeStreak = 0;
  const logUsage = () =>
    console.log(`[llm chat ${ctx.chatId}] ${ep.model} · ${calls} call(s), tokens in=${total.input} out=${total.output}`);

  for (let i = 0; i < maxIterations; i++) {
    const body = { model: ep.model, messages, tools: toolDefs, tool_choice: "auto" };
    let msg: ChatMessage;
    try {
      msg = useStream ? await streamChat(body, ep, ctx.onDelta) : await completeChat(body, ep);
    } catch (e) {
      if (hasImages && !imageFallbackUsed) {
        imageFallbackUsed = true;
        ctx.onStatus?.("⚠️ Model can't see photos — continuing in text mode");
        messages[userTurnIdx]!.content = textOnlyContent();
        i--;
        continue;
      }
      throw e;
    }

    calls++;
    // Extract usage, then strip it — it's our own bookkeeping field and must
    // not be echoed back in the message history (strict APIs like Cerebras 400).
    const u = msg._usage;
    delete msg._usage;
    if (u) {
      total.input += u.input;
      total.output += u.output;
    }
    messages.push(msg);

    if (msg.tool_calls?.length) {
      // Stuck detection: is the model repeating the exact same action?
      const sig = msg.tool_calls.map((c) => `${c.function?.name}:${c.function?.arguments || ""}`).join("|");
      if (sig === lastSig) repeat++;
      else {
        repeat = 0;
        lastSig = sig;
      }

      let sawNoChange = false;
      for (const call of msg.tool_calls) {
        const name = call.function?.name ?? "";
        const tool = tools.find((t) => t.name === name);
        let result: string;
        if (!tool) {
          result = `Unknown tool '${name}'`;
        } else {
          try {
            result = await tool.run(JSON.parse(call.function?.arguments || "{}"));
          } catch (e) {
            result = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        if (name === "browser_click" && /NO visible change/i.test(result)) sawNoChange = true;

        // Context management: once a newer page snapshot arrives, blank out the
        // older ones — their refs are stale and the JSON is large.
        if (SNAPSHOT_TOOLS.has(name)) {
          for (const idx of snapshotIdx) {
            if (typeof messages[idx]!.content === "string") {
              messages[idx]!.content = "[Older page snapshot omitted — superseded by a newer one; those refs are stale.]";
            }
          }
          snapshotIdx.length = 0;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        if (SNAPSHOT_TOOLS.has(name)) snapshotIdx.push(messages.length - 1);
      }

      // Nudge the model out of a rut before it burns the whole budget.
      if (repeat >= 2 || (sawNoChange && ++noChangeStreak >= 2)) {
        messages.push({
          role: "user",
          content:
            "[system] That approach isn't working — you've repeated it with no progress. Do NOT try the same thing again. Either try a different element or approach, refresh the CAPTCHA and re-ask the user, or stop and tell the user plainly what's blocking and what you need from them.",
        });
        repeat = 0;
        lastSig = "";
        noChangeStreak = 0;
      } else if (!sawNoChange) {
        noChangeStreak = 0;
      }
      continue;
    }

    logUsage();
    return typeof msg.content === "string" && msg.content.trim()
      ? msg.content
      : "Hmm, mujhe samajh nahi aaya — dobara try karein?";
  }

  // Budget exhausted — ask for a useful status instead of dying generically.
  logUsage();
  messages.push({
    role: "user",
    content:
      "[system] You've used up the tool budget for this turn. Do NOT call any more tools. In one short message, tell the user what you accomplished, exactly what is blocking, and what you need from them to continue.",
  });
  try {
    const wrap = await streamChat({ model: ep.model, messages }, ep, ctx.onDelta);
    if (typeof wrap.content === "string" && wrap.content.trim()) return wrap.content;
  } catch {
    /* fall through to generic */
  }
  return "Main is task par kaafi der se atka hoon — thoda ruk kar phir se try karein, ya /reset karke naye sire se shuru karein. 🙏";
}
