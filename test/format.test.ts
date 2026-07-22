import { describe, expect, test } from "bun:test";
import { mdToTelegramHtml, mdToPlain } from "../src/format";

describe("mdToTelegramHtml", () => {
  test("bold, italic, bullets, headers", () => {
    const html = mdToTelegramHtml("## Fees\n**₹50** hai aur *zaroori* hai\n- Aadhaar\n* Photo");
    expect(html).toBe("<b>Fees</b>\n<b>₹50</b> hai aur <i>zaroori</i> hai\n• Aadhaar\n• Photo");
  });

  test("escapes HTML and keeps numbers intact", () => {
    const html = mdToTelegramHtml("fee < 50 & pin 110001");
    expect(html).toBe("fee &lt; 50 &amp; pin 110001");
  });

  test("code spans are protected from other rules", () => {
    const html = mdToTelegramHtml("run `bun **start**` now");
    expect(html).toBe("run <code>bun **start**</code> now");
  });

  test("links", () => {
    const html = mdToTelegramHtml("[myScheme](https://www.myscheme.gov.in)");
    expect(html).toBe('<a href="https://www.myscheme.gov.in">myScheme</a>');
  });
});

describe("mdToPlain", () => {
  test("strips markers", () => {
    expect(mdToPlain("**bold** and `code`\n- item")).toBe("bold and code\n• item");
  });
});
