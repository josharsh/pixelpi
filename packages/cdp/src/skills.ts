import type { CdpSession, Skill, Store } from "./types";

/** PURE: glob match where `*` -> `.*`. Everything else is literal. */
export function matchUrl(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

/** Does any of the skill's patterns match this url? */
export function skillMatches(skill: Skill, url: string): boolean {
  return skill.match.some((p) => matchUrl(p, url));
}

/**
 * Wrap a skill's function-body source into an IIFE suitable for injection.
 * The body is executed in the page (or isolated) realm with no arguments.
 */
export function wrapSkill(skill: Skill): string {
  return `(function(){try{${skill.fn}}catch(e){}})();`;
}

async function loadSkills(store: Store): Promise<Skill[]> {
  const keys = await store.list("skills/");
  const out: Skill[] = [];
  for (const key of keys) {
    const raw = await store.get(key);
    if (raw && typeof raw === "object") out.push(raw as Skill);
  }
  return out;
}

/** Inject every stored skill whose match applies to `url` into the current page. */
export async function applySkills(session: CdpSession, store: Store, url: string): Promise<string[]> {
  const skills = await loadSkills(store);
  const applied: string[] = [];
  for (const skill of skills) {
    if (!skillMatches(skill, url)) continue;
    await session.send("Runtime.evaluate", {
      expression: wrapSkill(skill),
      awaitPromise: true,
      userGesture: true,
    });
    applied.push(skill.name);
  }
  return applied;
}
