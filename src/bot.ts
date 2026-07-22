import path from "node:path";
import { randomUUID } from "node:crypto";
import { Bot, InputFile, type Api, type Context } from "grammy";
import { runTurn, activeProvider } from "./agent";
import type { UserBlock } from "./prompt";
import { loadSession, saveSession, resetSession, filesDir } from "./store";
import { listServices } from "./services/registry";
import { mdToTelegramHtml, mdToPlain } from "./format";
import { consumeQuota } from "./quota";
import { hasWaiter, deliverToWaiter, cancelWaiter, waitForUserReply } from "./interaction";
import { closeSession } from "./browser";
import type { ToolCtx } from "./tools";

const WELCOME = `नमस्ते! 🙏 I'm Sarkari Agent — I help you prepare Indian government applications right here in chat.

I can help with:
• PAN card (new)
• Aadhaar — address update & e-Aadhaar download
• Voter ID (Form 6)
• Learner's driving licence
• Govt job portals — SSC registration, NCS

Just tell me what you need, in any language — "PAN card banwana hai", "வாக்காளர் அடையாள அட்டை வேணும்", whatever works for you.

You can also send photos of your documents (Aadhaar etc.) and I'll read the details, plus compress photos to fit portal size limits.

⚠️ I prepare everything; YOU do the final submit + OTP on the official portal. I never handle OTPs.

Commands:
/services — list supported services
/profile — see what I've saved about you
/reset — forget everything about you`;

// One turn at a time per chat — Telegram users double-send constantly.
const locks = new Map<number, Promise<unknown>>();

function withChatLock<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(chatId, next.catch(() => {}));
  return next;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("aadhaar") || k.includes("pan");
}

function maskValue(value: string): string {
  const last4 = value.slice(-4);
  return `•••• ${last4}`;
}

function servicesText(): string {
  const lines = listServices().map((s) => `• ${s.name} — ${s.fee}`);
  return `Services I can help with:\n\n${lines.join("\n")}\n\nJust tell me which one you want.`;
}

function profileText(profile: Record<string, string>): string {
  const keys = Object.keys(profile);
  if (keys.length === 0) {
    return "I haven't saved anything about you yet. Tell me what you need and I'll start filling in your details. 🙏";
  }
  const lines = keys.map((key) => {
    const value = isSensitiveKey(key) ? maskValue(profile[key]!) : profile[key]!;
    return `• ${key}: ${value}`;
  });
  return `Here's what I've saved about you:\n\n${lines.join("\n")}`;
}

async function downloadTelegramFile(ctx: Context, token: string): Promise<{ buffer: Buffer; ext: string }> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const ext = path.extname(file.file_path ?? "").toLowerCase() || ".jpg";
  return { buffer: Buffer.from(await res.arrayBuffer()), ext };
}

// Streams progress into the chat using Bot API 9.3+/10.1+ drafts: tool activity
// renders as a native "thinking" block, the answer streams as draft text.
// Drafts are ephemeral 30s previews — the real reply is always sent at the end.
function makeDraftStreamer(ctx: Context, chatId: number) {
  const draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
  const statusLines: string[] = [];
  let lastSent = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const push = (fn: () => Promise<unknown>) => {
    const now = Date.now();
    const fire = () => {
      lastSent = Date.now();
      fn().catch(() => {});
    };
    if (now - lastSent >= 900) {
      fire();
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        fire();
      }, 900 - (now - lastSent));
    }
  };

  return {
    onStatus: (line: string) => {
      statusLines.push(line);
      const text = statusLines.slice(-6).join("\n");
      push(() =>
        ctx.api.sendRichMessageDraft(chatId, draftId, {
          blocks: [{ type: "thinking", text }],
        }),
      );
    },
    onDelta: (partial: string) => {
      push(() => ctx.api.sendMessageDraft(chatId, draftId, mdToPlain(partial).slice(0, 3900)));
    },
    stop: () => {
      if (pending) clearTimeout(pending);
    },
  };
}

