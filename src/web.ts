const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Keyless web search via DuckDuckGo's HTML endpoint. */
export async function searchWeb(query: string, maxResults = 6): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, "").trim()));

  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    let url = m[1]!;
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    if (url.startsWith("//")) url = "https:" + url;
    results.push({
      title: decodeEntities(m[2]!.replace(/<[^>]+>/g, "").trim()),
      url,
      snippet: snippets[i] ?? "",
    });
    i++;
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Fetch a page and reduce it to readable plain text (capped for small local-model contexts). */
export async function fetchPageText(url: string, maxChars = 8000): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html") && !type.includes("text") && !type.includes("json")) {
    throw new Error(`Not a readable page (content-type: ${type})`);
  }
  const html = await res.text();
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim(),
  );
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[…truncated]" : text;
}
