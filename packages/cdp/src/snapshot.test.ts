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
  const { refs, refMap, truncated, truncatedCount } = compactAxTree(tree);

  it("keeps only interactive + named-role nodes that are not ignored and have a backend id", () => {
    expect(refs.map((r) => r.role)).toEqual(["button", "textbox", "checkbox", "heading"]);
    expect(refs.map((r) => r.name)).toEqual(["Sign in", "Email", "Remember me", "Welcome"]);
    expect(truncated).toBe(false);
    expect(truncatedCount).toBe(0);
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

describe("compactAxTree truncation", () => {
  it("caps at 200 refs and flags truncation", () => {
    const many: AXNode[] = Array.from({ length: 250 }, (_, i) =>
      ax({
        nodeId: String(i),
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: `b${i}` },
        backendDOMNodeId: i + 1,
      }),
    );
    const { refs, truncated, truncatedCount } = compactAxTree(many);
    expect(refs.length).toBe(200);
    expect(truncated).toBe(true);
    expect(truncatedCount).toBe(50);
  });
});