// Telegram caps messages at 4096 chars. Split long replies on paragraph/line
// boundaries so a long cheat sheet or scheme list doesn't throw.
export function splitForTelegram(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > limit) {
      if (cur) chunks.push(cur);
      cur = "";
      // a single over-long line: hard-split it
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      cur = rest;
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function sendReply(ctx: Context, reply: string): Promise<void> {
  for (const chunk of splitForTelegram(reply)) {
    try {
      await ctx.reply(mdToTelegramHtml(chunk), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await ctx.reply(chunk);
    }
  }
}

async function handleTurn(ctx: Context, blocks: UserBlock[]): Promise<void> {
  const chatId = ctx.chat!.id;
  const quota = consumeQuota(chatId);
  if (!quota.allowed) {
    await ctx.reply(
      `⏳ Aaj ki limit (${quota.limit} messages) khatam ho gayi hai. Kal phir se try karein 🙏`,
    );
    return;
  }
  await withChatLock(chatId, async () => {
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
    await ctx.replyWithChatAction("typing").catch(() => {});
    const streamer = makeDraftStreamer(ctx, chatId);
    try {
      const session = await loadSession(chatId);
      const toolCtx: ToolCtx = {
        chatId,
        api: ctx.api,
        session,
        save: () => saveSession(chatId, session),
        onStatus: streamer.onStatus,
        onDelta: streamer.onDelta,
        sendText: (text) => ctx.reply(text).then(() => undefined),
        sendPhoto: async (buffer, caption) => {
          try {
            await ctx.replyWithPhoto(new InputFile(buffer, "shot.png"), { caption });
          } catch (e) {
            // photo constraints can reject some images — always get it through as a file
            console.error(`[chat ${chatId}] sendPhoto failed, sending as document:`, e);
            await ctx.replyWithDocument(new InputFile(buffer, "screenshot.png"), { caption });
          }
        },
        waitForReply: (timeoutMs) => waitForUserReply(chatId, timeoutMs),
      };
      const reply = await runTurn(toolCtx, blocks);
      await sendReply(ctx, reply);
    } catch (err) {
      console.error(`[chat ${chatId}]`, err);
      await ctx.reply(
        "⚠️ Something went wrong on my side. Try again in a moment, or /reset if it keeps happening.",
      );
    } finally {
      streamer.stop();
      clearInterval(typing);
    }
  });
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command("start", (ctx) => ctx.reply(WELCOME));

  bot.command("services", (ctx) => ctx.reply(servicesText()));

  bot.command("profile", async (ctx) => {
    const session = await loadSession(ctx.chat.id);
    await ctx.reply(profileText(session.profile));
  });

  bot.command("reset", async (ctx) => {
    cancelWaiter(ctx.chat.id, "reset");
    await closeSession(ctx.chat.id);
    resetSession(ctx.chat.id);
    await ctx.reply("Done — I've stopped any form I was filling and deleted your saved details, photos and chat history. Fresh start! 🙏");
  });

  bot.command("stop", async (ctx) => {
    cancelWaiter(ctx.chat.id, "stop");
    await closeSession(ctx.chat.id);
    await ctx.reply("Stopped the form-filling session. Your saved details are kept — say the word to continue.");
  });

  bot.on("message:text", (ctx) => {
    // A reply the agent is blocked waiting on (CAPTCHA/OTP/confirm) resolves the
    // paused tool instead of starting a fresh turn.
    if (hasWaiter(ctx.chat.id)) {
      deliverToWaiter(ctx.chat.id, ctx.message.text);
      return;
    }
    return handleTurn(ctx, [{ type: "text", text: ctx.message.text }]);
  });

  bot.on(["message:photo", "message:document"], async (ctx) => {
    if (hasWaiter(ctx.chat.id)) {
      deliverToWaiter(ctx.chat.id, ctx.message.caption ?? "(user sent a photo)");
      return;
    }
    const doc = ctx.message.document;
    if (doc && !(doc.mime_type ?? "").startsWith("image/")) {
      await ctx.reply("I can only read images for now — please send documents as photos or image files.");
      return;
    }
    try {
      const { buffer, ext } = await downloadTelegramFile(ctx, token);
      const fileName = `${randomUUID().slice(0, 8)}${ext}`;
      await Bun.write(path.join(filesDir(ctx.chat.id), fileName), buffer);

      const mediaType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const caption = ctx.message.caption?.trim();
      const blocks: UserBlock[] = [
        { type: "image", mediaType, base64: buffer.toString("base64") },
        {
          type: "text",
          text: `${caption ? caption + "\n" : ""}(photo saved as file_name: ${fileName}, ${Math.round(buffer.length / 1024)}KB — use this file_name if compression is needed)`,
        },
      ];
      await handleTurn(ctx, blocks);
    } catch (err) {
      console.error(`[chat ${ctx.chat.id}] photo error`, err);
      await ctx.reply("⚠️ Couldn't download that photo — please try sending it again.");
    }
  });

  bot.catch((err) => console.error("bot error:", err.error));

  console.log(`LLM provider: ${activeProvider()}`);
  return bot;
}

export function registerCommandMenu(api: Api): Promise<unknown> {
  return api.setMyCommands([
    { command: "start", description: "What Sarkari Agent can do" },
    { command: "services", description: "List supported government services" },
    { command: "profile", description: "Show your saved details" },
    { command: "stop", description: "Stop the current form-filling session" },
    { command: "reset", description: "Forget everything about you" },
  ]);
}
