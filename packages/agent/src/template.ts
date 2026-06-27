// Parametrization: turn captured literals into {{var}} templates and bind them per row.
//
// Templatizable fields (the ONLY places {{var}} may appear):
//   act.value, fill.fields[].value, nav.input.arg, store.input.key, store.input.value,
//   and STRING entries of eval.input.args. NEVER eval.input.fn, and never a Target.
//
// Replacement rules at record time (templatizeFromExamples):
//   nav.arg: substring replace (a URL contains the value), everything else: exact-equality replace.

import type { Trace, TraceParam, TraceStep } from "./trace";

/** A single templatizable literal in a trace, located for the vars command. */
export interface Literal {
  stepIndex: number;
  tool: TraceStep["tool"];
  field: string;
  value: string;
}

/** Deep clone a trace via structured JSON (traces are plain JSON, no functions/dates-as-objects). */
function cloneTrace(trace: Trace): Trace {
  return JSON.parse(JSON.stringify(trace)) as Trace;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Replace every {{name}} in s with vars[name]; leave unknown names untouched. */
function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

/**
 * Enumerate every templatizable string literal in the trace, in step order. Used by both the vars
 * command (to let the user name a literal) and templatizeFromExamples (to find example matches).
 * eval.input.fn is intentionally NOT yielded; Target fields are never yielded.
 */
export function extractLiterals(trace: Trace): Literal[] {
  const out: Literal[] = [];
  trace.steps.forEach((step, stepIndex) => {
    switch (step.tool) {
      case "nav":
        if (typeof step.input.arg === "string") {
          out.push({ stepIndex, tool: "nav", field: "arg", value: step.input.arg });
        }
        break;
      case "act":
        if (typeof step.value === "string") {
          out.push({ stepIndex, tool: "act", field: "value", value: step.value });
        }
        break;
      case "fill":
        step.fields.forEach((f, fi) => {
          out.push({ stepIndex, tool: "fill", field: `fields[${fi}].value`, value: f.value });
        });
        break;
      case "eval":
        (step.input.args ?? []).forEach((a, ai) => {
          if (typeof a === "string") {
            out.push({ stepIndex, tool: "eval", field: `args[${ai}]`, value: a });
          }
        });
        break;
      case "store":
        out.push({ stepIndex, tool: "store", field: "key", value: step.input.key });
        if (typeof step.input.value === "string") {
          out.push({ stepIndex, tool: "store", field: "value", value: step.input.value });
        }
        break;
    }
  });
  return out;
}

/**
 * Substitute {{var}} -> vars[name] across every templatizable field of a cloned trace.
 * String interpolation only: eval string args are interpolated in place, types are left to the fn.
 */
export function substituteVars(trace: Trace, vars: Record<string, string>): Trace {
  const clone = cloneTrace(trace);
  for (const step of clone.steps) {
    switch (step.tool) {
      case "nav":
        if (typeof step.input.arg === "string") step.input.arg = interpolate(step.input.arg, vars);
        break;
      case "act":
        if (typeof step.value === "string") step.value = interpolate(step.value, vars);
        break;
      case "fill":
        for (const f of step.fields) f.value = interpolate(f.value, vars);
        break;
      case "eval":
        if (step.input.args) {
          step.input.args = step.input.args.map((a) =>
            typeof a === "string" ? interpolate(a, vars) : a,
          );
        }
        break;
      case "store":
        step.input.key = interpolate(step.input.key, vars);
        if (typeof step.input.value === "string") {
          step.input.value = interpolate(step.input.value, vars);
        }
        break;
    }
  }
  return clone;
}

/**
 * Replace example values with {{name}} placeholders and set trace.params. For nav.arg the example
 * is replaced as a SUBSTRING (a URL contains it); every other field uses exact-equality replace.
 * Returns a cloned trace; params are appended (deduped by name, last example wins).
 */
export function templatizeFromExamples(trace: Trace, vars: Record<string, string>): Trace {
  const clone = cloneTrace(trace);
  const entries = Object.entries(vars).filter(([, ex]) => ex.length > 0);

  const exact = (s: string): string => {
    for (const [name, ex] of entries) if (s === ex) return `{{${name}}}`;
    return s;
  };
  // Process substring (nav.arg) replacements longest-example-first so a longer, more specific value
  // wins before any shorter value that is a substring of it (e.g. "computer mouse" before "mouse").
  // Naive substring replace is still a known foot-gun for very short values; `pixelpi vars` refines.
  const byLength = [...entries].sort((a, b) => b[1].length - a[1].length);
  const substr = (s: string): string => {
    let out = s;
    for (const [name, ex] of byLength) out = out.split(ex).join(`{{${name}}}`);
    return out;
  };

  for (const step of clone.steps) {
    switch (step.tool) {
      case "nav":
        if (typeof step.input.arg === "string") step.input.arg = substr(step.input.arg);
        break;
      case "act":
        if (typeof step.value === "string") step.value = exact(step.value);
        break;
      case "fill":
        for (const f of step.fields) f.value = exact(f.value);
        break;
      case "eval":
        if (step.input.args) {
          step.input.args = step.input.args.map((a) => (typeof a === "string" ? exact(a) : a));
        }
        break;
      case "store":
        step.input.key = exact(step.input.key);
        if (typeof step.input.value === "string") step.input.value = exact(step.input.value);
        break;
    }
  }

  const params: TraceParam[] = clone.params ? [...clone.params] : [];
  for (const [name, example] of Object.entries(vars)) {
    const existing = params.find((p) => p.name === name);
    if (existing) existing.example = example;
    else params.push({ name, example, required: true });
  }
  clone.params = params;
  return clone;
}

/**
 * Check a data row supplies every REQUIRED param. A param is satisfied when its key is present and
 * not undefined/null/empty-string. Returns { ok: true } or { missing: [...] } naming the gaps.
 */
export function validateParams(
  trace: Trace,
  row: Record<string, unknown>,
): { ok: true } | { missing: string[] } {
  const required = (trace.params ?? []).filter((p) => p.required);
  const missing = required
    .filter((p) => {
      const v = row[p.name];
      return v === undefined || v === null || v === "";
    })
    .map((p) => p.name);
  return missing.length === 0 ? { ok: true } : { missing };
}
