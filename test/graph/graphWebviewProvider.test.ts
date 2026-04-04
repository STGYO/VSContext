import * as assert from "assert";
import { describe, it } from "mocha";

import type {
  CodeGraphEdge,
  CodeGraphNode,
  CodeGraphNodeType,
  CodeGraphPayload,
} from "../../src/views/codeGraphView";
import { graphWebviewProviderTestApi } from "../../src/views/graphWebviewProvider";

function createNode(
  id: string,
  type: CodeGraphNodeType,
  degree: number,
): CodeGraphNode {
  return {
    id,
    name: id,
    type,
    filePath: `src/${id}.ts`,
    uriString: `file:///workspace/src/${id}.ts`,
    line: 1,
    rangeStartLine: 1,
    rangeStartCharacter: 0,
    rangeEndLine: 1,
    rangeEndCharacter: 1,
    degree,
  };
}

function createPayload(nodes: CodeGraphNode[], edges: CodeGraphEdge[]): CodeGraphPayload {
  return {
    nodes,
    edges,
    meta: {
      generatedAt: new Date().toISOString(),
      knowledgeModelVersion: 1,
      knowledgeNodeKinds: [],
      knowledgeRelationshipKinds: [],
      symbolNodeCount: nodes.length,
      fileNodeCount: nodes.filter((node) => node.type === "file").length,
      edgeCount: edges.length,
    },
  };
}

describe("graphWebviewProvider session behavior", () => {
  it("caps initial visibility at node budget including structural nodes", () => {
    const nodes: CodeGraphNode[] = [];

    for (let index = 0; index < 300; index += 1) {
      nodes.push(createNode(`file-${index}`, "file", 3000 - index));
    }

    for (let index = 0; index < 1100; index += 1) {
      nodes.push(createNode(`branch-${index}`, "branch", 2500 - index));
    }

    for (let index = 0; index < 100; index += 1) {
      nodes.push(createNode(`symbol-${index}`, "function", 100 - index));
    }

    const payload = createPayload(nodes, []);
    const session = graphWebviewProviderTestApi.createWebviewGraphSession(payload);
    const visiblePayload = graphWebviewProviderTestApi.buildVisiblePayload(session);

    assert.strictEqual(visiblePayload.nodes.length, 1200);
    assert.strictEqual(session.visibleNodeIds.size, 1200);
    assert.strictEqual(session.remainingNodes.length, 300);
    assert.strictEqual(session.wasTruncated, true);
  });

  it("includes only edges connected to appended nodes in append payload", () => {
    const nodes = [
      createNode("node-a", "file", 5),
      createNode("node-b", "branch", 4),
      createNode("node-c", "function", 3),
    ];

    const edges: CodeGraphEdge[] = [
      {
        id: "edge-a-b",
        source: "node-a",
        target: "node-b",
        relationship: "branch-subbranch",
      },
      {
        id: "edge-b-c",
        source: "node-b",
        target: "node-c",
        relationship: "branch-leaf",
      },
      {
        id: "edge-c-a",
        source: "node-c",
        target: "node-a",
        relationship: "calls",
      },
    ];

    const payload = createPayload(nodes, edges);
    const session = graphWebviewProviderTestApi.createWebviewGraphSession(payload);

    const appendPayload = graphWebviewProviderTestApi.buildAppendPayload(session, [
      nodes[2],
    ]);

    const appendedEdgeIds = appendPayload.edges
      .map((edge) => edge.id)
      .sort((left, right) => left.localeCompare(right));

    assert.deepStrictEqual(appendedEdgeIds, ["edge-b-c", "edge-c-a"]);
  });
});
