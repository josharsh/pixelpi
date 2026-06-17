import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

const hasAnsi = (s: string) => /\x1b\[/.test(s);

describe("renderMarkdown — color", () => {
  it("styles bold, headings, and inline code with ANSI", () => {
    const out = renderMarkdown("## Title\n\na **bold** word and `code`", { color: true });
    expect(out).toContain("\x1b[1m"); // bold (also used by the heading)
    expect(out).toContain("\x1b[36m"); // inline code = cyan
    expect(out).not.toContain("##"); // heading marker stripped
    expect(out).not.toContain("**"); // bold marker stripped
  });

  it("renders bold INSIDE list items (the bug we hit with marked-terminal)", () => {
    const out = renderMarkdown("- **Points:** 1,404", { color: true });
    expect(out).toContain("•");
    expect(out).toContain("\x1b[1mPoints:\x1b[22m");
    expect(out).not.toContain("**");
  });

  it("renders links as underlined text + dim url", () => {
    const out = renderMarkdown("[hn](https://news.ycombinator.com)", { color: true });
    expect(out).toContain("\x1b[4mhn\x1b[24m");
    expect(out).toContain("https://news.ycombinator.com");
    expect(out).not.toContain("](");
  });
});

describe("renderMarkdown — no color", () => {
  const sample =
    "### Heading\n\n- **a** item\n1. first\n\n> quote\n\n---\n\n`code` and [t](u)\n\n```\nblock\n```";
  const out = renderMarkdown(sample, { color: false });

  it("emits zero ANSI escapes", () => {
    expect(hasAnsi(out)).toBe(false);
  });

  it("keeps structure and content, strips markdown markers", () => {
    expect(out).toContain("Heading");
    expect(out).not.toContain("###");
    expect(out).not.toContain("**");
    expect(out).toContain("• a item");
    expect(out).toContain("1. first");
    expect(out).toContain("│ quote");
    expect(out).toContain("─"); // horizontal rule
    expect(out).toContain("code and t (u)"); // inline code + link, markers gone
    expect(out).toContain("block"); // fenced content kept, fences dropped
    expect(out).not.toContain("```");
  });

  it("collapses runaway blank lines", () => {
    expect(renderMarkdown("a\n\n\n\n\nb", { color: false })).toBe("a\n\nb");
  });
});
