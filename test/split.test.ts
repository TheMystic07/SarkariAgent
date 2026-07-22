import { expect, test } from "bun:test";
import { splitForTelegram } from "../src/bot";

test("short text stays one chunk", () => {
  expect(splitForTelegram("hello")).toEqual(["hello"]);
});

test("splits on line boundaries under the limit", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(90)}`);
  const chunks = splitForTelegram(lines.join("\n"), 500);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  // nothing lost
  expect(chunks.join("\n").replace(/\n/g, "")).toBe(lines.join("\n").replace(/\n/g, ""));
});

test("hard-splits a single over-long line", () => {
  const chunks = splitForTelegram("z".repeat(1200), 500);
  expect(chunks.length).toBe(3);
  expect(chunks.every((c) => c.length <= 500)).toBe(true);
  expect(chunks.join("")).toBe("z".repeat(1200));
});
