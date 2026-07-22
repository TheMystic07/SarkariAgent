# Sarkari Agent — a Telegram agent for Indian government forms

Sarkari Agent is an AI agent living inside Telegram that **bypasses the front-end** of India's government portals. Instead of fighting a clunky web form in a language you may not read well, you chat with the bot in any Indian language — it collects your details conversationally, reads your documents straight from photos, and auto-compresses images to each portal's fussy KB limits (the 20/50/200KB rules that reject half of all uploads). At the end it hands you a filled **cheat sheet**: every portal field with the exact value to type, the pre-sized files to upload, the fee, and the click-by-click submission steps — so the actual portal submission takes minutes. It is **human-in-the-loop by design**: the bot never submits anything. You always do the final submit, OTP, and CAPTCHA yourself on the official site.

---

## Supported services

Pulled from [`src/services/registry.ts`](src/services/registry.ts). Fees and upload limits drift — treat these as best-effort and confirm on the portal.

| Service | Authority | Portal | Fee | Uploads (auto-compressed) |
| --- | --- | --- | --- | --- |
| New PAN Card (Form 49A) | Income Tax Dept (Protean / UTIITSL) | onlineservices.nsdl.com | ~₹107 physical / ~₹72 e-PAN; free instant e-PAN via Aadhaar | Photo 50KB, Signature 50KB (scan mode only) |
| New Voter ID (Form 6) | Election Commission of India | voters.eci.gov.in | Free | Photo ~200KB, address & age proof scans |
| Learner's Licence (LL) | MoRTH — Sarathi Parivahan | sarathi.parivahan.gov.in | ~₹150 + ~₹50 test (state-varying) | Photo 200KB, Signature 50KB, doc scans 500KB |
| Aadhaar Address Update | UIDAI | myaadhaar.uidai.gov.in | ₹50 | Address proof scan (~2MB) |
| Download e-Aadhaar (PDF) | UIDAI | myaadhaar.uidai.gov.in | Free | — |
| SSC One-Time Registration | Staff Selection Commission | ssc.gov.in | Free (exam fees vary) | Photo 20–50KB, Signature 10–20KB |
| NCS Jobseeker Registration | Ministry of Labour & Employment | ncs.gov.in | Free | — |

---

## Quick start

