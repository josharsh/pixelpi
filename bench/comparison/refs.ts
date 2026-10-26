export function findRef(text: string, system: "pixelpi" | "playwright-mcp", role: string, name: string): string | undefined {
  for (const line of text.split("\n")) {
    if (system === "pixelpi") {
      const m = line.match(/^\[(\d+)\] (\S+) "(.*?)"(?: \(.*\))?$/);
      if (m && m[2] === role && m[3] === name) return m[1];
    } else {
      const m = line.match(/^\s*- (\S+) "(.*?)".*?\[ref=([^\]]+)\]/);
      if (m && m[1] === role && m[2] === name) return m[3];
    }
  }
}

export function parseEvaluation(text: string, system: "pixelpi" | "playwright-mcp"): unknown {
  if (system === "pixelpi") return JSON.parse(text);
  const result = text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim();
  if (!result) throw new Error("No evaluation result in MCP response");
  return JSON.parse(result);
}
