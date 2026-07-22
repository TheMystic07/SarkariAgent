import { afterEach, expect, test } from "bun:test";
import { consumeQuota } from "../src/quota";

afterEach(() => {
  delete process.env.DAILY_MSG_LIMIT;
});

test("quota blocks after the daily limit and resets next day", () => {
  process.env.DAILY_MSG_LIMIT = "2";
  const day1 = new Date("2026-07-22T10:00:00Z");
  expect(consumeQuota(901, day1).allowed).toBe(true);
  expect(consumeQuota(901, day1).allowed).toBe(true);
  expect(consumeQuota(901, day1).allowed).toBe(false);

  const day2 = new Date("2026-07-23T10:00:00Z");
  expect(consumeQuota(901, day2).allowed).toBe(true);
});

test("quotas are per chat", () => {
  process.env.DAILY_MSG_LIMIT = "1";
  const now = new Date("2026-07-22T10:00:00Z");
  expect(consumeQuota(902, now).allowed).toBe(true);
  expect(consumeQuota(903, now).allowed).toBe(true);
  expect(consumeQuota(902, now).allowed).toBe(false);
});