Requires [Bun](https://bun.sh).

```bash
# 1. install deps
bun install

# 2. create a Telegram bot: message @BotFather → /newbot → copy the token

# 3. configure
cp .env.example .env
# edit .env and paste TELEGRAM_BOT_TOKEN=...

# 4. run
bun run dev      # watch mode (auto-reload)
bun start        # plain run
```

The bot uses long polling — no public URL or webhook needed. On start you'll see the chosen LLM provider and `@<yourbot> is running`.

In Telegram: send `/start` for the welcome message, then just say what you need — *"PAN card banwana hai"*, *"वाक्काळर अडैयाळ अट्टै वेणुम"*, or send a photo of your Aadhaar. `/reset` wipes everything the bot knows about you.

---

## LLM providers

Set `LLM_PROVIDER` in `.env`. Both providers share the same provider-neutral tool layer and agent loop; only the transport differs.

### `local` (default) — any OpenAI-compatible endpoint

Point the bot at your own served model (e.g. an [unsloth](https://github.com/unslothai/unsloth)-finetuned model). Configure:

```bash
LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://localhost:8000/v1
LOCAL_LLM_MODEL=your-model-name
# LOCAL_LLM_API_KEY=      # only if your server requires a bearer token
```

Serve the model with one of:

```bash
# vLLM — enable tool calling with the hermes parser
vllm serve <your-unsloth-model> \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

```bash
# llama.cpp — --jinja enables the chat template's tool-call formatting
llama-server -m your-model.gguf --jinja
```

**Honest requirements:**

- **Function calling is mandatory.** The agent works entirely through tools (`get_service_details`, `save_profile_fields`, `compress_image`, …). A model that can't emit reliable tool calls won't work — pick a model with solid tool/function-calling support and serve it with the right parser (`--tool-call-parser hermes` on vLLM, `--jinja` on llama-server).
- **Vision needs a VLM.** Reading details from a document photo only works if the served model is a vision-language model (e.g. a Qwen2.5-VL-class model). With a **text-only** model, the bot can't extract from images — users must type their details in instead. Everything else (collecting fields, cheat sheet, image compression) still works, since compression is done locally with `sharp`, not by the model.

### `anthropic` — Claude API (recommended)

Best extraction and multilingual quality. Uses `claude-opus-4-8` with adaptive thinking and prompt caching.

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Architecture

```
src/
├── index.ts              # entrypoint: reads TELEGRAM_BOT_TOKEN, starts long polling
├── bot.ts                # grammy handlers: text & photo messages, /start, /reset, per-chat lock
├── agent.ts              # runTurn(): dispatch to provider, persist sanitized history
├── prompt.ts             # SYSTEM_PROMPT + UserBlock content type (text | image)
├── tools.ts              # provider-neutral AgentTool definitions (the tool layer)
├── compress.ts           # sharp-based image compression to a target KB
├── store.ts              # session load/save/reset under data/<chatId>/
├── llm/
│   ├── local.ts          # agent loop over an OpenAI-compatible endpoint
│   └── anthropic.ts      # agent loop over the Claude API (toolRunner)
└── services/
    └── registry.ts       # the service catalogue: fields, uploads, fees, steps
```

**Provider-neutral tool layer.** `makeTools()` in `tools.ts` defines tools once as plain `{name, description, inputSchema, run}` objects. Each `llm/` adapter reshapes them into its own wire format — OpenAI `function` specs in `local.ts`, Anthropic `betaTool`s in `anthropic.ts` — so adding a provider means writing one loop, not re-defining tools. The five tools: `list_services`, `get_service_details`, `save_profile_fields`, `get_profile`, `compress_image`.

**Agent loop.** Each turn feeds the system prompt + prior history + the new user blocks to the model, then lets it call tools repeatedly (capped at 12 iterations) until it produces a final text reply. `agent.ts` then appends the turn to history — images are replaced with placeholders so session files stay small and photos aren't re-sent every turn.

**Storage.** Everything lives on the operator's disk under `data/<chatId>/` (override with `DATA_DIR`): `session.json` holds the profile and last ~60 turns of chat; `files/` holds uploaded photos. `/reset` deletes the whole `data/<chatId>/` directory.

---

## Adding a new service

A service is just one entry in the `SERVICES` array in [`src/services/registry.ts`](src/services/registry.ts) — no other code changes. The agent discovers it automatically via `list_services` / `get_service_details`.

```ts
{
  id: "passport-fresh",
  name: "Fresh Passport (normal)",
  authority: "Ministry of External Affairs",
  portal: "https://portal2.passportindia.gov.in",
  fee: "₹1500 (36 pages) / ₹2000 (60 pages)",
  fields: [
    { key: "full_name", label: "Full name (as on documents)", required: true },
    { key: "dob", label: "Date of birth (DD/MM/YYYY)", required: true },
    { key: "mobile", label: "Mobile number", required: true },
    // …add the rest
  ],
  documents: ["Aadhaar (proof of address)", "Birth certificate / 10th marksheet (DOB)"],
  uploads: [
    // { label: "Photograph", format: "JPEG", maxKb: 200 },
  ],
  submissionSteps: [
    "Register/log in at the Passport Seva portal.",
    "Fill the form using the cheat sheet I prepare.",
    "Book an appointment slot at your PSK/POPSK (you do this).",
  ],
  notes: "Optional caveats — appointment required, police verification, etc.",
}
```

Reuse existing field `key`s (`full_name`, `dob`, `mobile`, `aadhaar_number`, …) so a detail the user gave for one service carries over to the next.

---

## Privacy & legal

- **PII stays local.** Names, addresses, Aadhaar/PAN numbers and uploaded document photos are stored on the **operator's machine** under `data/<chatId>/`, never sent anywhere except your chosen LLM provider for the current turn. Aadhaar/PAN are masked in chat (last 4 digits only). `/reset` deletes a user's data entirely.
- **The bot never submits.** It prepares — it does not, and will not, complete applications, enter OTPs, or solve CAPTCHAs. The final submission is always the user's own action on the official portal. This is a design rule enforced in the system prompt, not just a convention.
- **Portal rules drift.** Fees and KB/pixel upload limits in the registry are **best-effort** and change without notice. The bot is instructed to say "verify on the portal" when unsure — treat every number here the same way.
- **Terms of service.** Sarkari Agent assists a human filling a form; it does not scrape or automate the portals. Before building any future automation on top of this, check each portal's terms of use.

---

## Roadmap

- **WhatsApp adapter** — same agent behind Baileys or the WhatsApp Cloud API, to reach users who don't use Telegram.
- **Browser-automation-assisted filling** — optional computer-use / Playwright layer that types the cheat sheet into the portal **with the human watching**, still stopping at every OTP/CAPTCHA/submit.
- **More services** — passport annexures, scholarship forms (NSP), state e-District services (income/caste/domicile certificates).
- **Voice messages** — speak your details in your language; transcribe and extract.
