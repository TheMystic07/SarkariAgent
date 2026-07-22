import { afterAll, beforeAll, expect, test } from "bun:test";
import * as browser from "../src/browser";
import { tmpdir } from "node:os";
import path from "node:path";

const FORM = `<!doctype html><html><body>
<form id="f" method="get" action="/submit">
  <label for="name">Full Name</label><input id="name" name="name" type="text">
  <label for="pin">PIN Code</label><input id="pin" name="pin" type="text">
  <label for="state">State</label>
  <select id="state" name="state">
    <option value="">--</option><option value="BR">Bihar</option><option value="DL">Delhi</option>
  </select>
  <img id="cap" alt="captcha" width="120" height="40"
       src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNDAiPjx0ZXh0IHg9IjEwIiB5PSIyNSI+WDdLOTI8L3RleHQ+PC9zdmc+">
  <input id="captcha" name="captcha" type="text">
  <button id="go" type="submit">Submit</button>
</form>
</body></html>`;

const CHAT = 7001;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/submit") {
        const p = url.searchParams;
        return new Response(
          `<h1 id="result">Success: ${p.get("name")} / ${p.get("pin")} / ${p.get("state")} / ${p.get("captcha")}</h1>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response(FORM, { headers: { "content-type": "text/html" } });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await browser.closeSession(CHAT);
  server.stop(true);
});

test("full assisted-fill flow: open, read, fill, select, captcha screenshot, submit", async () => {
  // real Chromium — allow more than the 5s default
  await browser.open(CHAT, base + "/");
  expect(browser.hasSession(CHAT)).toBe(true);

  const snap = await browser.snapshot(CHAT);
  const el = (label: string) => snap.elements.find((e) => e.label === label)!;
  const name = el("Full Name");
  const pin = el("PIN Code");
  const state = snap.elements.find((e) => e.tag === "select")!;
  const captcha = el("captcha");
  const submit = snap.elements.find((e) => e.tag === "button")!;

  // empty <option value=""> falls back to its display text
  expect(state.options).toEqual(["--", "BR", "DL"]);

  const fillResult = await browser.fillFields(CHAT, [
    { ref: name.ref, value: "Ravi Kumar" },
    { ref: pin.ref, value: "110001" },
    { ref: state.ref, value: "BR", type: "select" },
  ]);
  expect(fillResult).toContain("Filled 3");

  // CAPTCHA is human-solved: we screenshot it but never read it in code.
  const shot = await browser.screenshot(CHAT);
  expect(shot.length).toBeGreaterThan(100);

  // simulate the user having typed the captcha answer
  await browser.fill(CHAT, captcha.ref, "X7K92");
  await browser.click(CHAT, submit.ref);

  const after = await browser.snapshot(CHAT);
  expect(after.url).toContain("/submit");
  expect(after.title.length).toBeGreaterThanOrEqual(0);
}, 30000);

test("download capture: clicking a download link saves the file, and no-ref returns the last one", async () => {
  const CHAT3 = 7003;
  const dlServer = Bun.serve({
    port: 0,
    fetch(r) {
      const u = new URL(r.url);
      if (u.pathname === "/file") {
        return new Response("%PDF-1.4 fake", {
          headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="eaadhaar.pdf"' },
        });
      }
      return new Response('<a id="dl" href="/file" download>Download e-Aadhaar</a>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  try {
    await browser.open(CHAT3, `http://localhost:${dlServer.port}/`);
    const snap = await browser.snapshot(CHAT3);
    const dl = snap.elements.find((e) => e.text?.includes("Download"))!;
    const r = await browser.captureDownload(CHAT3, dl.ref);
    expect("path" in r).toBe(true);
    if ("path" in r) {
      expect(r.filename).toBe("eaadhaar.pdf");
      expect((await Bun.file(r.path).text()).startsWith("%PDF")).toBe(true);
    }
    // no-ref returns the same last download
    const again = await browser.captureDownload(CHAT3);
    expect("path" in again && again.filename).toBe("eaadhaar.pdf");
  } finally {
    await browser.closeSession(CHAT3);
    dlServer.stop(true);
  }
}, 30000);

test("file upload: hidden file input is captured and setInputFiles works", async () => {
  const CHAT2 = 7002;
  const tmp = path.join(tmpdir(), `af-upload-${Date.now()}.txt`);
  await Bun.write(tmp, "photo bytes");

  const uploadServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `<form><input type="file" id="doc" name="doc" style="display:none"><button>x</button></form>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  try {
    await browser.open(CHAT2, `http://localhost:${uploadServer.port}/`);
    const snap = await browser.snapshot(CHAT2);
    const fileInput = snap.elements.find((e) => e.type === "file");
    expect(fileInput).toBeDefined(); // captured despite display:none
    const res = await browser.upload(CHAT2, fileInput!.ref, tmp);
    expect(res).toContain("Uploaded");
  } finally {
    await browser.closeSession(CHAT2);
    uploadServer.stop(true);
  }
}, 30000);
