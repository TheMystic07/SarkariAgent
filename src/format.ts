function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BLOCK = "\u0000";
const INLINE = "\u0001";

/**
 * Convert the LLM's Markdown to Telegram-flavoured HTML (parse_mode: "HTML").
 * Telegram supports only inline tags — headers become bold, bullets become •.
 * Code spans are pulled out first (sentinel placeholders) so their contents
 * are never touched by the other rules.
 */
export function mdToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  let s = md.replace(/```\w*\n?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `${BLOCK}${codeBlocks.length - 1}${BLOCK}`;
  });

  const inlineCode: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `${INLINE}${inlineCode.length - 1}${INLINE}`;
  });

  s = escapeHtml(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^[ \t]*[-*]\s+/gm, "• ");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n][^_]*?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  s = s.replace(new RegExp(`${INLINE}(\\d+)${INLINE}`, "g"), (_, i: string) => inlineCode[Number(i)]!);
  s = s.replace(new RegExp(`${BLOCK}(\\d+)${BLOCK}`, "g"), (_, i: string) => codeBlocks[Number(i)]!);
  return s;
}

/** Strip Markdown markers for surfaces that render plain text (streaming drafts). */
export function mdToPlain(md: string): string {
  return md
    .replace(/```\w*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*[-*]\s+/gm, "• ");
}
