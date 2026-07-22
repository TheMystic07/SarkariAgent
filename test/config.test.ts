import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let prev: string | undefined;
beforeAll(async () => {
  prev = process.env.DATA_DIR;
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cfg-test-"));
  process.env.LOCAL_LLM_BASE_URL = "http://localhost:9999/v1";
  process.env.LOCAL_LLM_MODEL = "seed-model";
  const { resetConfigCache } = await import("../src/config");
  resetConfigCache();
});
afterAll(() => {
  if (prev === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prev;
});

test("config seeds from env, then setConfig overrides and persists", async () => {
  const { getConfig, setConfig } = await import("../src/config");
  const c0 = getConfig();
  expect(c0.model).toBe("seed-model");
  expect(c0.baseUrl).toBe("http://localhost:9999/v1");

  const c1 = await setConfig({ model: "gpt-5.5", baseUrl: "https://x.azure.com/openai/v1/", apiKey: "k123" });
  expect(c1.model).toBe("gpt-5.5");
  expect(c1.baseUrl).toBe("https://x.azure.com/openai/v1"); // trailing slash trimmed
  expect(getConfig().apiKey).toBe("k123");
});

test("setConfig without apiKey keeps the existing key", async () => {
  const { getConfig, setConfig } = await import("../src/config");
  await setConfig({ model: "another" });
  expect(getConfig().apiKey).toBe("k123");
  expect(getConfig().model).toBe("another");
});
