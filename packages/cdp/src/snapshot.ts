import type { Ref } from "./types";

// Subset of the Accessibility.getFullAXTree node shape we care about.
export interface AXValue {
  type: string;
  value?: unknown;
}
export interface AXProperty {
  name: string;
  value: AXValue;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  backendDOMNodeId?: number;
}

/** How many refs a single look() renders. Compaction itself is uncapped — see look(). */
export const MAX_REFS = 200;

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "textfield",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "tab",
  "switch",
  "slider",
  "searchbox",
  "listbox",
  "option",
  "spinbutton",
]);

const NAMED_ROLES = new Set([
  "heading",
  "text",
  "StaticText",
  "paragraph",
  "link",
  "image",
  "cell",
  "columnheader",
  "rowheader",
  "listitem",
]);

// Roles whose repeated values are positionally meaningful — a table of "N/A" cells
// still needs every cell. Exempt from de-duplication.
const TABLE_ROLES = new Set(["cell", "columnheader", "rowheader", "gridcell"]);

/** A name carries information only if it has a letter or a digit somewhere. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

const normalizeName = (s: string) =>
  s.trim().replace(/\s+/g, " ").toLowerCase();

// AX property names that map to compact boolean state flags.
const FLAG_PROPS = [
  "checked",
  "disabled",
  "focused",
  "expanded",
  "selected",
] as const;

function strValue(v?: AXValue): string {
  if (!v || v.value == null) return "";
  return String(v.value);
}

/** Build a compact state string from an AX node's properties + value. */
export function compactState(node: AXNode): string | undefined {
  const parts: string[] = [];
  const props = node.properties ?? [];
  for (const flag of FLAG_PROPS) {
    const p = props.find((x) => x.name === flag);
    if (!p) continue;
    const val = p.value.value;
    if (flag === "checked" || flag === "expanded" || flag === "selected") {
      // tristate / boolean-ish: emit when true (or "mixed")
      if (val === true || val === "true") parts.push(flag);
      else if (val === "mixed") parts.push(`${flag}=mixed`);
    } else {
      // disabled / focused
      if (val === true || val === "true") parts.push(flag);
    }
  }
  const value = strValue(node.value);
  if (value) parts.push(`value=${value}`);
  return parts.length ? parts.join(" ") : undefined;
}

export interface CompactionResult {
  refs: Ref[];
  /** ref id -> resolution info needed by act/fill. */
  refMap: Map<number, { backendDOMNodeId: number; role: string; name: string }>;
}

/**
 * PURE: turn an Accessibility.getFullAXTree node array into ref-indexed entries.
 * Drops ignored nodes; keeps interactive roles, and named nodes in NAMED_ROLES.
 *
 * Two passes of noise removal, because the AX tree describes the same content twice —
 * once as an aggregating container (a table cell holding a whole HN row) and again as
 * the decomposed links and text inside it:
 *   - separator-only names (" | ", " (", ")") are dropped; they cost tokens and say nothing
 *   - a non-interactive node repeating a name already emitted is dropped
 * Interactive nodes are never de-duplicated: two buttons both named "Submit" are two
 * different things to click. Table roles are exempt too — repetition is data there.
 *
 * Uncapped by design. look() windows the result so nothing is unreachable.
 */
export function compactAxTree(nodes: AXNode[]): CompactionResult {
  const refs: Ref[] = [];
  const refMap = new Map<
    number,
    { backendDOMNodeId: number; role: string; name: string }
  >();
  const seen = new Set<string>();
  let counter = 0;

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = strValue(node.role);
    if (!role) continue;
    const name = strValue(node.name);

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isNamed = name.length > 0 && NAMED_ROLES.has(role);
    if (!isInteractive && !isNamed) continue;

    if (node.backendDOMNodeId == null) continue;

    if (!isInteractive) {
      if (!HAS_CONTENT.test(name)) continue;
      const key = normalizeName(name);
      if (!TABLE_ROLES.has(role) && seen.has(key)) continue;
    }
    if (name) seen.add(normalizeName(name));

    const ref = ++counter;
    const state = compactState(node);
    refs.push({ ref, role, name, state });
    refMap.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name });
  }

  return { refs, refMap };
}

/** Render refs as compact "[ref] role \"name\" (state)" lines. */
export function renderRefs(refs: Ref[]): string {
  return refs
    .map((r) => {
      const namePart = r.name ? ` "${r.name}"` : "";
      const state = [r.frame ? `frame=${r.frame}` : "", r.state]
        .filter(Boolean)
        .join(" ");
      const statePart = state ? ` (${state})` : "";
      return `[${r.ref}] ${r.role}${namePart}${statePart}`;
    })
    .join("\n");
}
