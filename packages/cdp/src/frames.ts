import type { CdpSession } from "./types";

interface FrameTree {
  frame: { id: string; parentId?: string; url: string };
  childFrames?: FrameTree[];
}
export interface FrameScope {
  id: string;
  path: string;
  session: CdpSession;
  parent?: FrameScope;
}
export interface NodeTarget {
  backendDOMNodeId: number;
  role: string;
  name: string;
  frame: FrameScope;
}

/** Traverse both ordinary subframes and separately attached renderer processes. */
export async function frameScopes(session: CdpSession): Promise<FrameScope[]> {
  const sessions = session.frameSessions
    ? await session.frameSessions()
    : [session];
  const trees = await Promise.all(
    sessions.map(async (s) => ({
      session: s,
      tree: (await s.send<{ frameTree: FrameTree }>("Page.getFrameTree"))
        .frameTree,
    })),
  );
  const entries = new Map<string, { tree: FrameTree; session: CdpSession }>();
  const add = (tree: FrameTree, s: CdpSession) => {
    entries.set(tree.frame.id, { tree, session: s });
    for (const child of tree.childFrames ?? []) add(child, s);
  };
  for (const { tree, session: s } of trees) add(tree, s);
  const out: FrameScope[] = [];
  const visit = (id: string, path: string, parent?: FrameScope) => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Frame unavailable: ${id}`);
    const frame: FrameScope = { id, path, session: entry.session, parent };
    out.push(frame);
    const children = [...(entry.tree.childFrames ?? []).map((c) => c.frame.id)];
    // OOP roots can be absent from the parent's returned tree while loading.
    for (const e of entries.values())
      if (e.tree.frame.parentId === id && !children.includes(e.tree.frame.id))
        children.push(e.tree.frame.id);
    children.forEach((child, i) =>
      visit(child, path ? `${path}/${i}` : String(i), frame),
    );
  };
  visit(trees[0].tree.frame.id, "");
  return out;
}

export async function nodeCall<T>(
  target: NodeTarget,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  const s = target.frame.session;
  const { object } = await s.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId: target.backendDOMNodeId },
  );
  try {
    const result = await s.send<{
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description: string } };
    }>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function(...args){return (${fn}).apply(this.nodeType===3 ? this.parentElement : this,args);}`,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  } finally {
    await s
      .send("Runtime.releaseObject", { objectId: object.objectId })
      .catch(() => undefined);
  }
}

export async function frameOwner(
  frame: FrameScope,
): Promise<NodeTarget | undefined> {
  if (!frame.parent) return;
  const { backendNodeId } = await frame.parent.session.send<{
    backendNodeId: number;
  }>("DOM.getFrameOwner", { frameId: frame.id });
  return {
    backendDOMNodeId: backendNodeId,
    role: "iframe",
    name: "",
    frame: frame.parent,
  };
}

export async function scrollTarget(target: NodeTarget): Promise<void> {
  const owner = await frameOwner(target.frame);
  if (owner) await scrollTarget(owner);
  await target.frame.session.send("DOM.scrollIntoViewIfNeeded", {
    backendNodeId: target.backendDOMNodeId,
  });
}

const HIT = `function(x,y){
  let hit=this.ownerDocument.elementFromPoint(x,y);
  while(hit && hit.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
  return !!hit && (hit===this || this.contains(hit));
}`;

/** Translate a frame-local point and verify every embedding frame receives events. */
export async function mainPoint(
  target: NodeTarget,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  let frame = target.frame;
  let p = point;
  while (frame.parent) {
    const owner = (await frameOwner(frame))!;
    const box = await nodeCall<{
      x: number;
      y: number;
      width: number;
      height: number;
      clientWidth: number;
      clientHeight: number;
      offsetWidth: number;
      offsetHeight: number;
      left: number;
      top: number;
    }>(
      owner,
      "function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:this.clientWidth,clientHeight:this.clientHeight,offsetWidth:this.offsetWidth,offsetHeight:this.offsetHeight,left:this.clientLeft,top:this.clientTop};}",
    );
    const sx = box.width / box.offsetWidth,
      sy = box.height / box.offsetHeight;
    p = { x: box.x + (box.left + p.x) * sx, y: box.y + (box.top + p.y) * sy };
    if (!(await nodeCall<boolean>(owner, HIT, [p.x, p.y])))
      throw new Error("Frame is obscured or outside the viewport");
    frame = frame.parent;
  }
  return p;
}

export async function actionable(
  target: NodeTarget,
  editable: boolean,
): Promise<{ x: number; y: number; rect: string }> {
  const state = await nodeCall<{
    error?: string;
    x: number;
    y: number;
    rect: string;
  }>(
    target,
    `function(editable){
    if(!this.isConnected)return {error:'detached'};
    const style=getComputedStyle(this), r=this.getBoundingClientRect();
    if(style.visibility==='hidden'||style.display==='none'||!r.width||!r.height)return {error:'not visible'};
    if(this.matches(':disabled') || this.closest('[aria-disabled="true"],[inert]'))return {error:'disabled'};
    if(editable && (this.readOnly || !(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this.isContentEditable)))return {error:'not editable'};
    if(editable && this instanceof HTMLInputElement && ['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(this.type))return {error:'not a text input'};
    const x=r.x+r.width/2,y=r.y+r.height/2;
    return {x,y,rect:[r.x,r.y,r.width,r.height].join(',')};
  }`,
    [editable],
  );
  if (state.error) throw new Error(state.error);
  if (!(await nodeCall<boolean>(target, HIT, [state.x, state.y])))
    throw new Error("obscured or outside the viewport");
  return { ...(await mainPoint(target, state)), rect: state.rect };
}
