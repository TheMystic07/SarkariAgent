import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api } from "grammy";
import type { ToolCtx } from "../src/tools";
import * as browser from "../src/browser";
import { startMockLlm, type MockLlm } from "./mock-llm";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "conc-test-"));
  // each request echoes its ?id= into the page so we can prove session isolation
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const id = new URL(req.url).searchParams.get("id") ?? "0";
      return new Response(`<button>FORM-${id}</button><input name="f${id}">`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterEach(() => {
  delete process.env.MAX_BROWSER_SESSIONS;
});

afterAll(async () => {
  await browser.closeAll();
  server.stop(true);
});

test("many browser sessions run in parallel, each isolated", async () => {
  const ids = [5001, 5002, 5003, 5004, 5005, 5006];
  const results = await Promise.all(
    ids.map(async (chatId) => {
      await browser.open(chatId, `${base}/?id=${chatId}`);
      const snap = await browser.snapshot(chatId);
      const sawOwnForm = snap.elements.some((e) => e.text === `FORM-${chatId}`);
      const sawOtherForm = snap.elements.some((e) => e.text?.startsWith("FORM-") && e.text !== `FORM-${chatId}`);
      return { chatId, sawOwnForm, sawOtherForm };
    }),
  );
  for (const r of results) {
    expect(r.sawOwnForm).toBe(true); // each session sees its own page
    expect(r.sawOtherForm).toBe(false); // and never another session's page
  }
  await Promise.all(ids.map((id) => browser.closeSession(id)));
}, 30000);

test("session cap degrades gracefully instead of blowing up", async () => {
  process.env.MAX_BROWSER_SESSIONS = "2";
  await browser.open(6001, `${base}/?id=1`);
  await browser.open(6002, `${base}/?id=2`);
  // third fresh session exceeds the cap and there's nothing idle to reclaim
  await expect(browser.open(6003, `${base}/?id=3`)).rejects.toThrow(/many form-filling sessions/i);
  // existing sessions keep working
  const snap = await browser.snapshot(6001);
  expect(snap.elements.some((e) => e.text === "FORM-1")).toBe(true);
  await browser.closeSession(6001);
  await browser.closeSession(6002);
}, 30000);

test("parallel agent turns keep each chat's session state isolated", async () => {
  const mock: MockLlm = startMockLlm();
  process.env.LLM_PROVIDER = "local";
  process.env.LOCAL_LLM_BASE_URL = mock.url;
  const { resetConfigCache } = await import("../src/config");
  resetConfigCache();
  const { runTurn } = await import("../src/agent");
  const { loadSession, saveSession } = await import("../src/store");
  const api = { async sendDocument() { return { message_id: 0 }; } } as unknown as Api;

  const ids = [7101, 7102, 7103, 7104, 7105];
  // each session does a single no-tool turn; replies are interchangeable
  for (const _ of ids) mock.enqueue({ type: "text", text: "ok" });

  await Promise.all(
    ids.map(async (chatId) => {
      const session = await loadSession(chatId);
      const ctx: ToolCtx = { chatId, api, session, save: () => saveSession(chatId, session) };
      await runTurn(ctx, [{ type: "text", text: `msg-${chatId}` }]);
    }),
  );

  // each chat's persisted history contains ITS OWN message, never another's
  for (const chatId of ids) {
    const s = await loadSession(chatId);
    expect(s.history.length).toBe(2);
    expect(s.history[0]?.content).toBe(`msg-${chatId}`);
  }
  mock.stop();
  delete process.env.LLM_PROVIDER;
}, 30000);
