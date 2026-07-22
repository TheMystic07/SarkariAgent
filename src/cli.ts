import path from "node:path";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Api, InputFile } from "grammy";
import { runTurn, activeProvider } from "./agent";
import { loadSession, saveSession, resetSession } from "./store";
import { hasWaiter, deliverToWaiter, cancelWaiter, waitForUserReply } from "./interaction";
import { closeAll } from "./browser";
import type { ToolCtx } from "./tools";

const CHAT_ID = 0;

function outboxDir(): string {
  const dir = path.join(process.env.DATA_DIR ?? "./data", String(CHAT_ID), "outbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Stand-in for grammy's Api: tools only ever call sendDocument, so we implement
// just that and write the file to disk instead of shipping it over Telegram.
const api = {
  async sendDocument(_chatId: number, doc: InputFile, opts?: { caption?: string }) {
    const name = doc.filename ?? "document";
    const outPath = path.join(outboxDir(), name);
    await Bun.write(outPath, (await doc.toRaw()) as Uint8Array);
    console.log(`  [outbox] ${outPath}${opts?.caption ? ` — ${opts.caption}` : ""}`);
    return { message_id: 0 };
  },
} as unknown as Api;

async function main(): Promise<void> {
  let session = await loadSession(CHAT_ID);
  console.log(
    `Sarkari Agent CLI — provider: ${activeProvider()}. Type "/reset" to clear the session, "exit" to quit.`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    // A reply the agent is blocked waiting on (CAPTCHA/OTP/confirm).
    if (hasWaiter(CHAT_ID)) {
      deliverToWaiter(CHAT_ID, text);
      continue;
    }
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "exit") break;
    if (text === "/reset") {
      cancelWaiter(CHAT_ID, "reset");
      await closeAll();
      resetSession(CHAT_ID);
      session = { profile: {}, history: [] };
      console.log("  session cleared.");
      rl.prompt();
      continue;
    }
    const ctx: ToolCtx = {
      chatId: CHAT_ID,
      api,
      session,
      save: () => saveSession(CHAT_ID, session),
      onStatus: (line) => console.log(`  [${line}]`),
      sendText: async (t) => console.log(`\nagent> ${t}\n`),
      sendPhoto: async (buf, caption) => {
        const out = path.join(outboxDir(), `shot_${Date.now()}.png`);
        await Bun.write(out, buf);
        console.log(`  [photo → ${out}${caption ? ` — ${caption}` : ""}]`);
      },
      waitForReply: (timeoutMs) => waitForUserReply(CHAT_ID, timeoutMs),
    };
    try {
      const reply = await runTurn(ctx, [{ type: "text", text }]);
      console.log(`\nagent> ${reply}\n`);
    } catch (err) {
      console.error("  error:", err instanceof Error ? err.message : err);
    }
    rl.prompt();
  }
  rl.close();
  await closeAll();
}

main();
