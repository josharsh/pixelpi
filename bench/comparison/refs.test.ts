import { test } from "node:test";
import assert from "node:assert/strict";
import { findRef, parseEvaluation } from "./refs";

test("refs require an exact role/name match and support frame refs", () => {
  assert.equal(findRef('[3] button "Save contact"\n[4] button "Save contact copy"', "pixelpi", "button", "Save contact"), "3");
  assert.equal(findRef('  - button "Frame action" [ref=f1e2]', "playwright-mcp", "button", "Frame action"), "f1e2");
  assert.equal(findRef('- textbox "Save contact" [ref=e3]', "playwright-mcp", "button", "Save contact"), undefined);
});
test("extracts the actual value, not incidental text in generated code", () => {
  assert.equal(parseEvaluation('### Result\n"INV-2048"\n### Ran Playwright code\n```js\n// other\n```', "playwright-mcp"), "INV-2048");
  assert.equal(parseEvaluation('"INV-2048"', "pixelpi"), "INV-2048");
  assert.throws(() => parseEvaluation('### Error\nFailed: INV-2048', "playwright-mcp"));
});
