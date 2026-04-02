import { GraphEdgeType, GraphNode, WorkspaceGraph } from '../graph/graphBuilder';

export interface TraversalEdge {
  readonly from: string;
  readonly to: string;
  readonly edgeType: GraphEdgeType;
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

const TRAVERSAL_TIMEOUT_MS = 10_000;

interface QueueEntry {
  readonly nodeId: string;
  readonly depth: number;
  readonly parentNodeId: string | undefined;
  readonly parentEdgeType: GraphEdgeType | undefined;
}

export async function traceExecutionPath(
  graph: WorkspaceGraph,
  startNodeId: string,
  maxDepth = 25,
): Promise<ExecutionTraceResult> {
  const normalizedMaxDepth = Math.max(0, Math.min(maxDepth, 25));
  const deadline = Date.now() + TRAVERSAL_TIMEOUT_MS;
  const visited = new Set<string>();
  const queue: QueueEntry[] = [{ nodeId: startNodeId, depth: 0, parentNodeId: undefined, parentEdgeType: undefined }];
  const nodes: TraversalNode[] = [];
  const edges: TraversalEdge[] = [];

  let iterations = 0;

  while (queue.length > 0) {
    if (Date.now() >= deadline) {
      break;
    }

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
      edges.push({
        from: current.parentNodeId,
        to: current.nodeId,
        edgeType: current.parentEdgeType ?? 'calls',
      });
    }

    if (current.depth < normalizedMaxDepth) {
      for (const edge of listOutgoingEdges(graphNode)) {
        if (!visited.has(edge.to)) {
          queue.push({
            nodeId: edge.to,
            depth: current.depth + 1,
            parentNodeId: current.nodeId,
            parentEdgeType: edge.edgeType,
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

function listOutgoingEdges(node: GraphNode): TraversalEdge[] {
  const edges: TraversalEdge[] = [];

  for (const targetId of node.outgoingCalls) {
    edges.push({ from: node.id, to: targetId, edgeType: 'calls' });
  }

  for (const targetId of node.implementations) {
    edges.push({ from: node.id, to: targetId, edgeType: 'implements' });
  }

  for (const targetId of node.references.reads) {
    edges.push({ from: node.id, to: targetId, edgeType: 'reads' });
  }

  for (const targetId of node.references.writes) {
    edges.push({ from: node.id, to: targetId, edgeType: 'writes' });
  }

  return edges;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
