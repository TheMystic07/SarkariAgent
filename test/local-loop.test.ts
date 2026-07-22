import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api } from "grammy";
import type { ToolCtx } from "../src/tools";
import { startMockLlm, type MockLlm } from "./mock-llm";

// store.ts reads DATA_DIR once at import time, so set it before any src module
// is dynamically imported inside the tests below.
const dataDir = mkdtempSync(path.join(tmpdir(), "sahayak-test-"));
process.env.DATA_DIR = dataDir;
process.env.LLM_PROVIDER = "local";

// Stub grammy Api — no tool in these tests sends a document, so a no-op is enough.
const api = {
  async sendDocument() {
    return { message_id: 0 };
  },
} as unknown as Api;

let mock: MockLlm;

beforeAll(async () => {
  mock = startMockLlm();
  process.env.DATA_DIR = dataDir; // reassert ours (other test files mutate it)
  process.env.LOCAL_LLM_BASE_URL = mock.url;
  const { resetConfigCache } = await import("../src/config");
  resetConfigCache();
});

afterAll(() => {
  mock.stop();
});

interface RequestBody {
  messages: { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
}

test("local loop: two tool calls then final text, with history persisted", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");

  const chatId = 101;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  const FINAL = "PAN card ke liye ye details chahiye. Chaliye shuru karein.";
  const before = mock.requests.length;
  mock.enqueue(
    { type: "tool", calls: [{ name: "list_services", arguments: {} }] },
    { type: "tool", calls: [{ name: "get_service_details", arguments: { service_id: "pan-new" } }] },
    { type: "text", text: FINAL },
  );

  const reply = await runTurn(ctx, [{ type: "text", text: "PAN card banwana hai" }]);

  expect(reply).toBe(FINAL);
  expect(mock.requests.length - before).toBe(3);

  // The final request should carry both tool results back, each linked to the
  // tool_call id the mock handed out in the preceding assistant messages.
  const third = mock.requests[before + 2] as RequestBody;
  const toolMsgs = third.messages.filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBe(2);
  const callIds = new Set(
    third.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)),
  );
  for (const m of toolMsgs) {
    expect(m.tool_call_id).toBeTruthy();
    expect(callIds.has(m.tool_call_id!)).toBe(true);
  }

  const reloaded = await loadSession(chatId);
  expect(reloaded.history.length).toBe(2);
  expect(reloaded.history[0]?.role).toBe("user");
  expect(reloaded.history[1]?.role).toBe("assistant");
  expect(reloaded.history[1]?.content).toBe(FINAL);
});

test("local loop: save_profile_fields persists to session profile", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");

  const chatId = 202;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  mock.enqueue(
    {
      type: "tool",
      calls: [{ name: "save_profile_fields", arguments: { entries: [{ key: "full_name", value: "Test User" }] } }],
    },
    { type: "text", text: "Naam save ho gaya." },
  );

  const reply = await runTurn(ctx, [{ type: "text", text: "mera naam Test User hai" }]);

  expect(reply).toBe("Naam save ho gaya.");
  expect(session.profile.full_name).toBe("Test User");

  const reloaded = await loadSession(chatId);
  expect(reloaded.profile.full_name).toBe("Test User");
});

test("harness: repeating the same tool call injects a corrective nudge", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");

  const chatId = 404;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  const before = mock.requests.length;
  // same no-op tool call three times, then a final answer
  mock.enqueue(
    { type: "tool", calls: [{ name: "get_profile", arguments: {} }] },
    { type: "tool", calls: [{ name: "get_profile", arguments: {} }] },
    { type: "tool", calls: [{ name: "get_profile", arguments: {} }] },
    { type: "text", text: "ok done" },
  );

  const reply = await runTurn(ctx, [{ type: "text", text: "loop please" }]);
  expect(reply).toBe("ok done");

  // the request that produced the final answer must contain the harness nudge
  const last = mock.requests[mock.requests.length - 1] as { messages: { role: string; content: unknown }[] };
  const nudged = last.messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("That approach isn't working"),
  );
  expect(nudged).toBe(true);
});

test("harness: older page snapshots are pruned from history", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");

  const chatId = 505;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  // two browser_read calls (unregistered here, but the harness prunes by name), then text
  mock.enqueue(
    { type: "tool", calls: [{ name: "browser_read", arguments: {} }] },
    { type: "tool", calls: [{ name: "browser_read", arguments: {} }] },
    { type: "text", text: "read done" },
  );

  const reply = await runTurn(ctx, [{ type: "text", text: "read the page" }]);
  expect(reply).toBe("read done");

  const last = mock.requests[mock.requests.length - 1] as { messages: { role: string; content: unknown }[] };
  const toolMsgs = last.messages.filter((m) => m.role === "tool");
  // first snapshot result stubbed, latest kept
  expect(toolMsgs[0]!.content).toContain("Older page snapshot omitted");
  expect(toolMsgs[toolMsgs.length - 1]!.content).not.toContain("Older page snapshot omitted");
});

test("local loop: image input falls back to text mode when the model rejects it", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");

  const chatId = 303;
  const session = await loadSession(chatId);
  const statuses: string[] = [];
  const ctx: ToolCtx = {
    chatId,
    api,
    session,
    save: () => saveSession(chatId, session),
    onStatus: (line) => statuses.push(line),
  };

  const FINAL = "Photo mil gayi, par main ise padh nahi sakta — details type kar dein.";
  const before = mock.requests.length;
  mock.enqueue(
    { type: "error", status: 500, message: "image input is not supported - hint: provide the mmproj" },
    { type: "text", text: FINAL },
  );

  const reply = await runTurn(ctx, [
    { type: "image", mediaType: "image/jpeg", base64: "aGVsbG8=" },
    { type: "text", text: "(photo saved as file_name: abc123.jpg, 42KB)" },
  ]);

  expect(reply).toBe(FINAL);
  expect(mock.requests.length - before).toBe(2);

  // Retry must carry no image content, keep the file_name, and explain the limitation.
  const retry = mock.requests[before + 1] as { messages: { role: string; content: unknown }[] };
  const userMsg = retry.messages.findLast((m) => m.role === "user")!;
  expect(typeof userMsg.content).toBe("string");
  expect(userMsg.content as string).toContain("abc123.jpg");
  expect(userMsg.content as string).toContain("cannot view images");
  expect(statuses.some((s) => s.includes("text mode"))).toBe(true);
});
