import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  profile: Record<string, string>;
  history: ChatTurn[];
}

// Read lazily so DATA_DIR can be set after this module loads (tests, config).
function dataDir(): string {
  return process.env.DATA_DIR ?? "./data";
}

function chatDir(chatId: number): string {
  return path.join(dataDir(), String(chatId));
}

export function filesDir(chatId: number): string {
  const dir = path.join(chatDir(chatId), "files");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile(chatId: number): string {
  return path.join(chatDir(chatId), "session.json");
}

export async function loadSession(chatId: number): Promise<Session> {
  const file = Bun.file(sessionFile(chatId));
  if (await file.exists()) {
    try {
      return (await file.json()) as Session;
    } catch {
      // corrupted session — start fresh rather than crash the chat
    }
  }
  return { profile: {}, history: [] };
}

export async function saveSession(chatId: number, session: Session): Promise<void> {
  mkdirSync(chatDir(chatId), { recursive: true });
  await Bun.write(sessionFile(chatId), JSON.stringify(session, null, 2));
}

export function resetSession(chatId: number): void {
  if (existsSync(chatDir(chatId))) {
    rmSync(chatDir(chatId), { recursive: true, force: true });
  }
}
