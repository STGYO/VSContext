"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceGraphBuilder = void 0;
const workspaceScanner_1 = require("../utils/workspaceScanner");
class WorkspaceGraphBuilder {
    indexer;
    logger;
    cachedGraph = {
        nodes: new Map(),
        fileIndex: new Map(),
        builtAt: undefined,
    };
    dirty = true;
    initialIndexCompleted = false;
    buildPromise;
    symbolCache = new Map();
    constructor(indexer, logger) {
        this.indexer = indexer;
        this.logger = logger;
    }
    markDirty() {
        this.dirty = true;
    }
    isIndexing() {
        return this.buildPromise !== undefined;
    }
    hasCompletedInitialIndex() {
        return this.initialIndexCompleted;
    }
    peekGraph() {
        return this.cachedGraph;
    }
    getNode(nodeId) {
        return this.cachedGraph.nodes.get(nodeId);
    }
    async getGraph() {
        if (!this.dirty) {
            return this.cachedGraph;
        }
        return this.buildWorkspaceGraph();
    }
    async ensureDocumentIndexed(uri) {
        if (this.isIndexing()) {
            return;
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        if (this.cachedGraph.fileIndex.has(filePath)) {
            return;
        }
        await this.upsertDocument(uri);
    }
    async upsertDocument(uri) {
        if (uri.scheme !== 'file') {
            return;
        }
        if (!this.initialIndexCompleted) {
            return;
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        this.removeFileSymbols(filePath);
        const symbols = await this.indexer.indexDocumentSymbols(uri);
        for (const symbol of symbols) {
            this.symbolCache.set(symbol.id, symbol);
            this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
        }
        await this.populateOutgoingCallsForSymbols(symbols);
        this.trimDanglingOutgoingEdges();
        this.rebuildFileIndex();
        this.populateIncomingCalls(this.cachedGraph.nodes);
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            builtAt: new Date(),
        };
        this.dirty = false;
    }
    async removeDocument(uri) {
        if (uri.scheme !== 'file') {
            return;
        }
        if (!this.initialIndexCompleted) {
            return;
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        this.removeFileSymbols(filePath);
        this.trimDanglingOutgoingEdges();
        this.rebuildFileIndex();
        this.populateIncomingCalls(this.cachedGraph.nodes);
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            builtAt: new Date(),
        };
        this.dirty = false;
    }
    async buildWorkspaceGraph() {
        if (this.buildPromise) {
            return this.buildPromise;
        }
        this.buildPromise = this.doBuildWorkspaceGraph();
        try {
            return await this.buildPromise;
        }
        finally {
            this.buildPromise = undefined;
        }
    }
    async doBuildWorkspaceGraph() {
        this.logger.info('Building workspace graph.');
        try {
            const indexResult = await this.indexer.indexWorkspaceSymbols();
            const indexedSymbols = indexResult.indexed;
            this.symbolCache = new Map(indexedSymbols);
            const nodeMap = this.createNodeMap(indexedSymbols);
            await this.populateOutgoingCallsForSymbols([...indexedSymbols.values()], nodeMap);
            this.populateIncomingCalls(nodeMap);
            const fileIndex = this.createFileIndex(nodeMap);
            const edgeCount = [...nodeMap.values()].reduce((count, node) => count + node.outgoingCalls.length, 0);
            this.cachedGraph = {
                nodes: nodeMap,
                fileIndex,
                builtAt: new Date(),
            };
            this.initialIndexCompleted = true;
            this.dirty = false;
            this.logIndexingSummary(indexResult);
            this.logger.info(`Workspace graph built with ${nodeMap.size} nodes and ${edgeCount} edges.`);
            return this.cachedGraph;
        }
        catch (error) {
            this.logger.error('Workspace graph build failed.', error);
            this.cachedGraph = {
                nodes: new Map(),
                fileIndex: new Map(),
                builtAt: new Date(),
            };
            this.initialIndexCompleted = true;
            this.dirty = false;
            return this.cachedGraph;
        }
    }
    createNodeMap(indexedSymbols) {
        const nodeMap = new Map();
        for (const symbol of indexedSymbols.values()) {
            nodeMap.set(symbol.id, {
                id: symbol.id,
                symbolName: symbol.symbolName,
                symbolKind: symbol.symbolKind,
                filePath: symbol.filePath,
                uriString: symbol.uri.toString(),
                lineNumber: symbol.lineNumber,
                rangeStartLine: symbol.range.start.line + 1,
                rangeEndLine: symbol.range.end.line + 1,
                outgoingCalls: [],
                incomingCalls: [],
            });
        }
        return nodeMap;
    }
    toGraphNode(symbol) {
        return {
            id: symbol.id,
            symbolName: symbol.symbolName,
            symbolKind: symbol.symbolKind,
            filePath: symbol.filePath,
            uriString: symbol.uri.toString(),
            lineNumber: symbol.lineNumber,
            rangeStartLine: symbol.range.start.line + 1,
            rangeEndLine: symbol.range.end.line + 1,
            outgoingCalls: [],
            incomingCalls: [],
        };
    }
    async populateOutgoingCallsForSymbols(symbols, targetNodes = this.cachedGraph.nodes) {
        let processed = 0;
        for (const symbol of symbols) {
            const node = targetNodes.get(symbol.id);
            if (!node) {
                continue;
            }
            const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
            node.outgoingCalls = outgoing.filter((targetId) => targetNodes.has(targetId));
            processed += 1;
            if (processed % 25 === 0) {
                await this.yieldToEventLoop();
            }
        }
    }
    populateIncomingCalls(nodeMap) {
        for (const node of nodeMap.values()) {
            node.incomingCalls = [];
        }
        for (const node of nodeMap.values()) {
            for (const outgoingId of node.outgoingCalls) {
                const target = nodeMap.get(outgoingId);
                if (!target) {
                    continue;
                }
                if (!target.incomingCalls.includes(node.id)) {
                    target.incomingCalls.push(node.id);
                }
            }
        }
    }
    createFileIndex(nodeMap) {
        const fileIndex = new Map();
        for (const node of nodeMap.values()) {
            const existing = fileIndex.get(node.filePath) ?? [];
            existing.push(node.id);
            fileIndex.set(node.filePath, existing);
        }
        for (const [filePath, nodeIds] of fileIndex) {
            const sorted = [...nodeIds].sort((left, right) => {
                const leftNode = nodeMap.get(left);
                const rightNode = nodeMap.get(right);
                if (!leftNode || !rightNode) {
                    return left.localeCompare(right);
                }
                return leftNode.lineNumber - rightNode.lineNumber;
            });
            fileIndex.set(filePath, sorted);
        }
        return fileIndex;
    }
    removeFileSymbols(filePath) {
        const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
        for (const nodeId of existingIds) {
            this.cachedGraph.nodes.delete(nodeId);
            this.symbolCache.delete(nodeId);
        }
        this.cachedGraph.fileIndex.delete(filePath);
    }
    trimDanglingOutgoingEdges() {
        for (const node of this.cachedGraph.nodes.values()) {
            node.outgoingCalls = node.outgoingCalls.filter((targetId) => this.cachedGraph.nodes.has(targetId));
        }
    }
    rebuildFileIndex() {
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.createFileIndex(this.cachedGraph.nodes),
            builtAt: this.cachedGraph.builtAt,
        };
    }
    logIndexingSummary(indexResult) {
        this.logger.info(`[VSContext] Indexed ${indexResult.scannedFileCount} files.`);
        this.logger.info(`[VSContext] Indexed ${indexResult.indexedSymbolCount} symbols.`);
        this.logger.info(`[VSContext] Skipped dependency directories: ${indexResult.skippedByExclusions} files.`);
    }
    async yieldToEventLoop() {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}
exports.WorkspaceGraphBuilder = WorkspaceGraphBuilder;
//# sourceMappingURL=graphBuilder.js.map