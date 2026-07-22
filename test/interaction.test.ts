import { expect, test } from "bun:test";
import { hasWaiter, deliverToWaiter, cancelWaiter, waitForUserReply } from "../src/interaction";

test("deliverToWaiter resolves a pending wait", async () => {
  const p = waitForUserReply(11, 5000);
  expect(hasWaiter(11)).toBe(true);
  expect(deliverToWaiter(11, "ABCD1")).toBe(true);
  expect(await p).toBe("ABCD1");
  expect(hasWaiter(11)).toBe(false);
});

test("deliverToWaiter returns false when nothing waits", () => {
  expect(deliverToWaiter(999, "x")).toBe(false);
});

test("waitForUserReply times out", async () => {
  const p = waitForUserReply(12, 50);
  await expect(p).rejects.toThrow("timeout");
  expect(hasWaiter(12)).toBe(false);
});

test("cancelWaiter rejects a pending wait", async () => {
  const p = waitForUserReply(13, 5000);
  cancelWaiter(13, "reset");
  await expect(p).rejects.toThrow("reset");
});
