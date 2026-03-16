import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';

export interface TraversalEdge {
  readonly from: string;
  readonly to: string;
}

export interface TraversalNode {
  readonly nodeId: string;
  readonly symbolName: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly depth: number;
  readonly parentNodeId: string | undefined;
}

export interface ExecutionTraceResult {
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

export async function traceExecutionPath(
  graph: WorkspaceGraph,
  startNodeId: string,
  maxDepth = 25,
): Promise<ExecutionTraceResult> {
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
      for (const calleeId of graphNode.outgoingCalls) {
        if (!visited.has(calleeId)) {
          queue.push({
            nodeId: calleeId,
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
