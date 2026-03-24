"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceGraphBuilder = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const symbolIndexer_1 = require("./symbolIndexer");
const workspaceScanner_1 = require("../utils/workspaceScanner");
const knowledgeModel_1 = require("./knowledgeModel");
const GRAPH_CACHE_VERSION = 3;
const PERSIST_DEBOUNCE_MS = 800;
class WorkspaceGraphBuilder {
    indexer;
    logger;
    cacheFileUri;
    cachedGraph = {
        nodes: new Map(),
        fileIndex: new Map(),
        builtAt: undefined,
    };
    dirty = true;
    initialIndexCompleted = false;
    buildPromise;
    symbolCache = new Map();
    fileModifiedTimes = new Map();
    persistTimer;
    persistQueue = Promise.resolve();
    constructor(indexer, logger, cacheFileUri) {
        this.indexer = indexer;
        this.logger = logger;
        this.cacheFileUri = cacheFileUri;
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
    getTrackedFileModifiedTimes() {
        return new Map(this.fileModifiedTimes);
    }
    async hydrateFromCache() {
        if (!this.cacheFileUri) {
            return false;
        }
        let rawContent;
        try {
            rawContent = await vscode.workspace.fs.readFile(this.cacheFileUri);
        }
        catch (error) {
            if (this.isFileNotFoundError(error)) {
                return false;
            }
            this.logger.warn(`Unable to read VSContext graph cache. Falling back to full rebuild. ${String(error)}`);
            return false;
        }
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(rawContent).toString('utf8'));
        }
        catch {
            this.logger.warn('VSContext graph cache is not valid JSON. Falling back to full rebuild.');
            return false;
        }
        const snapshot = this.parseSnapshot(parsed);
        if (!snapshot) {
            this.logger.warn('VSContext graph cache schema is invalid. Falling back to full rebuild.');
            return false;
        }
        const currentWorkspaceUri = (0, workspaceScanner_1.getPrimaryWorkspaceFolder)()?.uri.toString();
        if (snapshot.workspaceFolderUri && currentWorkspaceUri && snapshot.workspaceFolderUri !== currentWorkspaceUri) {
            return false;
        }
        const nodeMap = new Map();
        for (const serializedNode of snapshot.nodes) {
            const node = this.deserializeNode(serializedNode);
            if (!node) {
                continue;
            }
            nodeMap.set(node.id, node);
        }
        this.trimDanglingRelationshipsFor(nodeMap);
        this.populateIncomingRelationships(nodeMap);
        const restoredSymbolCache = (0, symbolIndexer_1.deserializeIndexedSymbolMap)(snapshot.symbolCache);
        for (const node of nodeMap.values()) {
            if (!restoredSymbolCache.has(node.id)) {
                restoredSymbolCache.set(node.id, this.toIndexedSymbolFromNode(node));
            }
        }
        for (const symbolId of [...restoredSymbolCache.keys()]) {
            if (!nodeMap.has(symbolId)) {
                restoredSymbolCache.delete(symbolId);
            }
        }
        const builtAt = snapshot.builtAtIso ? new Date(snapshot.builtAtIso) : undefined;
        const isBuiltAtValid = builtAt && !Number.isNaN(builtAt.getTime());
        this.cachedGraph = {
            nodes: nodeMap,
            fileIndex: this.createFileIndex(nodeMap),
            builtAt: isBuiltAtValid ? builtAt : undefined,
        };
        this.symbolCache = restoredSymbolCache;
        this.fileModifiedTimes = this.deserializeFileModifiedTimes(snapshot.fileModifiedTimes);
        this.initialIndexCompleted = true;
        this.dirty = false;
        const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
        this.logger.info(`Hydrated workspace graph from cache with ${nodeMap.size} nodes and ${edgeCount} edges.`);
        return true;
    }
    async flushPersistence() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        await this.enqueuePersistence();
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
        const modifiedAt = await this.getFileModifiedTime(uri);
        this.removeFileSymbols(filePath);
        const symbols = await this.indexer.indexDocumentSymbols(uri);
        for (const symbol of symbols) {
            this.symbolCache.set(symbol.id, symbol);
            this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
        }
        await this.populateNodeRelationshipsForSymbols([...this.symbolCache.values()]);
        this.trimDanglingRelationships();
        this.rebuildFileIndex();
        this.populateIncomingRelationships(this.cachedGraph.nodes);
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            builtAt: new Date(),
        };
        if (modifiedAt !== undefined) {
            this.fileModifiedTimes.set(filePath, modifiedAt);
        }
        this.dirty = false;
        this.schedulePersistence();
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
        this.fileModifiedTimes.delete(filePath);
        this.trimDanglingRelationships();
        this.rebuildFileIndex();
        this.populateIncomingRelationships(this.cachedGraph.nodes);
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            builtAt: new Date(),
        };
        this.dirty = false;
        this.schedulePersistence();
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
            await this.populateNodeRelationshipsForSymbols([...indexedSymbols.values()], nodeMap);
            this.populateIncomingRelationships(nodeMap);
            const fileIndex = this.createFileIndex(nodeMap);
            const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
            this.cachedGraph = {
                nodes: nodeMap,
                fileIndex,
                builtAt: new Date(),
            };
            await this.refreshTrackedFileModifiedTimes(indexResult.scannedFiles);
            this.initialIndexCompleted = true;
            this.dirty = false;
            this.logIndexingSummary(indexResult);
            this.logger.info(`Workspace graph built with ${nodeMap.size} nodes and ${edgeCount} edges.`);
            this.schedulePersistence();
            return this.cachedGraph;
        }
        catch (error) {
            this.logger.error('Workspace graph build failed.', error);
            this.cachedGraph = {
                nodes: new Map(),
                fileIndex: new Map(),
                builtAt: new Date(),
            };
            this.symbolCache = new Map();
            this.fileModifiedTimes = new Map();
            this.initialIndexCompleted = true;
            this.dirty = false;
            this.schedulePersistence();
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
                nodeType: this.resolveNodeType(symbol.symbolKind),
                filePath: symbol.filePath,
                uriString: symbol.uri.toString(),
                lineNumber: symbol.lineNumber,
                rangeStartLine: symbol.range.start.line + 1,
                rangeStartCharacter: symbol.range.start.character,
                rangeEndLine: symbol.range.end.line + 1,
                rangeEndCharacter: symbol.range.end.character,
                outgoingCalls: [],
                implementations: [],
                references: this.emptyReferenceBuckets(),
                incomingCalls: [],
                incomingImplementations: [],
                incomingReferences: this.emptyReferenceBuckets(),
            });
            this.logGraphNodeCreation(symbol);
        }
        return nodeMap;
    }
    toGraphNode(symbol) {
        return {
            id: symbol.id,
            symbolName: symbol.symbolName,
            symbolKind: symbol.symbolKind,
            nodeType: this.resolveNodeType(symbol.symbolKind),
            filePath: symbol.filePath,
            uriString: symbol.uri.toString(),
            lineNumber: symbol.lineNumber,
            rangeStartLine: symbol.range.start.line + 1,
            rangeStartCharacter: symbol.range.start.character,
            rangeEndLine: symbol.range.end.line + 1,
            rangeEndCharacter: symbol.range.end.character,
            outgoingCalls: [],
            implementations: [],
            references: this.emptyReferenceBuckets(),
            incomingCalls: [],
            incomingImplementations: [],
            incomingReferences: this.emptyReferenceBuckets(),
        };
    }
    async populateNodeRelationshipsForSymbols(symbols, targetNodes = this.cachedGraph.nodes) {
        for (const node of targetNodes.values()) {
            node.outgoingCalls = [];
            node.implementations = [];
            node.references = this.emptyReferenceBuckets();
        }
        let processed = 0;
        for (const symbol of symbols) {
            const node = targetNodes.get(symbol.id);
            if (!node) {
                continue;
            }
            if (this.isCallableSymbol(symbol.symbolKind)) {
                const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
                node.outgoingCalls = outgoing.filter((targetId) => targetNodes.has(targetId) && targetId !== symbol.id);
            }
            const implementations = await this.indexer.resolveImplementations(symbol, this.symbolCache);
            node.implementations = implementations.filter((targetId) => targetNodes.has(targetId) && targetId !== symbol.id);
            if (this.isVariableLikeSymbol(symbol.symbolKind)) {
                const variableReferences = await this.indexer.resolveVariableReferences(symbol, this.symbolCache);
                const filteredReferences = this.filterReferenceBuckets(variableReferences, targetNodes, symbol.id);
                for (const sourceNodeId of filteredReferences.reads) {
                    const sourceNode = targetNodes.get(sourceNodeId);
                    if (!sourceNode || sourceNode.references.reads.includes(symbol.id)) {
                        continue;
                    }
                    sourceNode.references.reads.push(symbol.id);
                }
                for (const sourceNodeId of filteredReferences.writes) {
                    const sourceNode = targetNodes.get(sourceNodeId);
                    if (!sourceNode || sourceNode.references.writes.includes(symbol.id)) {
                        continue;
                    }
                    sourceNode.references.writes.push(symbol.id);
                }
            }
            processed += 1;
            if (processed % 25 === 0) {
                await this.yieldToEventLoop();
            }
        }
    }
    populateIncomingRelationships(nodeMap) {
        for (const node of nodeMap.values()) {
            node.incomingCalls = [];
            node.incomingImplementations = [];
            node.incomingReferences = this.emptyReferenceBuckets();
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
            for (const implementationId of node.implementations) {
                const target = nodeMap.get(implementationId);
                if (!target) {
                    continue;
                }
                if (!target.incomingImplementations.includes(node.id)) {
                    target.incomingImplementations.push(node.id);
                }
            }
            for (const readId of node.references.reads) {
                const target = nodeMap.get(readId);
                if (!target) {
                    continue;
                }
                if (!target.incomingReferences.reads.includes(node.id)) {
                    target.incomingReferences.reads.push(node.id);
                }
            }
            for (const writeId of node.references.writes) {
                const target = nodeMap.get(writeId);
                if (!target) {
                    continue;
                }
                if (!target.incomingReferences.writes.includes(node.id)) {
                    target.incomingReferences.writes.push(node.id);
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
    trimDanglingRelationships() {
        for (const node of this.cachedGraph.nodes.values()) {
            node.outgoingCalls = node.outgoingCalls.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
            node.implementations = node.implementations.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
            node.references.reads = node.references.reads.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
            node.references.writes = node.references.writes.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
        }
    }
    rebuildFileIndex() {
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.createFileIndex(this.cachedGraph.nodes),
            builtAt: this.cachedGraph.builtAt,
        };
    }
    schedulePersistence() {
        if (!this.cacheFileUri || !this.initialIndexCompleted) {
            return;
        }
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.enqueuePersistence();
        }, PERSIST_DEBOUNCE_MS);
    }
    async enqueuePersistence() {
        if (!this.cacheFileUri || !this.initialIndexCompleted) {
            return;
        }
        this.persistQueue = this.persistQueue
            .then(async () => {
            await this.persistSnapshot();
        })
            .catch((error) => {
            this.logger.warn(`Unable to persist VSContext graph cache. ${String(error)}`);
        });
        await this.persistQueue;
    }
    async persistSnapshot() {
        if (!this.cacheFileUri) {
            return;
        }
        const directoryUri = vscode.Uri.file(path.dirname(this.cacheFileUri.fsPath));
        await vscode.workspace.fs.createDirectory(directoryUri);
        const snapshot = {
            version: GRAPH_CACHE_VERSION,
            knowledgeModelVersion: knowledgeModel_1.KNOWLEDGE_MODEL_VERSION,
            workspaceFolderUri: (0, workspaceScanner_1.getPrimaryWorkspaceFolder)()?.uri.toString(),
            savedAtIso: new Date().toISOString(),
            builtAtIso: this.cachedGraph.builtAt?.toISOString(),
            nodes: [...this.cachedGraph.nodes.values()].map((node) => this.serializeNode(node)),
            symbolCache: (0, symbolIndexer_1.serializeIndexedSymbolMap)(this.symbolCache),
            fileModifiedTimes: Object.fromEntries(this.fileModifiedTimes.entries()),
        };
        const payload = Buffer.from(JSON.stringify(snapshot), 'utf8');
        await vscode.workspace.fs.writeFile(this.cacheFileUri, payload);
    }
    parseSnapshot(value) {
        if (!value || typeof value !== 'object') {
            return undefined;
        }
        const candidate = value;
        if (candidate.version !== GRAPH_CACHE_VERSION) {
            return undefined;
        }
        if (candidate.knowledgeModelVersion !== knowledgeModel_1.KNOWLEDGE_MODEL_VERSION) {
            return undefined;
        }
        if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.symbolCache)) {
            return undefined;
        }
        if (!candidate.fileModifiedTimes || typeof candidate.fileModifiedTimes !== 'object') {
            return undefined;
        }
        const safeWorkspaceUri = typeof candidate.workspaceFolderUri === 'string' ? candidate.workspaceFolderUri : undefined;
        const safeSavedAtIso = typeof candidate.savedAtIso === 'string' ? candidate.savedAtIso : '';
        if (!safeSavedAtIso) {
            return undefined;
        }
        const safeBuiltAtIso = typeof candidate.builtAtIso === 'string' ? candidate.builtAtIso : undefined;
        return {
            version: candidate.version,
            knowledgeModelVersion: candidate.knowledgeModelVersion,
            workspaceFolderUri: safeWorkspaceUri,
            savedAtIso: safeSavedAtIso,
            builtAtIso: safeBuiltAtIso,
            nodes: candidate.nodes,
            symbolCache: candidate.symbolCache,
            fileModifiedTimes: candidate.fileModifiedTimes,
        };
    }
    serializeNode(node) {
        return {
            id: node.id,
            symbolName: node.symbolName,
            symbolKind: node.symbolKind,
            filePath: node.filePath,
            uriString: node.uriString,
            lineNumber: node.lineNumber,
            rangeStartLine: node.rangeStartLine,
            rangeStartCharacter: node.rangeStartCharacter,
            rangeEndLine: node.rangeEndLine,
            rangeEndCharacter: node.rangeEndCharacter,
            outgoingCalls: [...node.outgoingCalls],
            implementations: [...node.implementations],
            referenceReads: [...node.references.reads],
            referenceWrites: [...node.references.writes],
        };
    }
    deserializeNode(node) {
        if (!node || typeof node !== 'object') {
            return undefined;
        }
        if (typeof node.id !== 'string'
            || typeof node.symbolName !== 'string'
            || typeof node.symbolKind !== 'number'
            || typeof node.filePath !== 'string'
            || typeof node.uriString !== 'string'
            || typeof node.lineNumber !== 'number'
            || typeof node.rangeStartLine !== 'number'
            || typeof node.rangeStartCharacter !== 'number'
            || typeof node.rangeEndLine !== 'number'
            || typeof node.rangeEndCharacter !== 'number'
            || !Array.isArray(node.outgoingCalls)
            || !Array.isArray(node.implementations)
            || !Array.isArray(node.referenceReads)
            || !Array.isArray(node.referenceWrites)) {
            return undefined;
        }
        const outgoingCalls = node.outgoingCalls.filter((entry) => typeof entry === 'string');
        const implementations = node.implementations.filter((entry) => typeof entry === 'string');
        const referenceReads = node.referenceReads.filter((entry) => typeof entry === 'string');
        const referenceWrites = node.referenceWrites.filter((entry) => typeof entry === 'string');
        return {
            id: node.id,
            symbolName: node.symbolName,
            symbolKind: node.symbolKind,
            nodeType: this.resolveNodeType(node.symbolKind),
            filePath: node.filePath,
            uriString: node.uriString,
            lineNumber: node.lineNumber,
            rangeStartLine: node.rangeStartLine,
            rangeStartCharacter: node.rangeStartCharacter,
            rangeEndLine: node.rangeEndLine,
            rangeEndCharacter: node.rangeEndCharacter,
            outgoingCalls,
            implementations,
            references: {
                reads: referenceReads,
                writes: referenceWrites,
            },
            incomingCalls: [],
            incomingImplementations: [],
            incomingReferences: this.emptyReferenceBuckets(),
        };
    }
    deserializeFileModifiedTimes(value) {
        const map = new Map();
        for (const [filePath, modifiedAt] of Object.entries(value)) {
            if (typeof filePath !== 'string' || typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt)) {
                continue;
            }
            map.set(filePath, modifiedAt);
        }
        return map;
    }
    toIndexedSymbolFromNode(node) {
        const uri = vscode.Uri.parse(node.uriString);
        const range = new vscode.Range(Math.max(0, node.rangeStartLine - 1), Math.max(0, node.rangeStartCharacter), Math.max(0, node.rangeEndLine - 1), Math.max(0, node.rangeEndCharacter));
        return {
            id: node.id,
            symbolName: node.symbolName,
            symbolKind: node.symbolKind,
            uri,
            filePath: node.filePath,
            lineNumber: node.lineNumber,
            range,
        };
    }
    trimDanglingRelationshipsFor(nodeMap) {
        for (const node of nodeMap.values()) {
            node.outgoingCalls = node.outgoingCalls.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
            node.implementations = node.implementations.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
            node.references.reads = node.references.reads.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
            node.references.writes = node.references.writes.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
        }
    }
    async refreshTrackedFileModifiedTimes(uris) {
        const next = new Map();
        let processed = 0;
        for (const uri of uris) {
            if (uri.scheme !== 'file') {
                continue;
            }
            const modifiedAt = await this.getFileModifiedTime(uri);
            if (modifiedAt !== undefined) {
                next.set((0, workspaceScanner_1.toWorkspaceRelativePath)(uri), modifiedAt);
            }
            processed += 1;
            if (processed % 50 === 0) {
                await this.yieldToEventLoop();
            }
        }
        this.fileModifiedTimes = next;
    }
    async getFileModifiedTime(uri) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            return stat.mtime;
        }
        catch {
            return undefined;
        }
    }
    isFileNotFoundError(error) {
        if (error instanceof vscode.FileSystemError) {
            return /not found|enoent/i.test(error.message);
        }
        return false;
    }
    logIndexingSummary(indexResult) {
        this.logger.info(`[VSContext] Indexed ${indexResult.scannedFileCount} files.`);
        this.logger.info(`[VSContext] Indexed ${indexResult.indexedSymbolCount} symbols.`);
        this.logger.info(`[VSContext] Skipped dependency directories: ${indexResult.skippedByExclusions} files.`);
    }
    resolveNodeType(kind) {
        if (kind === vscode.SymbolKind.Class) {
            return 'class';
        }
        if (kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Constructor) {
            return 'method';
        }
        if (kind === vscode.SymbolKind.Variable
            || kind === vscode.SymbolKind.Constant
            || kind === vscode.SymbolKind.Field
            || kind === vscode.SymbolKind.Property) {
            return 'variable';
        }
        return 'function';
    }
    isCallableSymbol(kind) {
        return kind === vscode.SymbolKind.Function || kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Constructor;
    }
    isVariableLikeSymbol(kind) {
        return (kind === vscode.SymbolKind.Variable
            || kind === vscode.SymbolKind.Constant
            || kind === vscode.SymbolKind.Field
            || kind === vscode.SymbolKind.Property);
    }
    filterReferenceBuckets(references, targetNodes, symbolId) {
        return {
            reads: references.reads.filter((sourceId) => targetNodes.has(sourceId) && sourceId !== symbolId),
            writes: references.writes.filter((sourceId) => targetNodes.has(sourceId) && sourceId !== symbolId),
        };
    }
    emptyReferenceBuckets() {
        return {
            reads: [],
            writes: [],
        };
    }
    relationshipCountForNode(node) {
        return node.outgoingCalls.length
            + node.implementations.length
            + node.references.reads.length
            + node.references.writes.length;
    }
    logGraphNodeCreation(symbol) {
        if (!this.isSymbolDebugEnabled()) {
            return;
        }
        const kindLabel = vscode.SymbolKind[symbol.symbolKind] ?? symbol.symbolKind.toString();
        this.logger.info(`[VSContext][debug] Creating graph node: ${symbol.symbolName} (${kindLabel})`);
    }
    isSymbolDebugEnabled() {
        return vscode.workspace.getConfiguration('vscontext').get('debugSymbolDetection', false);
    }
    async yieldToEventLoop() {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}
exports.WorkspaceGraphBuilder = WorkspaceGraphBuilder;
//# sourceMappingURL=graphBuilder.js.map