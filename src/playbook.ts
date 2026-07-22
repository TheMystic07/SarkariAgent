import { mkdirSync } from "node:fs";
import path from "node:path";

// Playbooks are workspace-global (shared across users) — a task procedure is
// the same for everyone. They hold the PROCEDURE only, never any user's data.
function pbDir(): string {
  return path.join(process.env.DATA_DIR ?? "./data", "playbooks");
}

function slug(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "task"
  );
}

function pbFile(task: string): string {
  return path.join(pbDir(), `${slug(task)}.md`);
}

/**
 * Safety net so one user's data can never leak into the shared playbook via a
 * mistaken save. Redacts Aadhaar/mobile-like digit runs, emails, and OTPs.
 */
export function scrubPII(text: string): string {
  return text
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "«aadhaar»")
    .replace(/\b[6-9]\d{9}\b/g, "«mobile»")
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "«pan»")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]{2,}\b/g, "«email»")
    .replace(/\botp[:\s]*\d{4,8}\b/gi, "OTP «redacted»")
    .replace(/\b\d{4,8}\b(?=\s*(otp|code))/gi, "«redacted»");
}

export async function recallPlaybook(task: string): Promise<string | null> {
  const f = Bun.file(pbFile(task));
  return (await f.exists()) ? await f.text() : null;
}

export async function savePlaybook(task: string, notes: string): Promise<string> {
  mkdirSync(pbDir(), { recursive: true });
  const clean = scrubPII(notes).slice(0, 8000);
  await Bun.write(pbFile(task), clean);
  return clean;
}

export async function listPlaybooks(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  try {
    return readdirSync(pbDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}
