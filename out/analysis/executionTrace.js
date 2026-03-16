"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceExecutionPath = traceExecutionPath;
async function traceExecutionPath(graph, startNodeId, maxDepth = 25) {
    const normalizedMaxDepth = Math.max(0, Math.min(maxDepth, 25));
    const visited = new Set();
    const queue = [{ nodeId: startNodeId, depth: 0, parentNodeId: undefined }];
    const nodes = [];
    const edges = [];
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
async function yieldToEventLoop() {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
}
//# sourceMappingURL=executionTrace.js.map