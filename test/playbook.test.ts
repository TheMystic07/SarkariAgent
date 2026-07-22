import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let prev: string | undefined;
beforeAll(() => {
  prev = process.env.DATA_DIR;
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "pb-test-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prev;
});

test("scrubPII strips personal data", async () => {
  const { scrubPII } = await import("../src/playbook");
  const dirty = "Filled aadhaar 2345 6789 0123, mobile 9876543210, email ravi@x.com, PAN ABCDE1234F, OTP: 123456";
  const clean = scrubPII(dirty);
  expect(clean).not.toContain("2345 6789 0123");
  expect(clean).not.toContain("9876543210");
  expect(clean).not.toContain("ravi@x.com");
  expect(clean).not.toContain("ABCDE1234F");
  expect(clean).not.toContain("123456");
  expect(clean).toContain("«aadhaar»");
  expect(clean).toContain("«mobile»");
});

test("save then recall round-trips the procedure and scrubs PII", async () => {
  const { savePlaybook, recallPlaybook } = await import("../src/playbook");
  expect(await recallPlaybook("voter-new")).toBeNull();

  await savePlaybook(
    "voter-new",
    "1. Open voters.eci.gov.in\n2. Click 'Fill Form 6'\n3. CAPTCHA is case-sensitive\n(user aadhaar 1234 5678 9012)",
  );
  const pb = await recallPlaybook("voter-new");
  expect(pb).toContain("Fill Form 6");
  expect(pb).toContain("case-sensitive");
  expect(pb).not.toContain("1234 5678 9012"); // PII stripped even if included
});

test("task keys are slugged consistently", async () => {
  const { savePlaybook, recallPlaybook } = await import("../src/playbook");
  await savePlaybook("Aadhaar Download!!", "step one");
  expect(await recallPlaybook("aadhaar-download")).toBe("step one");
});
