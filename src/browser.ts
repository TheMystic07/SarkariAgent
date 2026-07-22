import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { filesDir } from "./store";

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

// One shared browser process; each chat gets a cheap isolated context. Launching
// a context is ~50ms vs ~1-2s to launch a whole browser.
let shared: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (shared?.isConnected()) return shared;
  shared = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--mute-audio",
    ],
  });
  return shared;
}

export interface PageElement {
  ref: number;
  tag: string;
  type: string;
  label: string;
  value?: string;
  checked?: boolean;
  options?: string[];
  text?: string;
}

const sessions = new Map<number, BrowserSession>();
const IDLE_MS = 15 * 60 * 1000;
let sweeper: ReturnType<typeof setInterval> | null = null;

// Captured browser downloads (e-Aadhaar PDF, etc.) so the agent can push them
// into the chat instead of them vanishing into the headless download folder.
let dlSeq = 0;
const lastDownload = new Map<number, { seq: number; path: string; filename: string }>();

function attachDownloads(chatId: number, page: Page): void {
  page.on("download", async (dl) => {
    const seq = ++dlSeq;
    try {
      const name = path.basename(dl.suggestedFilename() || `download_${seq}`);
      const dest = path.join(filesDir(chatId), name);
      await dl.saveAs(dest);
      lastDownload.set(chatId, { seq, path: dest, filename: name });
    } catch {
      /* ignore failed downloads */
    }
  });
}

function startSweeper(): void {
  sweeper ??= setInterval(() => {
    const now = Date.now();
    for (const [chatId, s] of sessions) {
      if (now - s.lastUsed > IDLE_MS) void closeSession(chatId);
    }
  }, 60_000);
  // don't keep the process alive just for the sweeper
  (sweeper as unknown as { unref?: () => void }).unref?.();
}

const maxSessions = () => Number(process.env.MAX_BROWSER_SESSIONS ?? 12);

async function getSession(chatId: number): Promise<BrowserSession> {
  let s = sessions.get(chatId);
  if (s) {
    s.lastUsed = Date.now();
    return s;
  }
  // Cap concurrent browser sessions so many parallel users don't exhaust memory.
  // Reclaim the most-idle session if it's been idle a while; otherwise degrade
  // gracefully (the tool relays a "busy, try again" message to that user).
  if (sessions.size >= maxSessions()) {
    let idlest: [number, BrowserSession] | undefined;
    for (const e of sessions) if (!idlest || e[1].lastUsed < idlest[1].lastUsed) idlest = e;
    if (idlest && Date.now() - idlest[1].lastUsed > 120_000) {
      await closeSession(idlest[0]);
    } else {
      throw new Error(
        "The system is handling many form-filling sessions right now. Ask the user to try again in a minute.",
      );
    }
  }
  startSweeper();
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1000, height: 1400 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    locale: "en-IN",
  });
  context.setDefaultTimeout(20_000);
  // Skip fonts, media and common trackers — not needed to fill a form, and they
  // are the bulk of page-load time. Images (incl. CAPTCHA), CSS and JS pass through.
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "font" || t === "media") return route.abort();
    const url = route.request().url();
    if (/googletagmanager|google-analytics|doubleclick|facebook\.net|hotjar|clarity\.ms/.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
  context.on("page", (p) => attachDownloads(chatId, p));
  const page = await context.newPage();
  attachDownloads(chatId, page);
  s = { context, page, lastUsed: Date.now() };
  sessions.set(chatId, s);
  return s;
}

export function hasSession(chatId: number): boolean {
  return sessions.has(chatId);
}

export async function closeSession(chatId: number): Promise<void> {
  const s = sessions.get(chatId);
  if (!s) return;
  sessions.delete(chatId);
  lastDownload.delete(chatId);
  await s.context.close().catch(() => {});
}

export async function closeAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeSession));
  await shared?.close().catch(() => {});
  shared = null;
}

/**
 * Wait for a JS-rendered form to actually populate. Government portals are
 * SPAs that render fields well after domcontentloaded; polling for real
 * controls avoids snapshotting an empty shell.
 */
function interactiveCount(page: Page): Promise<number> {
  return page
    .evaluate(
      () =>
        document.querySelectorAll("input:not([type=hidden]),select,textarea,button,a[href],[role=button]").length,
    )
    .catch(() => 0);
}

async function waitForForm(page: Page, maxMs = 15_000): Promise<number> {
  const deadline = Date.now() + maxMs;
  let count = 0;
  while (Date.now() < deadline) {
    // Any interactive element means the SPA has rendered something actionable —
    // including nav links on a landing page (the agent clicks through to the form).
    count = await interactiveCount(page);
    if (count > 0) break;
    await page.waitForTimeout(500);
  }
  await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
  return count;
}

