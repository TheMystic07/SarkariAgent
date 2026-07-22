import path from "node:path";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import { SERVICES, getService, listServices } from "./services/registry";
import { compressToTarget } from "./compress";
import { searchWeb, fetchPageText, type SearchResult } from "./web";
import { validateField } from "./validate";
import { recallPlaybook, savePlaybook } from "./playbook";
import * as browser from "./browser";
import { filesDir, type Session } from "./store";

export interface ToolCtx {
  chatId: number;
  api: Api;
  session: Session;
  save: () => Promise<void>;
  /** Called with a short human-readable line when the agent starts a tool action (drives Telegram thinking drafts). */
  onStatus?: (line: string) => void;
  /** Called with the growing partial text of the model's final answer while it streams. */
  onDelta?: (partial: string) => void;
  /** Send an out-of-band text message to the user mid-turn (for browser prompts). */
  sendText?: (text: string) => Promise<void>;
  /** Send an out-of-band photo to the user mid-turn (CAPTCHA / progress screenshots). */
  sendPhoto?: (buffer: Buffer, caption?: string) => Promise<void>;
  /** Block until the user replies, or the timeout elapses. Enables CAPTCHA/OTP relay. */
  waitForReply?: (timeoutMs: number) => Promise<string>;
}

const browserEnabled = () => process.env.ENABLE_BROWSER !== "off";

