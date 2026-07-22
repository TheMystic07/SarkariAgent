import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { SYSTEM_PROMPT, type UserBlock } from "../prompt";
import { makeTools, type ToolCtx } from "../tools";

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

/** Agent loop on the Claude API — used when LLM_PROVIDER=anthropic. */
export async function runTurnAnthropic(ctx: ToolCtx, blocks: UserBlock[]): Promise<string> {
  const tools = makeTools(ctx).map((t) =>
    betaTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
      run: (input: unknown) => t.run(input),
    }),
  );

  const content: Anthropic.Beta.BetaContentBlockParam[] = blocks.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", source: { type: "base64", media_type: b.mediaType as "image/jpeg", data: b.base64 } },
  );

  const finalMessage = await getClient().beta.messages.toolRunner({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools,
    messages: [
      ...ctx.session.history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content },
    ],
    max_iterations: Number(process.env.MAX_AGENT_ITERATIONS ?? 40),
  });

  const text = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "…";
}
