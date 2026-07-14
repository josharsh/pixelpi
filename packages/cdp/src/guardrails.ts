// Deterministic guardrails enforced at the tool layer (not prompt-hopes):
// the navigation allowlist (#23) and the consequential-action detector (#22).

/** Hosts that are always navigable: blank pages and browser-internal URLs. */
const ALWAYS_ALLOWED = /^(about:|chrome:|data:|blob:)/;

/**
 * Is `url` within the allowed domains? A domain entry allows itself and all
 * subdomains ("example.com" allows "www.example.com" but not "notexample.com").
 * An unparseable URL is NOT allowed — fail closed.
 */
export function hostAllowed(url: string, allowDomains: string[]): boolean {
  if (allowDomains.length === 0) return true;
  if (ALWAYS_ALLOWED.test(url)) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowDomains.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith("." + domain);
  });
}

/**
 * Does this act look like an irreversible, outward-facing commit (submit / send /
 * purchase / publish / delete)? Heuristic on the clicked element's role+name — a
 * false positive costs one confirmation pause; a false negative costs a real
 * submission, so the word list leans broad.
 */
const CONSEQUENTIAL =
  /\b(submit|send|pay|purchase|buy|order|checkout|place order|confirm|apply|post|publish|sign.?up|register|subscribe|book|donate|transfer|delete|remove|unsubscribe|cancel (my )?(account|subscription|order))\b/i;

export function isConsequentialClick(op: string, role: string, name: string): boolean {
  if (op !== "click") return false;
  if (!/button|link|menuitem/i.test(role)) return false;
  return CONSEQUENTIAL.test(name);
}

/** What the gate is about to withhold or confirm — enough for a human/agent to judge it. */
export interface PendingAction {
  op: string;
  ref: number;
  role: string;
  name: string;
  value?: string;
  url: string;
  title: string;
}