/** Provider-neutral tool definition — adapted to Anthropic or OpenAI-compatible format by the llm/ layer. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: any) => Promise<string>;
}

export function makeTools(ctx: ToolCtx): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "list_services",
      description:
        "List the government services this bot can help prepare applications for. Returns service ids, names and fees.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => JSON.stringify(listServices()),
    },
    {
      name: "get_service_details",
      description:
        "Get the full requirements for one service: fields to collect, documents needed, upload size limits, fee, and step-by-step submission instructions. Call this before collecting details for a service.",
      inputSchema: {
        type: "object",
        properties: {
          service_id: {
            type: "string",
            description: "One of the ids returned by list_services, e.g. 'pan-new'",
          },
        },
        required: ["service_id"],
        additionalProperties: false,
      },
      run: async ({ service_id }: { service_id: string }) => {
        ctx.onStatus?.(`📋 Checking requirements: ${service_id}`);
        const svc = getService(service_id);
        if (!svc) {
          return `Unknown service_id '${service_id}'. Valid ids: ${SERVICES.map((s) => s.id).join(", ")}`;
        }
        return JSON.stringify(svc);
      },
    },
    {
      name: "save_profile_fields",
      description:
        "Save or update the user's profile details (name, dob, address, etc.) so they persist across the conversation and can be reused for multiple applications. Use the field keys from get_service_details where possible. Confirm extracted document data with the user BEFORE saving it.",
      inputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Field key, e.g. 'full_name', 'dob', 'aadhaar_number'" },
                value: { type: "string" },
              },
              required: ["key", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["entries"],
        additionalProperties: false,
      },
      run: async ({ entries }: { entries: { key: string; value: string }[] }) => {
        ctx.onStatus?.("💾 Saving your details");
        const saved: string[] = [];
        const rejected: string[] = [];
        for (const { key, value } of entries) {
          const check = validateField(key, value);
          if (check.ok) {
            ctx.session.profile[key] = check.value;
            saved.push(key);
          } else {
            rejected.push(`${key} ("${value}"): ${check.reason}`);
          }
        }
        if (saved.length) await ctx.save();
        let result = saved.length
          ? `Saved: ${saved.join(", ")}. Profile now has: ${Object.keys(ctx.session.profile).join(", ")}`
          : "Nothing saved.";
        if (rejected.length) {
          result += `\nREJECTED (tell the user and ask them to re-check): ${rejected.join("; ")}`;
        }
        return result;
      },
    },
    {
      name: "get_profile",
      description: "Read everything saved in the user's profile so far.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => JSON.stringify(ctx.session.profile),
    },
    {
      name: "web_search",
      description:
        "Search the web for current information about Indian government schemes, portal rules, fees, deadlines and eligibility. Prefer official sources: add 'site:gov.in' or name the scheme + ministry in the query. Use this whenever the user asks about a scheme/rule not in the registry, or to verify fees/limits that may have changed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, e.g. 'PM Kisan eligibility site:gov.in'" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: async ({ query }: { query: string }) => {
        ctx.onStatus?.(`🔎 Searching: ${query}`);
        try {
          const results = await searchWeb(query);
          if (!results.length) return "No results found. Try different keywords.";
          return JSON.stringify(results);
        } catch (e) {
          return `Search error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "recall_playbook",
      description:
        "Load your saved step-by-step notes for a task (how a portal's form was successfully filled last time: the URL, navigation path, field quirks, CAPTCHA/OTP behaviour). ALWAYS call this at the start of a form-filling task so you can follow the known-good procedure instead of figuring it out from scratch. Use the service id as the task key (e.g. 'voter-new', 'aadhaar-download') or a short descriptive key.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "Task key, e.g. 'voter-new'" } },
        required: ["task"],
        additionalProperties: false,
      },
      run: async ({ task }: { task: string }) => {
        const pb = await recallPlaybook(task);
        return pb ? `Playbook for '${task}':\n${pb}` : `No playbook yet for '${task}'. You'll figure it out and save one at the end.`;
      },
    },
    {
      name: "save_playbook",
      description:
        "Save or update your notes for a task after you finish (or when you learn something useful): the portal URL, the exact steps/navigation that worked, field labels and quirks, and pitfalls (e.g. 'CAPTCHA is case-sensitive', 'must click Fill Form 6 first', 'OTP appears in-place after Send OTP'). Write the PROCEDURE only — NEVER include the user's personal data (name, Aadhaar, mobile, OTP, address); those are auto-stripped but don't put them in. Read the existing playbook first (recall_playbook) and pass the full merged notes.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task key, same as recall_playbook" },
          notes: { type: "string", description: "The full merged procedure notes (markdown ok)" },
        },
        required: ["task", "notes"],
        additionalProperties: false,
      },
      run: async ({ task, notes }: { task: string; notes: string }) => {
        ctx.onStatus?.(`🧠 Saving what I learned about ${task}`);
        await savePlaybook(task, notes);
        return `Saved playbook for '${task}'. Next time I'll follow it.`;
      },
    },
    {
      name: "lookup_pincode",
      description:
        "Given a 6-digit PIN code, return the district, state and localities (post office names). Use this to AUTO-FILL city/district/state instead of asking the user — a PIN code fully determines them. Also useful to offer the user their locality/area options.",
      inputSchema: {
        type: "object",
        properties: { pincode: { type: "string", description: "6-digit Indian PIN code" } },
        required: ["pincode"],
        additionalProperties: false,
      },
      run: async ({ pincode }: { pincode: string }) => {
        const pin = pincode.replace(/\D/g, "");
        if (!/^[1-9]\d{5}$/.test(pin)) return "Invalid PIN code — must be 6 digits.";
        ctx.onStatus?.(`📍 Looking up PIN ${pin}`);
        try {
          const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
            signal: AbortSignal.timeout(12000),
          });
          const data = (await res.json()) as {
            Status: string;
            PostOffice?: { Name: string; District: string; State: string; Block?: string }[];
          }[];
          const rec = data[0];
          if (rec?.Status !== "Success" || !rec.PostOffice?.length) {
            return `No records for PIN ${pin} — ask the user to confirm it.`;
          }
          const po = rec.PostOffice;
          return JSON.stringify({
            pincode: pin,
            district: po[0]!.District,
            state: po[0]!.State,
            localities: [...new Set(po.map((p) => p.Name))].slice(0, 15),
          });
        } catch (e) {
          return `PIN lookup failed: ${e instanceof Error ? e.message : String(e)} — ask the user for district/state.`;
        }
      },
    },
    {
      name: "discover_schemes",
      description:
        "Find government schemes the user may be eligible for, based on their profile. Pass keywords describing them: state, occupation (farmer/student/worker...), gender, category (SC/ST/OBC/EWS), age group, income level, special situations (widow, disability, unemployed). Fans out searches over myscheme.gov.in and other official sources and returns deduplicated candidates. Follow up with read_webpage on the 2-3 most promising links to verify eligibility before presenting them.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Profile facts as search keywords, e.g. ['Bihar', 'farmer', 'small landholding', 'OBC']",
          },
        },
        required: ["keywords"],
        additionalProperties: false,
      },
      run: async ({ keywords }: { keywords: string[] }) => {
        const kw = keywords.join(" ");
        ctx.onStatus?.(`🎯 Finding schemes for: ${kw}`);
        const queries = [
          `site:myscheme.gov.in/schemes ${kw}`,
          `${kw} government scheme eligibility site:gov.in`,
          `${kw} sarkari yojana benefits official`,
        ];
        const settled = await Promise.allSettled(queries.map((q) => searchWeb(q, 6)));
        const seen = new Set<string>();
        const merged: SearchResult[] = [];
        for (const outcome of settled) {
          if (outcome.status !== "fulfilled") continue;
          for (const r of outcome.value) {
            const urlKey = r.url.replace(/[?#].*$/, "");
            if (seen.has(urlKey)) continue;
            seen.add(urlKey);
            merged.push(r);
          }
        }
        if (!merged.length) return "No schemes found — try different keywords.";
        return JSON.stringify(merged.slice(0, 12));
      },
    },
    {
      name: "read_webpage",
      description:
        "Fetch a web page and return its readable text. Use after web_search to read the actual details from an official page (myscheme.gov.in, uidai.gov.in, ministry sites) before telling the user facts like fees, eligibility or deadlines.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      run: async ({ url }: { url: string }) => {
        ctx.onStatus?.(`📄 Reading ${new URL(url).hostname}`);
        try {
          return await fetchPageText(url);
        } catch (e) {
          return `Could not read page: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "compress_image",
      description:
        "Compress a photo the user previously sent (referenced by its saved file_name) to fit a government portal's KB limit, then send the compressed file back to the user in the chat. Use the maxKb from the service's upload spec as target_kb.",
      inputSchema: {
        type: "object",
        properties: {
          file_name: {
            type: "string",
            description: "The saved file name mentioned when the user sent the photo",
          },
          target_kb: { type: "number", description: "Target maximum size in KB, e.g. 50 for PAN photo" },
          label: {
            type: "string",
            description: "What this image is, e.g. 'PAN photograph' — used in the output file name",
          },
        },
        required: ["file_name", "target_kb", "label"],
        additionalProperties: false,
      },
      run: async ({ file_name, target_kb, label }: { file_name: string; target_kb: number; label: string }) => {
        ctx.onStatus?.(`🗜️ Compressing ${label} to ${target_kb}KB`);
        const filePath = path.join(filesDir(ctx.chatId), path.basename(file_name));
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return `File '${file_name}' not found. Ask the user to re-send the photo.`;
        }
        const input = Buffer.from(await file.arrayBuffer());
        const result = await compressToTarget(input, target_kb);
        if (result.finalKb > target_kb) {
          return `Could not get under ${target_kb}KB (best: ${result.finalKb}KB). The image may be unsuitable — ask the user for a simpler/closer-cropped photo.`;
        }
        const outName = `${label.replace(/\s+/g, "_").toLowerCase()}_${result.finalKb}kb.jpg`;
        await Bun.write(path.join(filesDir(ctx.chatId), outName), result.buffer);
        await ctx.api.sendDocument(ctx.chatId, new InputFile(result.buffer, outName), {
          caption: `${label}: ${result.originalKb}KB → ${result.finalKb}KB (${result.width}x${result.height})`,
        });
        return `Compressed ${result.originalKb}KB → ${result.finalKb}KB (${result.width}x${result.height}), sent to the user, and saved as file_name '${outName}'. Use this file_name with browser_upload to upload it to the form.`;
      },
    },
  ];

  if (browserEnabled() && ctx.waitForReply) {
    tools.push(...browserTools(ctx));
  }
  return tools;
}

/**
 * Assisted form-filling tools. The agent drives a real browser; the human still
 * solves CAPTCHA and OTP (relayed via screenshot + ask_user) and confirms
 * before final submit. Only registered when the runtime supplies the
 * out-of-band messaging capabilities (i.e. the Telegram bot).
 */
