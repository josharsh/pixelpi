import { describe, it, expect } from "vitest";
import { compactAxTree, compactState, type AXNode } from "./snapshot";

function ax(partial: Partial<AXNode>): AXNode {
  return { nodeId: "n", ...partial };
}

const tree: AXNode[] = [
  ax({ nodeId: "1", role: { type: "role", value: "RootWebArea" }, backendDOMNodeId: 1 }), // not interactive, not named-role -> dropped
  ax({
    nodeId: "2",
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Sign in" },
    backendDOMNodeId: 10,
    properties: [{ name: "disabled", value: { type: "boolean", value: true } }],
  }),
  ax({
    nodeId: "3",
    role: { type: "role", value: "textbox" },
    name: { type: "computedString", value: "Email" },
    backendDOMNodeId: 11,
    value: { type: "string", value: "a@b.com" },
    properties: [{ name: "focused", value: { type: "boolean", value: true } }],
  }),
  ax({
    nodeId: "4",
    role: { type: "role", value: "checkbox" },
    name: { type: "computedString", value: "Remember me" },
    backendDOMNodeId: 12,
    properties: [{ name: "checked", value: { type: "tristate", value: true } }],
  }),
  ax({
    nodeId: "5",
    ignored: true,
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Hidden" },
    backendDOMNodeId: 13,
  }), // ignored -> dropped
  ax({
    nodeId: "6",
    role: { type: "role", value: "heading" },
    name: { type: "computedString", value: "Welcome" },
    backendDOMNodeId: 14,
  }), // named role -> kept
  ax({
    nodeId: "7",
    role: { type: "role", value: "heading" },
    name: { type: "computedString", value: "" },
    backendDOMNodeId: 15,
  }), // named role but empty name -> dropped
  ax({
    nodeId: "8",
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "NoBackend" },
  }), // no backendDOMNodeId -> dropped
];

describe("compactAxTree", () => {
  const { refs, refMap } = compactAxTree(tree);

  it("keeps only interactive + named-role nodes that are not ignored and have a backend id", () => {
    expect(refs.map((r) => r.role)).toEqual(["button", "textbox", "checkbox", "heading"]);
    expect(refs.map((r) => r.name)).toEqual(["Sign in", "Email", "Remember me", "Welcome"]);
  });

  it("assigns sequential ref ids from 1", () => {
    expect(refs.map((r) => r.ref)).toEqual([1, 2, 3, 4]);
  });

  it("maps refs to their backendDOMNodeId", () => {
    expect(refMap.get(1)?.backendDOMNodeId).toBe(10);
    expect(refMap.get(2)?.backendDOMNodeId).toBe(11);
    expect(refMap.get(3)?.backendDOMNodeId).toBe(12);
    expect(refMap.get(4)?.backendDOMNodeId).toBe(14);
  });

  it("renders state flags and value", () => {
    expect(refs[0]!.state).toBe("disabled");
    expect(refs[1]!.state).toBe("focused value=a@b.com");
    expect(refs[2]!.state).toBe("checked");
    expect(refs[3]!.state).toBeUndefined();
  });

  it("drops the ignored node entirely", () => {
    expect(refs.find((r) => r.name === "Hidden")).toBeUndefined();
  });
});

describe("compactState", () => {
  it("returns undefined when no flags and no value", () => {
    expect(compactState(ax({ role: { type: "role", value: "link" } }))).toBeUndefined();
  });

  it("emits mixed for tristate mixed", () => {
    const s = compactState(
      ax({ properties: [{ name: "checked", value: { type: "tristate", value: "mixed" } }] }),
    );
    expect(s).toBe("checked=mixed");
  });

  it("omits false flags", () => {
    const s = compactState(
      ax({ properties: [{ name: "disabled", value: { type: "boolean", value: false } }] }),
    );
    expect(s).toBeUndefined();
  });
});

describe("compactAxTree is uncapped", () => {
  it("emits every qualifying node so look() can page past MAX_REFS", () => {
    const many: AXNode[] = Array.from({ length: 250 }, (_, i) =>
      ax({
        nodeId: String(i),
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: `b${i}` },
        backendDOMNodeId: i + 1,
      }),
    );
    const { refs, refMap } = compactAxTree(many);
    expect(refs.length).toBe(250);
    expect(refs[249].name).toBe("b249");
    // act/fill must be able to resolve a ref that no single look() rendered.
    expect(refMap.get(250)?.backendDOMNodeId).toBe(250);
  });
});

describe("compactAxTree noise removal", () => {
  const node = (role: string, name: string, id: number) =>
    ax({
      nodeId: String(id),
      role: { type: "role", value: role },
      name: { type: "computedString", value: name },
      backendDOMNodeId: id,
    });

  it("drops separator-only text that costs tokens and says nothing", () => {
    const { refs } = compactAxTree([
      node("StaticText", "140 points", 1),
      node("StaticText", " | ", 2),
      node("StaticText", " (", 3),
      node("StaticText", ")", 4),
      node("StaticText", "93 comments", 5),
    ]);
    expect(refs.map((r) => r.name)).toEqual(["140 points", "93 comments"]);
  });

  it("drops a non-interactive node repeating a name already emitted", () => {
    const { refs } = compactAxTree([
      node("cell", "To Save C, We Must Save ABI", 1),
      node("StaticText", "To Save C, We Must Save ABI", 2),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].role).toBe("cell");
  });

  it("keeps interactive duplicates — two buttons named Submit are two things to click", () => {
    const { refs } = compactAxTree([node("button", "Submit", 1), node("button", "Submit", 2)]);
    expect(refs).toHaveLength(2);
    expect(refMapIds(refs)).toEqual([1, 2]);
  });

  it("keeps repeated table cells — repetition is data, not noise", () => {
    const { refs } = compactAxTree([node("cell", "N/A", 1), node("cell", "N/A", 2), node("cell", "N/A", 3)]);
    expect(refs).toHaveLength(3);
  });

  it("still drops a duplicate link's text while keeping the link itself", () => {
    const { refs } = compactAxTree([node("link", "Chicken Scheme 6.0", 1), node("StaticText", "Chicken Scheme 6.0", 2)]);
    expect(refs.map((r) => r.role)).toEqual(["link"]);
  });
});

const refMapIds = (refs: { ref: number }[]) => refs.map((r) => r.ref);
