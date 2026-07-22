import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api } from "grammy";
import type { ToolCtx } from "../src/tools";
import { startMockLlm, type MockLlm } from "./mock-llm";

const dataDir = mkdtempSync(path.join(tmpdir(), "hybrid-test-"));
const api = { async sendDocument() { return { message_id: 0 }; } } as unknown as Api;

let primary: MockLlm;
let vision: MockLlm;

beforeAll(async () => {
  primary = startMockLlm();
  vision = startMockLlm();
  process.env.DATA_DIR = dataDir;
  process.env.LLM_PROVIDER = "local";
  const { setConfig, resetConfigCache } = await import("../src/config");
  resetConfigCache();
  await setConfig({
    provider: "local",
    baseUrl: primary.url,
    model: "fast-text",
    apiKey: "",
    visionEnabled: true,
    visionBaseUrl: vision.url,
    visionModel: "vision-model",
    visionApiKey: "",
  });
});

afterAll(() => {
  primary.stop();
  vision.stop();
  delete process.env.LLM_PROVIDER;
});

test("text turn goes to the primary endpoint", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");
  const chatId = 601;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  const pBefore = primary.requests.length;
  const vBefore = vision.requests.length;
  primary.enqueue({ type: "text", text: "primary answered" });

  const reply = await runTurn(ctx, [{ type: "text", text: "hello" }]);
  expect(reply).toBe("primary answered");
  expect(primary.requests.length).toBe(pBefore + 1);
  expect(vision.requests.length).toBe(vBefore);
});

test("image turn is routed to the vision endpoint", async () => {
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");
  const chatId = 602;
  const session = await loadSession(chatId);
  const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };

  const pBefore = primary.requests.length;
  const vBefore = vision.requests.length;
  vision.enqueue({ type: "text", text: "vision read the photo" });

  const reply = await runTurn(ctx, [
    { type: "image", mediaType: "image/jpeg", base64: "aGk=" },
    { type: "text", text: "read my aadhaar" },
  ]);
  expect(reply).toBe("vision read the photo");
  expect(vision.requests.length).toBe(vBefore + 1);
  expect(primary.requests.length).toBe(pBefore); // primary untouched
});