function browserTools(ctx: ToolCtx): AgentTool[] {
  const REPLY_TIMEOUT = 8 * 60 * 1000;
  const waitForReply = ctx.waitForReply!;
  return [
    {
      name: "browser_open",
      description:
        "Open a government portal URL in a real browser to fill a form for the user. Only use after the user has explicitly asked you to fill/submit on their behalf (not for the default cheat-sheet flow).",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Full https URL of the official portal page" } },
        required: ["url"],
        additionalProperties: false,
      },
      run: async ({ url }: { url: string }) => {
        ctx.onStatus?.(`🌐 Opening ${new URL(url).hostname}`);
        try {
          await browser.open(ctx.chatId, url);
          const snap = await browser.snapshot(ctx.chatId);
          return JSON.stringify(snap);
        } catch (e) {
          return `Could not open page: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_read",
      description:
        "Re-read the current page's interactive elements (each with a numeric 'ref'). You usually DON'T need this — browser_open and browser_click already return the fields. Only call it if a page changed dynamically (e.g. a dropdown revealed new fields) and your refs went stale.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        ctx.onStatus?.("👁️ Reading the form");
        try {
          const snap = await browser.snapshot(ctx.chatId);
          return JSON.stringify(snap);
        } catch (e) {
          return `Could not read page: ${e instanceof Error ? e.message : String(e)}. Open a page first.`;
        }
      },
    },
    {
      name: "browser_fill",
      description:
        "Fill MANY fields at once — text boxes and dropdowns together. Pass every field you can fill in a single call (this is far faster than one call per field). For a dropdown set type:'select' with the option's visible text or value; text fields can omit type.",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "number", description: "Element ref from browser_read" },
                value: { type: "string" },
                type: { type: "string", enum: ["text", "select"], description: "'select' for dropdowns; default text" },
              },
              required: ["ref", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["fields"],
        additionalProperties: false,
      },
      run: async ({ fields }: { fields: { ref: number; value: string; type?: "text" | "select" }[] }) => {
        ctx.onStatus?.(`✍️ Filling ${fields.length} field(s)`);
        try {
          return await browser.fillFields(ctx.chatId, fields);
        } catch (e) {
          return `Fill failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_click",
      description:
        "Click a button, link, checkbox or radio by its ref (Next/Continue, radio choices, final Submit after confirmation). Returns the resulting page's fields automatically — no need to call browser_read after.",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "number" } },
        required: ["ref"],
        additionalProperties: false,
      },
      run: async ({ ref }: { ref: number }) => {
        ctx.onStatus?.("🖱️ Clicking");
        try {
          const clicked = await browser.click(ctx.chatId, ref);
          if (clicked.startsWith("No element")) return clicked;
          const snap = await browser.snapshot(ctx.chatId);
          return JSON.stringify({ clicked, ...snap });
        } catch (e) {
          return `Click failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_wait",
      description:
        "Wait a few seconds for a slow portal to finish loading, then return the page's fields. Use when browser_open reported nothing rendered, or a page is still loading.",
      inputSchema: {
        type: "object",
        properties: { seconds: { type: "number", description: "Seconds to wait (max 15, default 6)" } },
        additionalProperties: false,
      },
      run: async ({ seconds }: { seconds?: number }) => {
        ctx.onStatus?.("⏳ Waiting for the page to load");
        try {
          return JSON.stringify(await browser.waitAndSnapshot(ctx.chatId, seconds ?? 6));
        } catch (e) {
          return `Wait failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_upload",
      description:
        "Upload a saved photo/document into a file-upload field (input type=file) on the form. First compress_image the photo to the portal's size limit to get a file_name, then pass that file_name and the ref of the file input from browser_read.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "Ref of the file input from browser_read" },
          file_name: { type: "string", description: "Saved file name (from compress_image or the original upload)" },
        },
        required: ["ref", "file_name"],
        additionalProperties: false,
      },
      run: async ({ ref, file_name }: { ref: number; file_name: string }) => {
        ctx.onStatus?.("📤 Uploading file to the form");
        const filePath = path.join(filesDir(ctx.chatId), path.basename(file_name));
        if (!(await Bun.file(filePath).exists())) {
          return `File '${file_name}' not found. Compress or re-send the photo first.`;
        }
        try {
          return await browser.upload(ctx.chatId, ref, filePath);
        } catch (e) {
          return `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_download",
      description:
        "Send a downloaded file (e.g. the e-Aadhaar PDF) to the user in the chat. If a Download button is on the page, pass its ref to click it and capture the PDF. If the file was already downloaded by an earlier click, call with no ref to send the most recent download. For e-Aadhaar, also tell the user the PDF password (first 4 letters of their name in CAPITALS + birth year).",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "Ref of the Download button to click; omit to send the last download" },
          caption: { type: "string", description: "Caption for the file, e.g. 'Aapka e-Aadhaar'" },
        },
        additionalProperties: false,
      },
      run: async ({ ref, caption }: { ref?: number; caption?: string }) => {
        ctx.onStatus?.("📥 Fetching the downloaded file");
        const r = await browser.captureDownload(ctx.chatId, ref);
        if ("error" in r) return r.error;
        try {
          const buf = Buffer.from(await Bun.file(r.path).arrayBuffer());
          await ctx.api.sendDocument(ctx.chatId, new InputFile(buf, r.filename), { caption: caption ?? r.filename });
          return `Sent the file '${r.filename}' to the user.`;
        } catch (e) {
          return `Downloaded '${r.filename}' but sending failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "send_file",
      description:
        "Send ANY file to the user in the chat — a saved file by its file_name (a download, an uploaded doc, a compressed photo), or a file at a URL (fetched using the portal login session, e.g. a PDF that opened inline in the browser instead of downloading). Works for any file type: PDF, images, DOCX, ZIP, etc.",
      inputSchema: {
        type: "object",
        properties: {
          file_name: { type: "string", description: "Name of a saved file to send" },
          url: { type: "string", description: "URL of a file to fetch (via the browser session) and send" },
          caption: { type: "string" },
        },
        additionalProperties: false,
      },
      run: async ({ file_name, url, caption }: { file_name?: string; url?: string; caption?: string }) => {
        ctx.onStatus?.("📎 Sending file");
        let res: browser.DownloadResult;
        if (url) {
          res = await browser.fetchFile(ctx.chatId, url);
        } else if (file_name) {
          const p = path.join(filesDir(ctx.chatId), path.basename(file_name));
          res = (await Bun.file(p).exists())
            ? { path: p, filename: path.basename(file_name) }
            : { error: `File '${file_name}' not found.` };
        } else {
          return "Provide either file_name or url.";
        }
        if ("error" in res) return res.error;
        try {
          const buf = Buffer.from(await Bun.file(res.path).arrayBuffer());
          await ctx.api.sendDocument(ctx.chatId, new InputFile(buf, res.filename), { caption: caption ?? res.filename });
          return `Sent '${res.filename}' to the user.`;
        } catch (e) {
          return `Sending failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "browser_screenshot",
      description:
        "Send the user a screenshot of the current page, or of one element by ref. Use to show the CAPTCHA image (pass its ref) so the user can read it, or to show the filled form for confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "Optional element ref to capture just that element (e.g. the CAPTCHA image)" },
          caption: { type: "string" },
        },
        required: ["caption"],
        additionalProperties: false,
      },
      run: async ({ ref, caption }: { ref?: number; caption: string }) => {
        if (!ctx.sendPhoto) return "Cannot send photos in this interface.";
        try {
          const buf = await browser.screenshot(ctx.chatId, ref);
          await ctx.sendPhoto(buf, caption);
          return "Screenshot sent to the user.";
        } catch (e) {
          return `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their typed reply. Use to relay a CAPTCHA (after sending its screenshot), to get the OTP the user received on their phone, or to get explicit confirmation before the final submit. NEVER guess a CAPTCHA or OTP yourself — always ask. Never store the OTP.",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false,
      },
      run: async ({ question }: { question: string }) => {
        if (!ctx.sendText) return "Cannot ask the user in this interface.";
        await ctx.sendText(question);
        try {
          const answer = await waitForReply(REPLY_TIMEOUT);
          return `User replied: ${answer}`;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return reason === "timeout"
            ? "User did not reply in time. Stop and tell them you'll wait for their next message, then end your turn."
            : `Wait cancelled: ${reason}`;
        }
      },
    },
    {
      name: "browser_close",
      description: "Close the browser session when the form is submitted or the user wants to stop.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        await browser.closeSession(ctx.chatId);
        return "Browser closed.";
      },
    },
  ];
}
