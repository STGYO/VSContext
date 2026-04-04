import * as assert from "assert";
import { describe, it } from "mocha";

import type { GraphNode, WorkspaceGraph } from "../../src/graph/graphBuilder";
import { serializeWorkspaceGraphForTests } from "../../src/views/codeGraphView";

function createNode(partial: Partial<GraphNode> & { id: string; symbolName: string; filePath: string; uriString: string; nodeType: GraphNode["nodeType"] }): GraphNode {
  return {
    id: partial.id,
    symbolName: partial.symbolName,
    symbolKind: partial.symbolKind ?? 12,
    nodeType: partial.nodeType,
    filePath: partial.filePath,
    uriString: partial.uriString,
    lineNumber: partial.lineNumber ?? 1,
    rangeStartLine: partial.rangeStartLine ?? 1,
    rangeStartCharacter: partial.rangeStartCharacter ?? 0,
    rangeEndLine: partial.rangeEndLine ?? 1,
    rangeEndCharacter: partial.rangeEndCharacter ?? 1,
    outgoingCalls: partial.outgoingCalls ?? [],
    implementations: partial.implementations ?? [],
    references: partial.references ?? { reads: [], writes: [] },
    incomingCalls: partial.incomingCalls ?? [],
    incomingImplementations: partial.incomingImplementations ?? [],
    incomingReferences: partial.incomingReferences ?? { reads: [], writes: [] },
  };
}

describe("CodeGraphView hierarchy serialization", () => {
  it("creates file->branch->symbol tree with consistent parent and level semantics", () => {
    const filePath = "src/demo.ts";
    const uri = "file:///workspace/src/demo.ts";

    const classNode = createNode({
      id: "class-demo",
      symbolName: "Demo",
      symbolKind: 5,
      nodeType: "class",
      filePath,
      uriString: uri,
      lineNumber: 1,
      rangeStartLine: 1,
      rangeEndLine: 20,
    });

    const methodNode = createNode({
      id: "method-run",
      symbolName: "run",
      symbolKind: 6,
      nodeType: "method",
      filePath,
      uriString: uri,
      lineNumber: 4,
      rangeStartLine: 4,
      rangeEndLine: 10,
    });

    const graph: WorkspaceGraph = {
      nodes: new Map([
        [classNode.id, classNode],
        [methodNode.id, methodNode],
      ]),
      fileIndex: new Map([[filePath, [classNode.id, methodNode.id]]]),
      fileRelationships: [],
      builtAt: undefined,
      fileRoleSummary: undefined,
    };

    const payload = serializeWorkspaceGraphForTests(graph);
    const nodeById = new Map(payload.nodes.map((node) => [node.id, node]));

    const fileNode = nodeById.get(`file::${filePath}`);
    assert.ok(fileNode, "File root node should exist");

    const classGraphNode = nodeById.get(classNode.id);
    const methodGraphNode = nodeById.get(methodNode.id);
    assert.ok(classGraphNode, "Class node should exist in serialized payload");
    assert.ok(methodGraphNode, "Method node should exist in serialized payload");
    assert.strictEqual(classGraphNode?.parentId?.startsWith("branch::"), true);
    assert.strictEqual(methodGraphNode?.parentId?.startsWith("branch::"), true);

    const branchNodes = payload.nodes.filter((node) => node.type === "branch");
    assert.ok(branchNodes.length > 0, "Branch nodes should be materialized");

    for (const node of payload.nodes) {
      if (!node.parentId) {
        continue;
      }

      const parent = nodeById.get(node.parentId);
      assert.ok(parent, `Parent node should exist for ${node.id}`);
      assert.strictEqual(
        node.treeLevel,
        (parent?.treeLevel ?? 0) + 1,
        `treeLevel should be parent treeLevel + 1 for ${node.id}`,
      );
    }

    const noImportsLeaf = nodeById.get(`dependency::${filePath}::imports::none`);
    const noCommentsLeaf = nodeById.get(`metadata::${filePath}::comments::none`);
    assert.ok(noImportsLeaf, "Synthetic no-import leaf should be present");
    assert.ok(noCommentsLeaf, "Synthetic metadata leaf should be present");
  });
});
