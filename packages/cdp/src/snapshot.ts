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

// AX property names that map to compact boolean state flags.
const FLAG_PROPS = ["checked", "disabled", "focused", "expanded", "selected"] as const;

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
  truncated: boolean;
}

/**
 * PURE: turn an Accessibility.getFullAXTree node array into ref-indexed entries.
 * Drops ignored nodes; keeps interactive roles, and named nodes in NAMED_ROLES.
 * Assigns sequential ref ids starting at 1. Caps at MAX_REFS.
 */
export function compactAxTree(nodes: AXNode[]): CompactionResult {
  const refs: Ref[] = [];
  const refMap = new Map<number, { backendDOMNodeId: number; role: string; name: string }>();
  let counter = 0;
  let truncated = false;

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = strValue(node.role);
    if (!role) continue;
    const name = strValue(node.name);

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isNamed = name.length > 0 && NAMED_ROLES.has(role);
    if (!isInteractive && !isNamed) continue;

    if (node.backendDOMNodeId == null) continue;

    if (refs.length >= MAX_REFS) {
      truncated = true;
      break;
    }

    const ref = ++counter;
    const state = compactState(node);
    refs.push({ ref, role, name, state });
    refMap.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name });
  }

  return { refs, refMap, truncated };
}

/** Render refs as compact "[ref] role \"name\" (state)" lines. */
export function renderRefs(refs: Ref[]): string {
  return refs
    .map((r) => {
      const namePart = r.name ? ` "${r.name}"` : "";
      const statePart = r.state ? ` (${r.state})` : "";
      return `[${r.ref}] ${r.role}${namePart}${statePart}`;
    })
    .join("\n");
}
