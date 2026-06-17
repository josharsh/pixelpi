// A small, dependency-free markdown → terminal renderer. Agent answers come back as
// markdown; printing it raw shows literal ###, **bold**, and - bullets. This turns the
// common constructs into clean ANSI (or plain text when color is off). It deliberately
// covers the 95% an agent emits — headings, bold/italic, inline + fenced code, lists,
// blockquotes, links, rules — and skips tables/syntax-highlighting.

const E = {
  bold: ["\x1b[1m", "\x1b[22m"],
  italic: ["\x1b[3m", "\x1b[23m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  underline: ["\x1b[4m", "\x1b[24m"],
  code: ["\x1b[36m", "\x1b[39m"], // cyan
} as const;

const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}```/;
const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

export function renderMarkdown(md: string, opts: { color: boolean }): string {
  const { color } = opts;
  const wrap = (pair: readonly [string, string], s: string) => (color ? pair[0] + s + pair[1] : s);

  const inline = (text: string): string =>
    text.replace(INLINE, (_m, code, linkText, linkUrl, b1, b2, i1, i2) => {
      if (code !== undefined) return wrap(E.code, code);
      if (linkText !== undefined) return wrap(E.underline, linkText) + wrap(E.dim, ` (${linkUrl})`);
      if (b1 !== undefined || b2 !== undefined) return wrap(E.bold, b1 ?? b2);
      return wrap(E.italic, i1 ?? i2);
    });

  const out: string[] = [];
  let inFence = false;

  for (const raw of md.split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue; // drop the ``` fence lines themselves
    }
    if (inFence) {
      out.push(wrap(E.dim, "  " + raw));
      continue;
    }
    let m: RegExpMatchArray | null;
    if (RULE.test(raw)) {
      out.push(wrap(E.dim, "─".repeat(48)));
    } else if ((m = raw.match(HEADING))) {
      out.push(wrap(E.bold, inline(m[2]!.trim())));
    } else if ((m = raw.match(BLOCKQUOTE))) {
      out.push(wrap(E.dim, "│ ") + inline(m[1]!));
    } else if ((m = raw.match(BULLET))) {
      out.push(`${m[1]}${wrap(E.dim, "•")} ${inline(m[2]!)}`);
    } else if ((m = raw.match(ORDERED))) {
      out.push(`${m[1]}${wrap(E.dim, m[2] + ".")} ${inline(m[3]!)}`);
    } else {
      out.push(inline(raw));
    }
  }

  // collapse 3+ blank lines to one, trim edges
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
}
