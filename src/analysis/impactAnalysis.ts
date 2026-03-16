import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { TraversalEdge, TraversalNode } from './executionTrace';

export interface ImpactAnalysisResult {
  readonly startNodeId: string;
  readonly maxDepth: number;
  readonly nodes: TraversalNode[];
  readonly edges: TraversalEdge[];
}

interface QueueEntry {
  readonly nodeId: string;
  readonly depth: number;
  readonly parentNodeId: string | undefined;
}

export async function findImpactOfChange(
  graph: WorkspaceGraph,
  startNodeId: string,
  maxDepth = 25,
): Promise<ImpactAnalysisResult> {
  const normalizedMaxDepth = Math.max(0, Math.min(maxDepth, 25));
  const visited = new Set<string>();
  const queue: QueueEntry[] = [{ nodeId: startNodeId, depth: 0, parentNodeId: undefined }];
  const nodes: TraversalNode[] = [];
  const edges: TraversalEdge[] = [];

  let iterations = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.nodeId)) {
      continue;
    }

    visited.add(current.nodeId);

    const graphNode = graph.nodes.get(current.nodeId);
    if (!graphNode) {
      continue;
    }

    nodes.push(toTraversalNode(graphNode, current.depth, current.parentNodeId));
    if (current.parentNodeId) {
      edges.push({ from: current.parentNodeId, to: current.nodeId });
    }

    if (current.depth < normalizedMaxDepth) {
      for (const callerId of graphNode.incomingCalls) {
        if (!visited.has(callerId)) {
          queue.push({
            nodeId: callerId,
            depth: current.depth + 1,
            parentNodeId: current.nodeId,
          });
        }
      }
    }

    iterations += 1;
    if (iterations % 25 === 0) {
      await yieldToEventLoop();
    }
  }

  return {
    startNodeId,
    maxDepth: normalizedMaxDepth,
    nodes,
    edges,
  };
}

function toTraversalNode(node: GraphNode, depth: number, parentNodeId: string | undefined): TraversalNode {
  return {
    nodeId: node.id,
    symbolName: node.symbolName,
    filePath: node.filePath,
    lineNumber: node.lineNumber,
    depth,
    parentNodeId,
  };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
