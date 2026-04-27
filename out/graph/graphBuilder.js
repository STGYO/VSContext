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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const symbolIndexer_1 = require("./symbolIndexer");
const fileRoleClassifier_1 = require("../utils/fileRoleClassifier");
const workspaceScanner_1 = require("../utils/workspaceScanner");
const knowledgeModel_1 = require("./knowledgeModel");
const indexTelemetry_1 = require("../indexing/indexTelemetry");
const GRAPH_CACHE_VERSION = indexTelemetry_1.CacheVersionManager.GRAPH_CACHE_VERSION;
const PERSIST_DEBOUNCE_MS = 800;
class WorkspaceGraphBuilder {
    indexer;
    logger;
    cacheFileUri;
    cachedGraph = {
        nodes: new Map(),
        fileIndex: new Map(),
        fileRelationships: [],
        builtAt: undefined,
        fileRoleSummary: undefined,
    };
    dirty = true;
    initialIndexCompleted = false;
    buildPromise;
    symbolCache = new Map();
    fileModifiedTimes = new Map();
    fileRelationshipIndex = new Map();
    supplementaryFileRelationshipIndex = new Map();
    persistTimer;
    persistQueue = Promise.resolve();
    lastIndexResult;
    /** SQLite database for persistent graph storage (Phase 9A). */
    db;
    dbUri;
    constructor(indexer, logger, cacheFileUri) {
        this.indexer = indexer;
        this.logger = logger;
        this.cacheFileUri = cacheFileUri;
    }
    /**
     * Open (or create) the SQLite graph database at `dbUri`.
     * Must be called before `hydrateFromCache()` / `buildWorkspaceGraph()` for
     * SQLite persistence to be active.  Failures are non-fatal – the builder
     * will fall back to the legacy JSON cache.
     */
    initializeDatabase(dbUri) {
        this.dbUri = dbUri;
        try {
            const { GraphDatabase: GraphDatabaseImpl } = require("./graphDatabase");
            const dir = path.dirname(dbUri.fsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.db = GraphDatabaseImpl.open(dbUri.fsPath);
        }
        catch (error) {
            this.logger.warn(`[VSContext] Graph database is unavailable; continuing without SQLite persistence. ${error}`);
            this.db = undefined;
        }
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
    getLastIndexResult() {
        return this.lastIndexResult;
    }
    async hydrateFromCache() {
        // ---- DB-first path (Phase 9A) -----------------------------------------
        if (this.db) {
            const dbSnapshot = this.db.snapshot();
            if (dbSnapshot.nodes.size > 0) {
                // Reconstruct in-memory graph from the SQLite snapshot.
                const nodeMap = new Map();
                for (const [id, row] of dbSnapshot.nodes) {
                    nodeMap.set(id, {
                        id: row.id,
                        symbolName: row.symbolName,
                        symbolKind: row.symbolKind,
                        nodeType: row.nodeType,
                        filePath: row.filePath,
                        uriString: row.uriString,
                        lineNumber: row.lineNumber,
                        rangeStartLine: row.rangeStartLine,
                        rangeStartCharacter: row.rangeStartCharacter,
                        rangeEndLine: row.rangeEndLine,
                        rangeEndCharacter: row.rangeEndCharacter,
                        outgoingCalls: [],
                        implementations: [],
                        references: this.emptyReferenceBuckets(),
                        incomingCalls: [],
                        incomingImplementations: [],
                        incomingReferences: this.emptyReferenceBuckets(),
                    });
                }
                // Populate outgoing edge arrays on each node.
                for (const edge of dbSnapshot.allEdges) {
                    const sourceNode = nodeMap.get(edge.sourceId);
                    if (!sourceNode) {
                        continue;
                    }
                    switch (edge.type) {
                        case "calls":
                            this.addUniqueValue(sourceNode.outgoingCalls, edge.targetId);
                            break;
                        case "implements":
                            this.addUniqueValue(sourceNode.implementations, edge.targetId);
                            break;
                        case "reads":
                            this.addUniqueValue(sourceNode.references.reads, edge.targetId);
                            break;
                        case "writes":
                            this.addUniqueValue(sourceNode.references.writes, edge.targetId);
                            break;
                        default:
                            break;
                    }
                }
                this.trimDanglingRelationshipsFor(nodeMap);
                this.populateIncomingRelationships(nodeMap);
                // Restore symbol cache.
                const restoredSymbolCache = new Map();
                for (const [nodeId, jsonStr] of dbSnapshot.symbolCacheJson) {
                    try {
                        const sym = (0, symbolIndexer_1.deserializeIndexedSymbol)(JSON.parse(jsonStr));
                        if (sym) {
                            restoredSymbolCache.set(nodeId, sym);
                        }
                    }
                    catch {
                        // Skip corrupted cache entries.
                    }
                }
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
                // Restore supplementaryFileRelationshipIndex so incremental updates
                // do not accidentally wipe unrelated file relationships.
                const supplementaryIndex = new Map();
                for (const rel of dbSnapshot.fileRelationships) {
                    const entry = {
                        sourceFilePath: rel.sourceFilePath,
                        targetFilePath: rel.targetFilePath,
                        sourceUriString: rel.sourceUriString,
                        targetUriString: rel.targetUriString,
                        relationship: rel.relationship,
                    };
                    const existing = supplementaryIndex.get(rel.sourceFilePath);
                    if (existing) {
                        existing.push(entry);
                    }
                    else {
                        supplementaryIndex.set(rel.sourceFilePath, [entry]);
                    }
                }
                this.supplementaryFileRelationshipIndex = supplementaryIndex;
                // Restore metadata.
                const builtAt = dbSnapshot.builtAtIso
                    ? new Date(dbSnapshot.builtAtIso)
                    : undefined;
                const isBuiltAtValid = builtAt && !Number.isNaN(builtAt.getTime());
                const fileRoleSummary = dbSnapshot.fileRoleSummaryJson
                    ? this.parseFileRoleSummary(JSON.parse(dbSnapshot.fileRoleSummaryJson))
                    : undefined;
                this.cachedGraph = {
                    nodes: nodeMap,
                    fileIndex: this.createFileIndex(nodeMap),
                    fileRelationships: this.flattenSupplementaryFileRelationships(),
                    builtAt: isBuiltAtValid ? builtAt : undefined,
                    fileRoleSummary,
                };
                this.symbolCache = restoredSymbolCache;
                this.fileModifiedTimes = dbSnapshot.fileModifiedTimes;
                this.rebuildFileRelationshipIndex(nodeMap);
                this.initialIndexCompleted = true;
                this.dirty = false;
                const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
                this.logger.info(`Hydrated workspace graph from SQLite with ${nodeMap.size} nodes and ${edgeCount} edges.`);
                return true;
            }
            // DB is open but empty – fall through to JSON migration path below.
        }
        // ---- JSON path (legacy + one-time migration) --------------------------
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
            parsed = JSON.parse(Buffer.from(rawContent).toString("utf8"));
        }
        catch {
            this.logger.warn("VSContext graph cache is not valid JSON. Falling back to full rebuild.");
            return false;
        }
        const snapshot = this.parseSnapshot(parsed);
        if (!snapshot) {
            this.logger.warn("VSContext graph cache schema is invalid. Falling back to full rebuild.");
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
        const builtAt = snapshot.builtAtIso
            ? new Date(snapshot.builtAtIso)
            : undefined;
        const isBuiltAtValid = builtAt && !Number.isNaN(builtAt.getTime());
        this.cachedGraph = {
            nodes: nodeMap,
            fileIndex: this.createFileIndex(nodeMap),
            fileRelationships: this.deserializeWorkspaceFileRelationships(snapshot.fileRelationships),
            builtAt: isBuiltAtValid ? builtAt : undefined,
            fileRoleSummary: snapshot.fileRoleSummary,
        };
        this.symbolCache = restoredSymbolCache;
        this.fileModifiedTimes = this.deserializeFileModifiedTimes(snapshot.fileModifiedTimes);
        this.rebuildFileRelationshipIndex(nodeMap);
        this.initialIndexCompleted = true;
        this.dirty = false;
        const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
        this.logger.info(`Hydrated workspace graph from JSON cache with ${nodeMap.size} nodes and ${edgeCount} edges.`);
        // If a DB is open, migrate the JSON data into SQLite and delete the file.
        if (this.db) {
            this.logger.info("[VSContext] Migrating JSON graph cache to SQLite database.");
            this.persistToDatabase();
            try {
                await vscode.workspace.fs.delete(this.cacheFileUri);
                this.logger.info("[VSContext] Deleted legacy JSON graph cache.");
            }
            catch {
                // Non-fatal – old JSON file will simply be ignored on next start-up.
            }
        }
        return true;
    }
    async flushPersistence() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        await this.enqueuePersistence();
    }
    async dispose() {
        if (this.buildPromise) {
            try {
                await this.buildPromise;
            }
            catch {
                // Ignore disposal-time build failures.
            }
        }
        if (this.db && this.initialIndexCompleted) {
            this.persistToDatabase();
        }
        await this.flushPersistence();
        if (this.db) {
            try {
                this.db.close();
            }
            catch (error) {
                this.logger.warn(`[VSContext] Failed to close graph database cleanly: ${String(error)}`);
            }
            this.db = undefined;
        }
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
        if (uri.scheme !== "file") {
            return;
        }
        if (!this.initialIndexCompleted) {
            return;
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        const modifiedAt = await this.getFileModifiedTime(uri);
        const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
        for (const nodeId of existingIds) {
            const node = this.cachedGraph.nodes.get(nodeId);
            if (!node) {
                continue;
            }
            this.removeIncomingRelationshipsForNode(node);
        }
        this.clearRelationshipsForFile(filePath);
        this.removeFileSymbols(filePath);
        this.supplementaryFileRelationshipIndex.delete(filePath);
        const symbols = await this.indexer.indexDocumentSymbols(uri);
        for (const symbol of symbols) {
            this.symbolCache.set(symbol.id, symbol);
            this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
        }
        await this.populateNodeRelationshipsForSymbols(symbols);
        const role = (0, fileRoleClassifier_1.classifyWorkspaceFile)(uri);
        const relationships = await this.extractSupplementaryFileRelationships(uri, role, this.collectKnownFilePaths(), this.collectKnownFileUriLookup());
        if (relationships.length > 0) {
            this.supplementaryFileRelationshipIndex.set(filePath, relationships);
        }
        this.rebuildFileIndex();
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            fileRelationships: this.flattenSupplementaryFileRelationships(),
            builtAt: new Date(),
            fileRoleSummary: this.cachedGraph.fileRoleSummary,
        };
        if (modifiedAt !== undefined) {
            this.fileModifiedTimes.set(filePath, modifiedAt);
        }
        this.dirty = false;
        // ---- SQLite persistence (Phase 9A) ------------------------------------
        if (this.db) {
            const db = this.db;
            db.transaction(() => {
                // Delete edges and symbol cache BEFORE nodes so the subqueries resolve.
                db.deleteEdgesForFile(filePath);
                db.deleteSymbolCacheForFile(filePath);
                db.deleteNodesByFile(filePath);
                db.deleteFileRelationshipsForFile(filePath);
                // Upsert new nodes.
                for (const symbol of symbols) {
                    db.upsertNode({
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
                    });
                }
                // Upsert outgoing edges from the updated in-memory nodes.
                for (const nodeId of this.cachedGraph.fileIndex.get(filePath) ?? []) {
                    const node = this.cachedGraph.nodes.get(nodeId);
                    if (!node) {
                        continue;
                    }
                    for (const targetId of node.outgoingCalls) {
                        db.upsertEdge(nodeId, targetId, "calls");
                    }
                    for (const targetId of node.implementations) {
                        db.upsertEdge(nodeId, targetId, "implements");
                    }
                    for (const targetId of node.references.reads) {
                        db.upsertEdge(nodeId, targetId, "reads");
                    }
                    for (const targetId of node.references.writes) {
                        db.upsertEdge(nodeId, targetId, "writes");
                    }
                }
                // Upsert symbol cache for new symbols.
                for (const symbol of symbols) {
                    const cached = this.symbolCache.get(symbol.id);
                    if (cached) {
                        db.upsertSymbolCache(symbol.id, JSON.stringify((0, symbolIndexer_1.serializeIndexedSymbol)(cached)));
                    }
                }
                // File modified time.
                if (modifiedAt !== undefined) {
                    db.setFileModifiedTime(filePath, modifiedAt);
                }
                // File relationships – write only the ones for this source file.
                for (const rel of this.flattenSupplementaryFileRelationships()) {
                    if (rel.sourceFilePath === filePath) {
                        db.upsertFileRelationship(rel.sourceFilePath, rel.targetFilePath, rel.sourceUriString, rel.targetUriString, rel.relationship);
                    }
                }
            });
        }
        else {
            // No DB – fall back to legacy JSON persistence.
            this.schedulePersistence();
        }
    }
    async removeDocument(uri) {
        if (uri.scheme !== "file") {
            return;
        }
        if (!this.initialIndexCompleted) {
            return;
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        this.clearRelationshipsForFile(filePath);
        this.supplementaryFileRelationshipIndex.delete(filePath);
        const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
        for (const nodeId of existingIds) {
            const node = this.cachedGraph.nodes.get(nodeId);
            if (!node) {
                continue;
            }
            this.removeIncomingRelationshipsForNode(node);
        }
        this.removeFileSymbols(filePath);
        this.fileModifiedTimes.delete(filePath);
        this.rebuildFileIndex();
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            fileRelationships: this.flattenSupplementaryFileRelationships(),
            builtAt: new Date(),
            fileRoleSummary: this.cachedGraph.fileRoleSummary,
        };
        this.dirty = false;
        // ---- SQLite persistence (Phase 9A) ------------------------------------
        if (this.db) {
            const db = this.db;
            db.transaction(() => {
                // Delete edges and symbol cache BEFORE nodes so subqueries resolve.
                db.deleteEdgesForFile(filePath);
                db.deleteSymbolCacheForFile(filePath);
                db.deleteNodesByFile(filePath);
                db.deleteFileRelationshipsForFile(filePath);
                db.deleteFileModifiedTime(filePath);
            });
        }
        else {
            // No DB – fall back to legacy JSON persistence.
            this.schedulePersistence();
        }
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
        this.logger.info("Building workspace graph.");
        this.lastIndexResult = undefined;
        try {
            this.fileRelationshipIndex = new Map();
            this.supplementaryFileRelationshipIndex = new Map();
            const indexResult = await this.indexer.indexWorkspaceSymbols();
            this.lastIndexResult = indexResult;
            const indexedSymbols = indexResult.indexed;
            this.symbolCache = new Map(indexedSymbols);
            const nodeMap = this.createNodeMap(indexedSymbols);
            await this.populateNodeRelationshipsForSymbols([...indexedSymbols.values()], nodeMap);
            await this.rebuildSupplementaryFileRelationships(indexResult.filesByRole);
            const fileIndex = this.createFileIndex(nodeMap);
            const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
            this.cachedGraph = {
                nodes: nodeMap,
                fileIndex,
                fileRelationships: this.flattenSupplementaryFileRelationships(),
                builtAt: new Date(),
                fileRoleSummary: indexResult.fileRoleSummary,
            };
            await this.refreshTrackedFileModifiedTimes(indexResult.scannedFiles);
            this.initialIndexCompleted = true;
            this.dirty = false;
            this.logIndexingSummary(indexResult);
            this.logger.info(`Workspace graph built with ${nodeMap.size} nodes and ${edgeCount} edges.`);
            if (this.db) {
                this.persistToDatabase();
            }
            else {
                this.schedulePersistence();
            }
            return this.cachedGraph;
        }
        catch (error) {
            this.logger.error("Workspace graph build failed.", error);
            this.lastIndexResult = undefined;
            this.cachedGraph = {
                nodes: new Map(),
                fileIndex: new Map(),
                fileRelationships: [],
                builtAt: new Date(),
                fileRoleSummary: undefined,
            };
            this.symbolCache = new Map();
            this.fileModifiedTimes = new Map();
            this.initialIndexCompleted = true;
            this.dirty = false;
            if (this.db) {
                this.persistToDatabase();
            }
            else {
                this.schedulePersistence();
            }
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
        const recordsByFile = new Map();
        let processed = 0;
        for (const symbol of symbols) {
            const node = targetNodes.get(symbol.id);
            if (!node) {
                continue;
            }
            const filePath = symbol.filePath;
            const fileRecords = recordsByFile.get(filePath) ?? [];
            if (this.isCallableSymbol(symbol.symbolKind)) {
                const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
                for (const targetId of outgoing.filter((targetNodeId) => targetNodes.has(targetNodeId) && targetNodeId !== symbol.id)) {
                    const targetNode = targetNodes.get(targetId);
                    if (!targetNode) {
                        continue;
                    }
                    this.linkRelationship(node, targetNode, "calls", fileRecords);
                }
            }
            const implementations = await this.indexer.resolveImplementations(symbol, this.symbolCache);
            for (const targetId of implementations.filter((targetNodeId) => targetNodes.has(targetNodeId) && targetNodeId !== symbol.id)) {
                const targetNode = targetNodes.get(targetId);
                if (!targetNode) {
                    continue;
                }
                this.linkRelationship(node, targetNode, "implements", fileRecords);
            }
            if (this.isVariableLikeSymbol(symbol.symbolKind)) {
                const variableReferences = await this.indexer.resolveVariableReferences(symbol, this.symbolCache);
                const filteredReferences = this.filterReferenceBuckets(variableReferences, targetNodes, symbol.id);
                for (const sourceNodeId of filteredReferences.reads) {
                    const sourceNode = targetNodes.get(sourceNodeId);
                    if (!sourceNode) {
                        continue;
                    }
                    this.linkRelationship(sourceNode, node, "reads", fileRecords);
                }
                for (const sourceNodeId of filteredReferences.writes) {
                    const sourceNode = targetNodes.get(sourceNodeId);
                    if (!sourceNode) {
                        continue;
                    }
                    this.linkRelationship(sourceNode, node, "writes", fileRecords);
                }
            }
            recordsByFile.set(filePath, fileRecords);
            processed += 1;
            if (processed % 25 === 0) {
                await this.yieldToEventLoop();
            }
        }
        for (const [filePath, records] of recordsByFile) {
            this.fileRelationshipIndex.set(filePath, records);
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
            fileRelationships: this.cachedGraph.fileRelationships,
            builtAt: this.cachedGraph.builtAt,
            fileRoleSummary: this.cachedGraph.fileRoleSummary,
        };
    }
    rebuildFileRelationshipIndex(nodeMap = this.cachedGraph.nodes) {
        const index = new Map();
        for (const node of nodeMap.values()) {
            for (const targetId of node.outgoingCalls) {
                this.appendFileRelationshipRecord(index, node.filePath, {
                    sourceId: node.id,
                    targetId,
                    edgeType: "calls",
                    sourceFilePath: node.filePath,
                });
            }
            for (const targetId of node.implementations) {
                this.appendFileRelationshipRecord(index, node.filePath, {
                    sourceId: node.id,
                    targetId,
                    edgeType: "implements",
                    sourceFilePath: node.filePath,
                });
            }
            for (const targetId of node.references.reads) {
                this.appendFileRelationshipRecord(index, node.filePath, {
                    sourceId: node.id,
                    targetId,
                    edgeType: "reads",
                    sourceFilePath: node.filePath,
                });
            }
            for (const targetId of node.references.writes) {
                this.appendFileRelationshipRecord(index, node.filePath, {
                    sourceId: node.id,
                    targetId,
                    edgeType: "writes",
                    sourceFilePath: node.filePath,
                });
            }
        }
        this.fileRelationshipIndex = index;
    }
    linkRelationship(sourceNode, targetNode, edgeType, records) {
        if (sourceNode.id === targetNode.id) {
            return;
        }
        switch (edgeType) {
            case "calls":
                this.addUniqueValue(sourceNode.outgoingCalls, targetNode.id);
                this.addUniqueValue(targetNode.incomingCalls, sourceNode.id);
                break;
            case "implements":
                this.addUniqueValue(sourceNode.implementations, targetNode.id);
                this.addUniqueValue(targetNode.incomingImplementations, sourceNode.id);
                break;
            case "reads":
                this.addUniqueValue(sourceNode.references.reads, targetNode.id);
                this.addUniqueValue(targetNode.incomingReferences.reads, sourceNode.id);
                break;
            case "writes":
                this.addUniqueValue(sourceNode.references.writes, targetNode.id);
                this.addUniqueValue(targetNode.incomingReferences.writes, sourceNode.id);
                break;
            default:
                break;
        }
        records.push({
            sourceId: sourceNode.id,
            targetId: targetNode.id,
            edgeType,
            sourceFilePath: sourceNode.filePath,
        });
    }
    clearRelationshipsForFile(filePath) {
        const records = this.fileRelationshipIndex.get(filePath) ?? [];
        for (const record of records) {
            this.removeRelationshipRecord(record);
        }
        this.fileRelationshipIndex.delete(filePath);
    }
    removeIncomingRelationshipsForNode(node) {
        for (const sourceId of [...node.incomingCalls]) {
            this.removeRelationshipByDetails(sourceId, node.id, "calls");
        }
        for (const sourceId of [...node.incomingImplementations]) {
            this.removeRelationshipByDetails(sourceId, node.id, "implements");
        }
        for (const sourceId of [...node.incomingReferences.reads]) {
            this.removeRelationshipByDetails(sourceId, node.id, "reads");
        }
        for (const sourceId of [...node.incomingReferences.writes]) {
            this.removeRelationshipByDetails(sourceId, node.id, "writes");
        }
    }
    removeRelationshipByDetails(sourceId, targetId, edgeType) {
        const sourceNode = this.cachedGraph.nodes.get(sourceId);
        const targetNode = this.cachedGraph.nodes.get(targetId);
        if (!sourceNode || !targetNode) {
            return;
        }
        this.removeRelationshipRecord({
            sourceId,
            targetId,
            edgeType,
            sourceFilePath: sourceNode.filePath,
        });
    }
    removeRelationshipRecord(record) {
        const sourceNode = this.cachedGraph.nodes.get(record.sourceId);
        const targetNode = this.cachedGraph.nodes.get(record.targetId);
        if (!sourceNode || !targetNode) {
            this.removeRelationshipRecordFromIndex(record);
            return;
        }
        switch (record.edgeType) {
            case "calls":
                this.removeValueFromArray(sourceNode.outgoingCalls, record.targetId);
                this.removeValueFromArray(targetNode.incomingCalls, record.sourceId);
                break;
            case "implements":
                this.removeValueFromArray(sourceNode.implementations, record.targetId);
                this.removeValueFromArray(targetNode.incomingImplementations, record.sourceId);
                break;
            case "reads":
                this.removeValueFromArray(sourceNode.references.reads, record.targetId);
                this.removeValueFromArray(targetNode.incomingReferences.reads, record.sourceId);
                break;
            case "writes":
                this.removeValueFromArray(sourceNode.references.writes, record.targetId);
                this.removeValueFromArray(targetNode.incomingReferences.writes, record.sourceId);
                break;
            default:
                break;
        }
        this.removeRelationshipRecordFromIndex(record);
    }
    removeRelationshipRecordFromIndex(record) {
        const records = this.fileRelationshipIndex.get(record.sourceFilePath);
        if (!records || records.length === 0) {
            return;
        }
        const filtered = records.filter((entry) => !this.sameRelationshipRecord(entry, record));
        if (filtered.length === 0) {
            this.fileRelationshipIndex.delete(record.sourceFilePath);
            return;
        }
        this.fileRelationshipIndex.set(record.sourceFilePath, filtered);
    }
    sameRelationshipRecord(left, right) {
        return (left.sourceId === right.sourceId &&
            left.targetId === right.targetId &&
            left.edgeType === right.edgeType);
    }
    addUniqueValue(target, value) {
        if (!target.includes(value)) {
            target.push(value);
        }
    }
    removeValueFromArray(target, value) {
        const index = target.indexOf(value);
        if (index >= 0) {
            target.splice(index, 1);
        }
    }
    appendFileRelationshipRecord(index, filePath, record) {
        const records = index.get(filePath) ?? [];
        if (!records.some((entry) => this.sameRelationshipRecord(entry, record))) {
            records.push(record);
        }
        index.set(filePath, records);
    }
    async rebuildSupplementaryFileRelationships(filesByRole) {
        const knownFilePaths = this.collectKnownFilePaths(filesByRole);
        const knownFileUris = this.collectKnownFileUriLookup(filesByRole);
        const next = new Map();
        for (const [role, uris] of Object.entries(filesByRole)) {
            for (const uri of uris) {
                const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
                const relationships = await this.extractSupplementaryFileRelationships(uri, role, knownFilePaths, knownFileUris);
                if (relationships.length > 0) {
                    next.set(filePath, relationships);
                }
            }
        }
        this.supplementaryFileRelationshipIndex = next;
        this.cachedGraph = {
            nodes: this.cachedGraph.nodes,
            fileIndex: this.cachedGraph.fileIndex,
            fileRelationships: this.flattenSupplementaryFileRelationships(),
            builtAt: this.cachedGraph.builtAt,
            fileRoleSummary: this.cachedGraph.fileRoleSummary,
        };
    }
    async extractSupplementaryFileRelationships(uri, role, knownFilePaths, knownFileUris) {
        const text = await this.readWorkspaceFileText(uri);
        if (!text) {
            return [];
        }
        const sourceFilePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        const knownFileLookup = this.createKnownFilePathLookup(knownFilePaths);
        const sourceUriString = uri.toString();
        const relationships = [];
        const seen = new Set();
        const addRelationship = (targetFilePath, relationship) => {
            if (!targetFilePath || targetFilePath === sourceFilePath) {
                return;
            }
            const key = `${sourceFilePath}->${targetFilePath}:${relationship}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            relationships.push({
                sourceFilePath,
                targetFilePath,
                sourceUriString,
                targetUriString: knownFileUris.get(targetFilePath) ?? "",
                relationship,
            });
        };
        for (const specifier of this.extractImportSpecifiers(text)) {
            const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
            if (targetFilePath) {
                addRelationship(targetFilePath, "imports");
            }
        }
        if (role === "test") {
            for (const targetFilePath of this.inferTestCoverageTargets(sourceFilePath, knownFileLookup)) {
                addRelationship(targetFilePath, "covers");
            }
        }
        if (role === "documentation") {
            for (const specifier of this.extractMarkdownLinkTargets(text)) {
                const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
                if (targetFilePath) {
                    addRelationship(targetFilePath, "documents");
                }
            }
        }
        if (role === "template") {
            for (const specifier of this.extractTemplateLinkTargets(text)) {
                const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
                if (targetFilePath) {
                    addRelationship(targetFilePath, "related-to");
                }
            }
        }
        return relationships;
    }
    extractImportSpecifiers(text) {
        const specifiers = new Set();
        const patterns = [
            /\bimport\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g,
            /\bfrom\s+["']([^"']+)["']\s+import\b/g,
            /\brequire\(\s*["']([^"']+)["']\s*\)/g,
            /#include\s+["<]([^">]+)[">]/g,
            /@(?:use|import)\s+["']([^"']+)["']/g,
        ];
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                const specifier = match[1]?.trim();
                if (specifier && this.isLikelyLocalSpecifier(specifier)) {
                    specifiers.add(specifier);
                }
            }
        }
        return [...specifiers];
    }
    extractMarkdownLinkTargets(text) {
        const targets = new Set();
        for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
            const target = this.normalizeRelationshipTarget(match[1]);
            if (target && this.isLikelyLocalSpecifier(target)) {
                targets.add(target);
            }
        }
        return [...targets];
    }
    extractTemplateLinkTargets(text) {
        const targets = new Set();
        const patterns = [
            /\b(?:include|extends|partial)\s+["']([^"']+)["']/g,
            /\bsrc\s*=\s*["']([^"']+)["']/g,
            /\bhref\s*=\s*["']([^"']+)["']/g,
        ];
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                const target = this.normalizeRelationshipTarget(match[1]);
                if (target && this.isLikelyLocalSpecifier(target)) {
                    targets.add(target);
                }
            }
        }
        return [...targets];
    }
    inferTestCoverageTargets(sourceFilePath, knownFileLookup) {
        const normalizedSourceBase = this.stripTestSuffix(path.posix.basename(sourceFilePath));
        if (!normalizedSourceBase) {
            return [];
        }
        const sourceDir = path.posix.dirname(sourceFilePath);
        const candidates = new Set();
        const extensions = [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".go",
            ".java",
            ".rs",
            ".c",
            ".h",
            ".cpp",
            ".cc",
            ".cxx",
            ".hpp",
            ".hh",
            ".hxx",
            ".cs",
            ".php",
            ".phtml",
            ".rb",
            ".kt",
            ".kts",
            ".swift",
        ];
        for (const extension of extensions) {
            candidates.add(path.posix.normalize(path.posix.join(sourceDir, `${normalizedSourceBase}${extension}`)));
            candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSourceBase, `index${extension}`)));
        }
        const matches = new Set();
        for (const candidate of candidates) {
            const resolved = this.findKnownFilePath(candidate, knownFileLookup);
            if (resolved && resolved !== sourceFilePath) {
                matches.add(resolved);
            }
        }
        return [...matches];
    }
    resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup) {
        const normalizedSpecifier = this.normalizeRelationshipTarget(specifier);
        if (!normalizedSpecifier ||
            /^(?:[a-z]+:|#|mailto:|data:|https?:)/i.test(normalizedSpecifier)) {
            return undefined;
        }
        const sourceDir = path.posix.dirname(sourceFilePath);
        const candidates = new Set();
        if (normalizedSpecifier.startsWith(".") ||
            normalizedSpecifier.startsWith("/")) {
            candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSpecifier)));
        }
        else {
            candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSpecifier)));
            candidates.add(path.posix.normalize(normalizedSpecifier));
        }
        for (const candidate of [...candidates]) {
            const resolved = this.findKnownFilePath(candidate, knownFileLookup);
            if (resolved) {
                return resolved;
            }
            for (const expandedCandidate of this.expandRelationshipPathCandidates(candidate)) {
                const expandedResolved = this.findKnownFilePath(expandedCandidate, knownFileLookup);
                if (expandedResolved) {
                    return expandedResolved;
                }
            }
        }
        return undefined;
    }
    expandRelationshipPathCandidates(basePath) {
        const extensionCandidates = [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".go",
            ".java",
            ".rs",
            ".c",
            ".h",
            ".cpp",
            ".cc",
            ".cxx",
            ".hpp",
            ".hh",
            ".hxx",
            ".cs",
            ".php",
            ".phtml",
            ".rb",
            ".kt",
            ".kts",
            ".swift",
            ".md",
            ".mdx",
            ".markdown",
            ".txt",
            ".rst",
            ".adoc",
            ".html",
            ".htm",
        ];
        const candidates = new Set();
        const normalizedBase = path.posix.normalize(basePath);
        if (path.posix.extname(normalizedBase)) {
            candidates.add(normalizedBase);
        }
        else {
            for (const extension of extensionCandidates) {
                candidates.add(`${normalizedBase}${extension}`);
                candidates.add(path.posix.join(normalizedBase, `index${extension}`));
            }
        }
        return [...candidates];
    }
    normalizeRelationshipTarget(value) {
        return value
            .trim()
            .replace(/[?#].*$/, "")
            .replace(/\\/g, "/");
    }
    stripTestSuffix(fileName) {
        const withoutExtension = fileName.replace(/\.[^.]+$/, "");
        const withoutSuffix = withoutExtension.replace(/(?:\.|-|_)?(?:test|spec)$/i, "");
        return withoutSuffix.length > 0 ? withoutSuffix : withoutExtension;
    }
    isLikelyLocalSpecifier(specifier) {
        return (specifier.startsWith(".") ||
            specifier.startsWith("/") ||
            specifier.includes("/"));
    }
    collectKnownFilePaths(filesByRole) {
        const filePaths = new Set();
        for (const filePath of this.cachedGraph.fileIndex.keys()) {
            filePaths.add(filePath);
        }
        for (const relationship of this.flattenSupplementaryFileRelationships()) {
            filePaths.add(relationship.sourceFilePath);
            filePaths.add(relationship.targetFilePath);
        }
        if (filesByRole) {
            for (const uris of Object.values(filesByRole)) {
                for (const uri of uris) {
                    filePaths.add((0, workspaceScanner_1.toWorkspaceRelativePath)(uri));
                }
            }
        }
        return filePaths;
    }
    collectKnownFileUriLookup(filesByRole) {
        const lookup = new Map();
        for (const node of this.cachedGraph.nodes.values()) {
            lookup.set(node.filePath, node.uriString);
        }
        for (const relationship of this.flattenSupplementaryFileRelationships()) {
            if (relationship.sourceUriString) {
                lookup.set(relationship.sourceFilePath, relationship.sourceUriString);
            }
            if (relationship.targetUriString) {
                lookup.set(relationship.targetFilePath, relationship.targetUriString);
            }
        }
        if (filesByRole) {
            for (const uris of Object.values(filesByRole)) {
                for (const uri of uris) {
                    lookup.set((0, workspaceScanner_1.toWorkspaceRelativePath)(uri), uri.toString());
                }
            }
        }
        return lookup;
    }
    createKnownFilePathLookup(filePaths) {
        const lookup = new Map();
        for (const filePath of filePaths) {
            lookup.set(filePath.toLowerCase(), filePath);
        }
        return lookup;
    }
    findKnownFilePath(candidate, knownFileLookup) {
        const exactMatch = knownFileLookup.get(candidate.toLowerCase());
        if (exactMatch) {
            return exactMatch;
        }
        const normalizedCandidate = candidate.replace(/\\/g, "/");
        for (const [key, filePath] of knownFileLookup) {
            if (key.endsWith(`/${normalizedCandidate.toLowerCase()}`) ||
                key === normalizedCandidate.toLowerCase()) {
                return filePath;
            }
        }
        return undefined;
    }
    flattenSupplementaryFileRelationships() {
        const relationships = [];
        for (const entries of this.supplementaryFileRelationshipIndex.values()) {
            relationships.push(...entries);
        }
        return relationships.sort((left, right) => {
            if (left.sourceFilePath !== right.sourceFilePath) {
                return left.sourceFilePath.localeCompare(right.sourceFilePath);
            }
            if (left.relationship !== right.relationship) {
                return left.relationship.localeCompare(right.relationship);
            }
            return left.targetFilePath.localeCompare(right.targetFilePath);
        });
    }
    async readWorkspaceFileText(uri) {
        try {
            const content = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(content).toString("utf8");
        }
        catch {
            return undefined;
        }
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
            fileRoleSummary: this.cachedGraph.fileRoleSummary,
            fileRelationships: this.flattenSupplementaryFileRelationships(),
            nodes: [...this.cachedGraph.nodes.values()].map((node) => this.serializeNode(node)),
            symbolCache: (0, symbolIndexer_1.serializeIndexedSymbolMap)(this.symbolCache),
            fileModifiedTimes: Object.fromEntries(this.fileModifiedTimes.entries()),
        };
        const payload = Buffer.from(JSON.stringify(snapshot), "utf8");
        await vscode.workspace.fs.writeFile(this.cacheFileUri, payload);
    }
    /**
     * Write the entire current in-memory graph to the SQLite database in a
     * single transaction.  Called after a full workspace build and (optionally)
     * after a JSON-to-SQLite migration.
     *
     * @deprecated Only call `schedulePersistence()` when `this.db` is undefined.
     */
    persistToDatabase() {
        if (!this.db) {
            return;
        }
        const db = this.db;
        try {
            db.transaction(() => {
                // Write all nodes and their outgoing edges.
                for (const node of this.cachedGraph.nodes.values()) {
                    db.upsertNode({
                        id: node.id,
                        symbolName: node.symbolName,
                        symbolKind: node.symbolKind,
                        nodeType: node.nodeType,
                        filePath: node.filePath,
                        uriString: node.uriString,
                        lineNumber: node.lineNumber,
                        rangeStartLine: node.rangeStartLine,
                        rangeStartCharacter: node.rangeStartCharacter,
                        rangeEndLine: node.rangeEndLine,
                        rangeEndCharacter: node.rangeEndCharacter,
                    });
                    for (const targetId of node.outgoingCalls) {
                        db.upsertEdge(node.id, targetId, "calls");
                    }
                    for (const targetId of node.implementations) {
                        db.upsertEdge(node.id, targetId, "implements");
                    }
                    for (const targetId of node.references.reads) {
                        db.upsertEdge(node.id, targetId, "reads");
                    }
                    for (const targetId of node.references.writes) {
                        db.upsertEdge(node.id, targetId, "writes");
                    }
                }
                // Write file relationships (full replace).
                db.replaceAllFileRelationships(this.flattenSupplementaryFileRelationships());
                // Write symbol cache.
                for (const [id, sym] of this.symbolCache) {
                    db.upsertSymbolCache(id, JSON.stringify((0, symbolIndexer_1.serializeIndexedSymbol)(sym)));
                }
                // Write file modified times.
                for (const [fp, mtime] of this.fileModifiedTimes) {
                    db.setFileModifiedTime(fp, mtime);
                }
                // Write metadata.
                if (this.cachedGraph.builtAt) {
                    db.setMetadata("builtAtIso", this.cachedGraph.builtAt.toISOString());
                }
                if (this.cachedGraph.fileRoleSummary) {
                    db.setMetadata("fileRoleSummary", JSON.stringify(this.cachedGraph.fileRoleSummary));
                }
            });
            this.logger.info("[VSContext] Graph persisted to SQLite database.");
        }
        catch (error) {
            this.logger.warn(`[VSContext] Failed to persist graph to database: ${error}`);
        }
    }
    parseSnapshot(value) {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const candidate = value;
        if (candidate.version !== GRAPH_CACHE_VERSION) {
            return undefined;
        }
        if (candidate.knowledgeModelVersion !== knowledgeModel_1.KNOWLEDGE_MODEL_VERSION) {
            return undefined;
        }
        if (!Array.isArray(candidate.nodes) ||
            !Array.isArray(candidate.symbolCache)) {
            return undefined;
        }
        if (!candidate.fileModifiedTimes ||
            typeof candidate.fileModifiedTimes !== "object") {
            return undefined;
        }
        const safeWorkspaceUri = typeof candidate.workspaceFolderUri === "string"
            ? candidate.workspaceFolderUri
            : undefined;
        const safeSavedAtIso = typeof candidate.savedAtIso === "string" ? candidate.savedAtIso : "";
        if (!safeSavedAtIso) {
            return undefined;
        }
        const safeBuiltAtIso = typeof candidate.builtAtIso === "string"
            ? candidate.builtAtIso
            : undefined;
        const fileRoleSummary = this.parseFileRoleSummary(candidate.fileRoleSummary);
        const fileRelationships = Array.isArray(candidate.fileRelationships)
            ? this.deserializeWorkspaceFileRelationships(candidate.fileRelationships)
            : [];
        return {
            version: candidate.version,
            knowledgeModelVersion: candidate.knowledgeModelVersion,
            workspaceFolderUri: safeWorkspaceUri,
            savedAtIso: safeSavedAtIso,
            builtAtIso: safeBuiltAtIso,
            fileRoleSummary,
            fileRelationships,
            nodes: candidate.nodes,
            symbolCache: candidate.symbolCache,
            fileModifiedTimes: candidate.fileModifiedTimes,
        };
    }
    deserializeWorkspaceFileRelationships(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const relationships = [];
        for (const entry of value) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const candidate = entry;
            if (typeof candidate.sourceFilePath !== "string" ||
                typeof candidate.targetFilePath !== "string" ||
                typeof candidate.sourceUriString !== "string" ||
                typeof candidate.targetUriString !== "string" ||
                typeof candidate.relationship !== "string") {
                continue;
            }
            relationships.push({
                sourceFilePath: candidate.sourceFilePath,
                targetFilePath: candidate.targetFilePath,
                sourceUriString: candidate.sourceUriString,
                targetUriString: candidate.targetUriString,
                relationship: candidate.relationship,
            });
        }
        return relationships;
    }
    parseFileRoleSummary(value) {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const candidate = value;
        if (typeof candidate.source !== "number" ||
            typeof candidate.test !== "number" ||
            typeof candidate.documentation !== "number" ||
            typeof candidate.template !== "number" ||
            typeof candidate.other !== "number") {
            return undefined;
        }
        return {
            source: candidate.source,
            test: candidate.test,
            documentation: candidate.documentation,
            template: candidate.template,
            other: candidate.other,
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
        if (!node || typeof node !== "object") {
            return undefined;
        }
        if (typeof node.id !== "string" ||
            typeof node.symbolName !== "string" ||
            typeof node.symbolKind !== "number" ||
            typeof node.filePath !== "string" ||
            typeof node.uriString !== "string" ||
            typeof node.lineNumber !== "number" ||
            typeof node.rangeStartLine !== "number" ||
            typeof node.rangeStartCharacter !== "number" ||
            typeof node.rangeEndLine !== "number" ||
            typeof node.rangeEndCharacter !== "number" ||
            !Array.isArray(node.outgoingCalls) ||
            !Array.isArray(node.implementations) ||
            !Array.isArray(node.referenceReads) ||
            !Array.isArray(node.referenceWrites)) {
            return undefined;
        }
        const outgoingCalls = node.outgoingCalls.filter((entry) => typeof entry === "string");
        const implementations = node.implementations.filter((entry) => typeof entry === "string");
        const referenceReads = node.referenceReads.filter((entry) => typeof entry === "string");
        const referenceWrites = node.referenceWrites.filter((entry) => typeof entry === "string");
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
            if (typeof filePath !== "string" ||
                typeof modifiedAt !== "number" ||
                !Number.isFinite(modifiedAt)) {
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
            if (uri.scheme !== "file") {
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
        this.logger.info(`[VSContext] File roles: source=${indexResult.fileRoleSummary.source}, test=${indexResult.fileRoleSummary.test}, documentation=${indexResult.fileRoleSummary.documentation}, template=${indexResult.fileRoleSummary.template}, other=${indexResult.fileRoleSummary.other}.`);
    }
    resolveNodeType(kind) {
        if (kind === vscode.SymbolKind.Class) {
            return "class";
        }
        if (kind === vscode.SymbolKind.Interface ||
            kind === vscode.SymbolKind.Enum ||
            kind === vscode.SymbolKind.Namespace ||
            kind === vscode.SymbolKind.Module ||
            kind === vscode.SymbolKind.TypeParameter) {
            return "class";
        }
        if (kind === vscode.SymbolKind.Method ||
            kind === vscode.SymbolKind.Constructor) {
            return "method";
        }
        if (kind === vscode.SymbolKind.Variable ||
            kind === vscode.SymbolKind.Constant ||
            kind === vscode.SymbolKind.Field ||
            kind === vscode.SymbolKind.Property) {
            return "variable";
        }
        return "function";
    }
    isCallableSymbol(kind) {
        return (kind === vscode.SymbolKind.Function ||
            kind === vscode.SymbolKind.Method ||
            kind === vscode.SymbolKind.Constructor);
    }
    isVariableLikeSymbol(kind) {
        return (kind === vscode.SymbolKind.Variable ||
            kind === vscode.SymbolKind.Constant ||
            kind === vscode.SymbolKind.Field ||
            kind === vscode.SymbolKind.Property);
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
        return (node.outgoingCalls.length +
            node.implementations.length +
            node.references.reads.length +
            node.references.writes.length);
    }
    logGraphNodeCreation(symbol) {
        if (!this.isSymbolDebugEnabled()) {
            return;
        }
        const kindLabel = vscode.SymbolKind[symbol.symbolKind] ?? symbol.symbolKind.toString();
        this.logger.info(`[VSContext][debug] Creating graph node: ${symbol.symbolName} (${kindLabel})`);
    }
    isSymbolDebugEnabled() {
        return vscode.workspace
            .getConfiguration("vscontext")
            .get("debugSymbolDetection", false);
    }
    async yieldToEventLoop() {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}
exports.WorkspaceGraphBuilder = WorkspaceGraphBuilder;
//# sourceMappingURL=graphBuilder.js.map