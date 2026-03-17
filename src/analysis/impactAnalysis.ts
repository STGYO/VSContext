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
  readonly parentEdgeType: TraversalEdge['edgeType'] | undefined;
}

export async function findImpactOfChange(
  graph: WorkspaceGraph,
  startNodeId: string,
  maxDepth = 25,
): Promise<ImpactAnalysisResult> {
  const normalizedMaxDepth = Math.max(0, Math.min(maxDepth, 25));
  const visited = new Set<string>();
  const queue: QueueEntry[] = [{ nodeId: startNodeId, depth: 0, parentNodeId: undefined, parentEdgeType: undefined }];
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
      edges.push({
        from: current.parentNodeId,
        to: current.nodeId,
        edgeType: current.parentEdgeType ?? 'calls',
      });
    }

    if (current.depth < normalizedMaxDepth) {
      for (const edge of listIncomingEdges(graphNode)) {
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

function listIncomingEdges(node: GraphNode): TraversalEdge[] {
  const edges: TraversalEdge[] = [];

  for (const sourceId of node.incomingCalls) {
    edges.push({ from: node.id, to: sourceId, edgeType: 'calls' });
  }

  for (const sourceId of node.incomingImplementations) {
    edges.push({ from: node.id, to: sourceId, edgeType: 'implements' });
  }

  for (const sourceId of node.incomingReferences.reads) {
    edges.push({ from: node.id, to: sourceId, edgeType: 'reads' });
  }

  for (const sourceId of node.incomingReferences.writes) {
    edges.push({ from: node.id, to: sourceId, edgeType: 'writes' });
  }

  return edges;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
