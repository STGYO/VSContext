import { findImpactOfChange } from '../analysis/impactAnalysis';
import { traceExecutionPath, TraversalEdge, TraversalNode } from '../analysis/executionTrace';
import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { ChatContextBudget, isNodeAllowedForChat } from './contextFilters';

interface BuildSummaryOptions {
  readonly budget: ChatContextBudget;
  readonly denylistPatterns: string[];
  readonly focusNode?: GraphNode;
}

interface BudgetSpec {
  readonly maxFiles: number;
  readonly maxHotspots: number;
  readonly focusDepth: number;
  readonly maxFocusNodes: number;
  readonly maxFocusEdges: number;
}

const BUDGETS: Record<ChatContextBudget, BudgetSpec> = {
  small: {
    maxFiles: 6,
    maxHotspots: 5,
    focusDepth: 2,
    maxFocusNodes: 8,
    maxFocusEdges: 10,
  },
  medium: {
    maxFiles: 10,
    maxHotspots: 8,
    focusDepth: 3,
    maxFocusNodes: 14,
    maxFocusEdges: 18,
  },
  large: {
    maxFiles: 16,
    maxHotspots: 12,
    focusDepth: 4,
    maxFocusNodes: 22,
    maxFocusEdges: 30,
  },
};

export async function buildWorkspaceContextSummary(
  graph: WorkspaceGraph,
  options: BuildSummaryOptions,
): Promise<string> {
  const budget = BUDGETS[options.budget];
  const allowedNodes = [...graph.nodes.values()].filter((node) => isNodeAllowedForChat(node, options.denylistPatterns));
  const allowedNodeIds = new Set<string>(allowedNodes.map((node) => node.id));

  if (allowedNodes.length === 0) {
    return [
      'VSContext graph context is empty after filtering.',
      'Try reducing denylist filters in vscontext.chatContextDenylist.',
    ].join('\n');
  }

  const nodeTypeCounts = {
    class: 0,
    function: 0,
    method: 0,
    variable: 0,
  };

  const edgeCounts = {
    calls: 0,
    implements: 0,
    reads: 0,
    writes: 0,
  };

  const fileCounts = new Map<string, number>();

  for (const node of allowedNodes) {
    nodeTypeCounts[node.nodeType] += 1;
    fileCounts.set(node.filePath, (fileCounts.get(node.filePath) ?? 0) + 1);

    edgeCounts.calls += countAllowedTargets(node.outgoingCalls, allowedNodeIds);
    edgeCounts.implements += countAllowedTargets(node.implementations, allowedNodeIds);
    edgeCounts.reads += countAllowedTargets(node.references.reads, allowedNodeIds);
    edgeCounts.writes += countAllowedTargets(node.references.writes, allowedNodeIds);
  }

  const topFiles = [...fileCounts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, budget.maxFiles);

  const hotspots = allowedNodes
    .map((node) => ({
      node,
      score:
        node.outgoingCalls.length
        + node.incomingCalls.length
        + node.implementations.length
        + node.incomingImplementations.length
        + node.references.reads.length
        + node.references.writes.length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.node.symbolName.localeCompare(right.node.symbolName);
    })
    .slice(0, budget.maxHotspots);

  const lines: string[] = [];
  lines.push('## VSContext Workspace Summary');
  lines.push(`- Indexed symbols after filtering: ${allowedNodes.length}`);
  lines.push(`- Files represented: ${fileCounts.size}`);
  lines.push(`- Node types: classes=${nodeTypeCounts.class}, functions=${nodeTypeCounts.function}, methods=${nodeTypeCounts.method}, variables=${nodeTypeCounts.variable}`);
  lines.push(`- Relationships: calls=${edgeCounts.calls}, implements=${edgeCounts.implements}, reads=${edgeCounts.reads}, writes=${edgeCounts.writes}`);

  lines.push('');
  lines.push('## Top Files By Symbol Density');
  if (topFiles.length === 0) {
    lines.push('- None');
  } else {
    for (const [filePath, symbolCount] of topFiles) {
      lines.push(`- ${filePath}: ${symbolCount} symbols`);
    }
  }

  lines.push('');
  lines.push('## Hotspot Symbols');
  if (hotspots.length === 0) {
    lines.push('- None');
  } else {
    for (const hotspot of hotspots) {
      lines.push(
        `- ${hotspot.node.symbolName} (${hotspot.node.nodeType}) at ${hotspot.node.filePath}:${hotspot.node.lineNumber} -> relationship score ${hotspot.score}`,
      );
    }
  }

  if (options.focusNode && allowedNodeIds.has(options.focusNode.id)) {
    const focusSection = await buildFocusSection(graph, options.focusNode, allowedNodeIds, budget);
    lines.push('');
    lines.push(...focusSection);
  }

  lines.push('');
  lines.push('Use this context as a structural summary, not as literal source code.');

  return lines.join('\n');
}

async function buildFocusSection(
  graph: WorkspaceGraph,
  focusNode: GraphNode,
  allowedNodeIds: Set<string>,
  budget: BudgetSpec,
): Promise<string[]> {
  const lines: string[] = [];
  lines.push('## Focus Symbol Summary');
  lines.push(`- Focus: ${focusNode.symbolName} (${focusNode.nodeType}) at ${focusNode.filePath}:${focusNode.lineNumber}`);

  const [trace, impact] = await Promise.all([
    traceExecutionPath(graph, focusNode.id, budget.focusDepth),
    findImpactOfChange(graph, focusNode.id, budget.focusDepth),
  ]);

  const traceNodes = filterTraversalNodes(trace.nodes, allowedNodeIds, budget.maxFocusNodes);
  const traceEdges = filterTraversalEdges(trace.edges, allowedNodeIds, budget.maxFocusEdges);
  const impactNodes = filterTraversalNodes(impact.nodes, allowedNodeIds, budget.maxFocusNodes);
  const impactEdges = filterTraversalEdges(impact.edges, allowedNodeIds, budget.maxFocusEdges);

  lines.push(`- Downstream slice: ${traceNodes.length} nodes, ${traceEdges.length} edges (depth<=${budget.focusDepth})`);
  for (const item of traceNodes.slice(0, budget.maxFocusNodes)) {
    lines.push(`  - [trace d${item.depth}] ${item.symbolName} at ${item.filePath}:${item.lineNumber}`);
  }

  lines.push(`- Upstream impact slice: ${impactNodes.length} nodes, ${impactEdges.length} edges (depth<=${budget.focusDepth})`);
  for (const item of impactNodes.slice(0, budget.maxFocusNodes)) {
    lines.push(`  - [impact d${item.depth}] ${item.symbolName} at ${item.filePath}:${item.lineNumber}`);
  }

  return lines;
}

function filterTraversalNodes(
  nodes: readonly TraversalNode[],
  allowedNodeIds: Set<string>,
  maxNodes: number,
): TraversalNode[] {
  return nodes.filter((node) => allowedNodeIds.has(node.nodeId)).slice(0, maxNodes);
}

function filterTraversalEdges(
  edges: readonly TraversalEdge[],
  allowedNodeIds: Set<string>,
  maxEdges: number,
): TraversalEdge[] {
  return edges
    .filter((edge) => allowedNodeIds.has(edge.from) && allowedNodeIds.has(edge.to))
    .slice(0, maxEdges);
}

function countAllowedTargets(targets: readonly string[], allowedNodeIds: Set<string>): number {
  let count = 0;
  for (const target of targets) {
    if (allowedNodeIds.has(target)) {
      count += 1;
    }
  }

  return count;
}
