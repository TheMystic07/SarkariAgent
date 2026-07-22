import type { ToolCtx } from "./tools";
import type { UserBlock } from "./prompt";
import { runTurnLocal } from "./llm/local";
import { runTurnAnthropic } from "./llm/anthropic";
import { getConfig, primaryEndpoint, visionEndpoint } from "./config";

export type Provider = "local" | "anthropic";

export function activeProvider(): Provider {
  return getConfig().provider;
}

/**
 * Run one agent turn: let the model use tools until it produces a final text
 * answer, persist sanitized history, return the reply. In hybrid mode, a turn
 * containing a photo is routed to the vision endpoint; text turns use the
 * fast primary model.
 */
export async function runTurn(ctx: ToolCtx, blocks: UserBlock[]): Promise<string> {
  const hasImage = blocks.some((b) => b.type === "image");
  let reply: string;
  if (activeProvider() === "anthropic") {
    reply = await runTurnAnthropic(ctx, blocks);
  } else {
    const vision = hasImage ? visionEndpoint() : null;
    if (vision) ctx.onStatus?.(`👁️ Switching to vision model (${vision.model}) to read the photo`);
    reply = await runTurnLocal(ctx, blocks, vision ?? primaryEndpoint());
  }

  // Persist text only — images are replaced by placeholders so session files
  // stay small and photos aren't re-sent to the model every turn.
  const userText = blocks
    .map((b) => (b.type === "text" ? b.text : "[user sent a photo — see saved file mentioned above]"))
    .join("\n");
  ctx.session.history.push({ role: "user", content: userText });
  ctx.session.history.push({ role: "assistant", content: reply });
  if (ctx.session.history.length > 60) {
    ctx.session.history = ctx.session.history.slice(-60);
  }
  await ctx.save();
  return reply;
}