export async function open(chatId: number, url: string): Promise<string> {
  const { page } = await getSession(chatId);
  page.setDefaultNavigationTimeout(45_000);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (e) {
    // some portals never fire a clean load event but are usable anyway
    if (!/timeout/i.test(e instanceof Error ? e.message : "")) throw e;
  }
  const count = await waitForForm(page);
  const note = count === 0 ? " (nothing interactive rendered — page may be very slow or unreachable)" : "";
  return `Opened ${page.url()} — "${await page.title()}"${note}`;
}

const ENUMERATE = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const labelFor = (el) => {
    if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) { const l = document.querySelector('label[for="' + (window.CSS ? CSS.escape(el.id) : el.id) + '"]'); if (l) return l.innerText.trim(); }
    const pl = el.closest && el.closest('label'); if (pl) return pl.innerText.trim();
    if (el.placeholder) return el.placeholder;
    if (el.name) return el.name;
    return '';
  };
  const nodes = Array.from(document.querySelectorAll('input,textarea,select,button,a[href],[role=button]'));
  const out = [];
  let i = 0;
  for (const el of nodes) {
    const type = ((el.type || el.tagName) + '').toLowerCase();
    if (type === 'hidden') continue;
    // file inputs are often visually hidden behind a styled button, but
    // setInputFiles works on them anyway — always expose them.
    if (type !== 'file' && !vis(el)) continue;
    el.setAttribute('data-af-ref', String(i));
    const item = { ref: i, tag: el.tagName.toLowerCase(), type, label: (labelFor(el) || '').slice(0, 80) };
    if (el.tagName === 'SELECT') item.options = Array.from(el.options).map(o => o.value || o.text).slice(0, 60);
    if ('value' in el && el.value) item.value = (el.value + '').slice(0, 60);
    if (type === 'checkbox' || type === 'radio') item.checked = el.checked;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') item.text = (el.innerText || '').trim().slice(0, 60);
    out.push(item);
    if (++i > 140) break;
  }
  return out;
})()`;

export async function snapshot(chatId: number): Promise<{ url: string; title: string; elements: PageElement[] }> {
  const { page } = await getSession(chatId);
  const all = (await page.evaluate(ENUMERATE)) as PageElement[];
  // Form controls are what matters; keep every input/select/textarea/button but
  // cap noisy nav links so the payload the model reads stays small and fast.
  const controls = all.filter((e) => e.tag !== "a");
  const links = all.filter((e) => e.tag === "a").slice(0, 20);
  return { url: page.url(), title: await page.title(), elements: [...controls, ...links] };
}

function sel(ref: number): string {
  return `[data-af-ref="${ref}"]`;
}

export async function fill(chatId: number, ref: number, value: string): Promise<string> {
  const { page } = await getSession(chatId);
  const loc = page.locator(sel(ref));
  if ((await loc.count()) === 0) return `No element ref ${ref} — call browser_read again (the page changed).`;
  await loc.fill(value);
  return `Filled ref ${ref}.`;
}

export interface FieldOp {
  ref: number;
  value: string;
  type?: "text" | "select";
}

/** Fill many fields in one shot — text via fill, dropdowns via select. */
export async function fillFields(chatId: number, fields: FieldOp[]): Promise<string> {
  const done: number[] = [];
  const failed: string[] = [];
  for (const f of fields) {
    try {
      const msg =
        f.type === "select" ? await select(chatId, f.ref, f.value) : await fill(chatId, f.ref, f.value);
      if (msg.startsWith("No element") || msg.startsWith("Could not")) failed.push(`ref ${f.ref}: ${msg}`);
      else done.push(f.ref);
    } catch (e) {
      failed.push(`ref ${f.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let out = `Filled ${done.length} field(s): ${done.join(", ")}.`;
  if (failed.length) out += ` Failed: ${failed.join("; ")} — call browser_read and retry those.`;
  return out;
}

const bodyTextLen = (page: Page): Promise<number> =>
  page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);

async function pageHints(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const t = (document.body?.innerText || "").toLowerCase();
      const keys = [
        "invalid captcha",
        "incorrect captcha",
        "wrong captcha",
        "captcha expired",
        "otp sent",
        "otp has been sent",
        "enter otp",
        "enter the otp",
        "invalid",
        "expired",
        "try again",
        "please wait",
      ];
      return keys.filter((k) => t.includes(k));
    })
    .catch(() => [] as string[]);
}

