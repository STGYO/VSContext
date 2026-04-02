"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceExecutionPath = traceExecutionPath;
const TRAVERSAL_TIMEOUT_MS = 10_000;
async function traceExecutionPath(graph, startNodeId, maxDepth = 25) {
    const normalizedMaxDepth = Math.max(0, Math.min(maxDepth, 25));
    const deadline = Date.now() + TRAVERSAL_TIMEOUT_MS;
    const visited = new Set();
    const queue = [{ nodeId: startNodeId, depth: 0, parentNodeId: undefined, parentEdgeType: undefined }];
    const nodes = [];
    const edges = [];
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
function toTraversalNode(node, depth, parentNodeId) {
    return {
        nodeId: node.id,
        symbolName: node.symbolName,
        filePath: node.filePath,
        lineNumber: node.lineNumber,
        depth,
        parentNodeId,
    };
}
function listOutgoingEdges(node) {
    const edges = [];
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
async function yieldToEventLoop() {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
}
//# sourceMappingURL=executionTrace.js.map