export async function click(chatId: number, ref: number): Promise<string> {
  const { page } = await getSession(chatId);
  const loc = page.locator(sel(ref));
  if ((await loc.count()) === 0) return `No element ref ${ref} — call browser_read again (the page changed).`;

  const before = page.url();
  const beforeCount = await interactiveCount(page);
  const beforeText = await bodyTextLen(page);

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await loc.click({ timeout: 8000 });
  } catch (e) {
    // an overlay/animation can intercept the first click — try once forcing it
    try {
      await loc.click({ force: true, timeout: 4000 });
    } catch {
      return `Could NOT click ref ${ref}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}. The button may be disabled until the form is valid (e.g. CAPTCHA not yet entered), or hidden behind an overlay.`;
    }
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});

  let outcome: string;
  if (page.url() !== before) {
    await waitForForm(page);
    outcome = `navigated to ${page.url()}`;
  } else {
    // AJAX in-page update (OTP field appears, error shows) — wait for it to settle
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    let changed = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const nowCount = await interactiveCount(page);
      const nowText = await bodyTextLen(page);
      if (nowCount !== beforeCount || Math.abs(nowText - beforeText) > 15) {
        changed = true;
        break;
      }
      await page.waitForTimeout(300);
    }
    outcome = changed
      ? "the page updated in place (new content/fields appeared)"
      : "NO visible change — the click may not have registered, or the button is disabled/needs a valid CAPTCHA. Screenshot the page to check for an inline error, and consider refreshing the CAPTCHA and retrying";
  }

  const hints = await pageHints(page);
  const hintStr = hints.length ? ` Page now mentions: "${hints.join('", "')}".` : "";
  return `Clicked ref ${ref}. Result: ${outcome}.${hintStr}`;
}

export async function select(chatId: number, ref: number, value: string): Promise<string> {
  const { page } = await getSession(chatId);
  const loc = page.locator(sel(ref));
  if ((await loc.count()) === 0) return `No element ref ${ref} — call browser_read again (the page changed).`;
  // Try by value first (fast, matches most forms), then by visible label.
  try {
    await loc.selectOption(value, { timeout: 4000 });
    return `Selected "${value}" in ref ${ref}.`;
  } catch {
    /* fall through */
  }
  try {
    await loc.selectOption({ label: value }, { timeout: 4000 });
    return `Selected "${value}" in ref ${ref}.`;
  } catch {
    return `Could not select "${value}" in ref ${ref} — the option may not exist; call browser_read to see valid options.`;
  }
}

export async function waitAndSnapshot(
  chatId: number,
  seconds = 6,
): Promise<{ url: string; title: string; elements: PageElement[] }> {
  const { page } = await getSession(chatId);
  await page.waitForTimeout(Math.min(seconds, 15) * 1000);
  await waitForForm(page, 8000);
  return snapshot(chatId);
}

export type DownloadResult = { path: string; filename: string } | { error: string };

/**
 * Get a downloaded file to send to the user. With no ref, returns the most
 * recent download (e.g. a PDF the agent already triggered). With a ref, clicks
 * that button and waits for the resulting download.
 */
export async function captureDownload(chatId: number, ref?: number, timeoutMs = 30_000): Promise<DownloadResult> {
  const { page } = await getSession(chatId);
  if (ref === undefined) {
    const d = lastDownload.get(chatId);
    return d ? { path: d.path, filename: d.filename } : { error: "No downloaded file yet — click the Download button (pass its ref)." };
  }
  const loc = page.locator(sel(ref));
  if ((await loc.count()) === 0) return { error: `No element ref ${ref} — call browser_read again (the page changed).` };
  const beforeSeq = lastDownload.get(chatId)?.seq ?? 0;
  try {
    await loc.click({ timeout: 8000 });
  } catch {
    await loc.click({ force: true, timeout: 4000 }).catch(() => {});
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = lastDownload.get(chatId);
    if (d && d.seq > beforeSeq) return { path: d.path, filename: d.filename };
    await page.waitForTimeout(400);
  }
  return { error: "Clicked, but nothing downloaded — the button may open the PDF inline, or need an earlier step (OTP/submit) first." };
}

/**
 * Fetch a file at a URL using the session's cookies (e.g. a PDF that opened
 * inline in the portal rather than triggering a download). Saves and returns it.
 */
export async function fetchFile(chatId: number, url: string): Promise<DownloadResult> {
  const { context } = await getSession(chatId);
  try {
    const resp = await context.request.get(url, { timeout: 30_000 });
    if (!resp.ok()) return { error: `Could not fetch ${url} — HTTP ${resp.status()}` };
    const buf = Buffer.from(await resp.body());
    const cd = resp.headers()["content-disposition"] || "";
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    let name = m ? decodeURIComponent(m[1]!) : path.basename(new URL(url).pathname) || "file";
    name = path.basename(name) || "file";
    const dest = path.join(filesDir(chatId), name);
    await Bun.write(dest, buf);
    return { path: dest, filename: name };
  } catch (e) {
    return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function upload(chatId: number, ref: number, filePath: string): Promise<string> {
  const { page } = await getSession(chatId);
  const loc = page.locator(sel(ref));
  if ((await loc.count()) === 0) return `No element ref ${ref} — call browser_read again (the page changed).`;
  await loc.setInputFiles(filePath);
  return `Uploaded the file to ref ${ref}.`;
}

export async function screenshot(chatId: number, ref?: number): Promise<Buffer> {
  const { page } = await getSession(chatId);
  if (ref !== undefined) {
    const loc = page.locator(sel(ref));
    if ((await loc.count()) > 0) return (await loc.screenshot()) as Buffer;
  }
  return (await page.screenshot({ fullPage: false })) as Buffer;
}
