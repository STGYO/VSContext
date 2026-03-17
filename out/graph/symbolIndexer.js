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
exports.SymbolIndexer = void 0;
exports.serializeIndexedSymbol = serializeIndexedSymbol;
exports.deserializeIndexedSymbol = deserializeIndexedSymbol;
exports.serializeIndexedSymbolMap = serializeIndexedSymbolMap;
exports.deserializeIndexedSymbolMap = deserializeIndexedSymbolMap;
exports.createSymbolNodeId = createSymbolNodeId;
const path = __importStar(require("path"));
const fs_1 = require("fs");
const worker_threads_1 = require("worker_threads");
const vscode = __importStar(require("vscode"));
const workspaceScanner_1 = require("../utils/workspaceScanner");
const SUPPORTED_SYMBOL_KINDS = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Variable,
    vscode.SymbolKind.Constant,
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Property,
]);
const PRE_SCAN_AST_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.c',
    '.h',
    '.cpp',
]);
function serializeIndexedSymbol(symbol) {
    return {
        id: symbol.id,
        symbolName: symbol.symbolName,
        symbolKind: symbol.symbolKind,
        uriString: symbol.uri.toString(),
        filePath: symbol.filePath,
        lineNumber: symbol.lineNumber,
        range: {
            startLine: symbol.range.start.line,
            startCharacter: symbol.range.start.character,
            endLine: symbol.range.end.line,
            endCharacter: symbol.range.end.character,
        },
    };
}
function deserializeIndexedSymbol(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return undefined;
    }
    if (typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
        return undefined;
    }
    if (typeof snapshot.symbolName !== 'string' || snapshot.symbolName.length === 0) {
        return undefined;
    }
    if (typeof snapshot.filePath !== 'string' || snapshot.filePath.length === 0) {
        return undefined;
    }
    if (typeof snapshot.uriString !== 'string' || snapshot.uriString.length === 0) {
        return undefined;
    }
    if (typeof snapshot.symbolKind !== 'number' || !Number.isFinite(snapshot.symbolKind)) {
        return undefined;
    }
    if (typeof snapshot.lineNumber !== 'number' || !Number.isFinite(snapshot.lineNumber) || snapshot.lineNumber < 1) {
        return undefined;
    }
    if (!snapshot.range || typeof snapshot.range !== 'object') {
        return undefined;
    }
    const { startLine, startCharacter, endLine, endCharacter, } = snapshot.range;
    if (typeof startLine !== 'number'
        || typeof startCharacter !== 'number'
        || typeof endLine !== 'number'
        || typeof endCharacter !== 'number'
        || !Number.isFinite(startLine)
        || !Number.isFinite(startCharacter)
        || !Number.isFinite(endLine)
        || !Number.isFinite(endCharacter)
        || startLine < 0
        || startCharacter < 0
        || endLine < 0
        || endCharacter < 0) {
        return undefined;
    }
    let uri;
    try {
        uri = vscode.Uri.parse(snapshot.uriString);
    }
    catch {
        return undefined;
    }
    const range = new vscode.Range(startLine, startCharacter, endLine, endCharacter);
    const normalizedId = createSymbolNodeId(uri, snapshot.symbolName, startLine);
    if (snapshot.id !== normalizedId) {
        return undefined;
    }
    return {
        id: snapshot.id,
        symbolName: snapshot.symbolName,
        symbolKind: snapshot.symbolKind,
        uri,
        filePath: snapshot.filePath,
        lineNumber: snapshot.lineNumber,
        range,
    };
}
function serializeIndexedSymbolMap(symbols) {
    return [...symbols.values()].map((symbol) => serializeIndexedSymbol(symbol));
}
function deserializeIndexedSymbolMap(snapshots) {
    const restored = new Map();
    for (const snapshot of snapshots) {
        const symbol = deserializeIndexedSymbol(snapshot);
        if (!symbol) {
            continue;
        }
        restored.set(symbol.id, symbol);
    }
    return restored;
}
function createSymbolNodeId(uri, symbolName, startLineZeroBased) {
    return `${uri.toString()}::${symbolName}::${startLineZeroBased + 1}`;
}
class SymbolIndexer {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    async indexWorkspaceSymbols() {
        const settings = (0, workspaceScanner_1.getWorkspaceScanSettings)();
        const indexed = new Map();
        try {
            const scanResult = await (0, workspaceScanner_1.findWorkspaceSourceFiles)(settings.maxIndexedFiles);
            this.logger.info(`[VSContext] Indexed ${scanResult.files.length} files selected for symbol extraction.`);
            this.logger.info(`[VSContext] Skipped dependency directories: ${scanResult.skippedByExclusions} files.`);
            if (scanResult.skippedByLimit > 0) {
                this.logger.warn(`[VSContext] Skipped ${scanResult.skippedByLimit} files due to maxIndexedFiles limit.`);
            }
            const preScanResult = await this.runParallelPreScan(scanResult.files, settings.workerCount, settings.workerBatchSize);
            this.logger.info(`[VSContext] Worker pre-scan found symbol candidates in ${preScanResult.candidateFilePaths.length} files.`);
            await this.forEachWithConcurrency(scanResult.files, settings.workerCount, async (uri) => {
                const fallbackSymbols = preScanResult.symbolMap[uri.fsPath] ?? [];
                const symbols = await this.indexDocumentSymbols(uri, fallbackSymbols);
                for (const symbol of symbols) {
                    indexed.set(symbol.id, symbol);
                }
            });
            this.logger.info(`[VSContext] Indexed ${indexed.size} symbols.`);
            return {
                indexed,
                scannedFiles: scanResult.files,
                scannedFileCount: scanResult.files.length,
                indexedSymbolCount: indexed.size,
                skippedByExclusions: scanResult.skippedByExclusions,
                skippedByLimit: scanResult.skippedByLimit,
            };
        }
        catch (error) {
            this.logger.error('Workspace symbol indexing failed.', error);
            return {
                indexed,
                scannedFiles: [],
                scannedFileCount: 0,
                indexedSymbolCount: 0,
                skippedByExclusions: 0,
                skippedByLimit: 0,
            };
        }
    }
    async indexDocumentSymbols(uri, fallbackSymbols = []) {
        if (!this.shouldIndexUri(uri)) {
            return [];
        }
        const resolved = await this.resolveDocumentSymbols(uri);
        const fromProvider = resolved
            .filter((symbol) => SUPPORTED_SYMBOL_KINDS.has(symbol.kind))
            .filter((symbol) => this.hasMeaningfulName(symbol.name, symbol.kind))
            .map((symbol) => this.toIndexedSymbol(symbol));
        const fromFallback = fallbackSymbols
            .filter((symbol) => this.hasMeaningfulName(symbol.name, this.toSymbolKindFromFallback(symbol.kind)))
            .map((symbol) => this.toIndexedSymbolFromFallback(uri, symbol));
        const merged = new Map();
        for (const symbol of fromProvider) {
            merged.set(symbol.id, symbol);
        }
        for (const symbol of fromFallback) {
            if (!merged.has(symbol.id)) {
                merged.set(symbol.id, symbol);
            }
        }
        const indexed = [...merged.values()];
        this.logAcceptedSymbols(indexed);
        this.logIndexedVariables(indexed);
        return indexed;
    }
    async resolveOutgoingCalls(symbol, allSymbols) {
        if (!this.isCallableSymbol(symbol.symbolKind)) {
            return [];
        }
        const outgoingIds = new Set();
        try {
            const roots = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', symbol.uri, symbol.range.start);
            for (const root of roots ?? []) {
                const outgoingCalls = await vscode.commands.executeCommand('vscode.provideOutgoingCalls', root);
                for (const outgoingCall of outgoingCalls ?? []) {
                    const nodeId = this.findMatchingSymbolId(outgoingCall.to, allSymbols);
                    if (nodeId && nodeId !== symbol.id) {
                        outgoingIds.add(nodeId);
                    }
                }
            }
        }
        catch {
            return [];
        }
        return [...outgoingIds];
    }
    async runParallelPreScan(files, workerCount, workerBatchSize) {
        const preScannableUris = files.filter((uri) => PRE_SCAN_AST_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase()));
        const filePaths = preScannableUris.map((uri) => uri.fsPath);
        const workerScriptPath = path.join(__dirname, 'symbolPreScanWorker.js');
        const emptyResult = { candidateFilePaths: [], symbolMap: {} };
        if (!(0, fs_1.existsSync)(workerScriptPath) || filePaths.length === 0) {
            return {
                candidateFilePaths: filePaths,
                symbolMap: {},
            };
        }
        const batches = [];
        for (let index = 0; index < filePaths.length; index += workerBatchSize) {
            batches.push(filePaths.slice(index, index + workerBatchSize));
        }
        const maxWorkers = Math.max(1, Math.min(workerCount, batches.length));
        const aggregate = { candidateFilePaths: [], symbolMap: {} };
        let batchIndex = 0;
        const runWorkerLoop = async () => {
            while (batchIndex < batches.length) {
                const currentBatch = batches[batchIndex];
                batchIndex += 1;
                const result = await this.runWorkerBatch(workerScriptPath, currentBatch);
                for (const filePath of result.candidateFilePaths) {
                    aggregate.candidateFilePaths.push(filePath);
                }
                for (const [filePath, symbols] of Object.entries(result.symbolMap)) {
                    aggregate.symbolMap[filePath] = symbols;
                }
                await this.yieldToEventLoop();
            }
        };
        try {
            await Promise.all(Array.from({ length: maxWorkers }, () => runWorkerLoop()));
            return aggregate;
        }
        catch {
            return emptyResult;
        }
    }
    async runWorkerBatch(workerScriptPath, filePaths) {
        return new Promise((resolve) => {
            const worker = new worker_threads_1.Worker(workerScriptPath, {
                workerData: {
                    filePaths,
                },
            });
            const fallback = {
                candidateFilePaths: filePaths,
                symbolMap: {},
            };
            worker.once('message', (message) => {
                worker.terminate().catch(() => undefined);
                resolve(message);
            });
            worker.once('error', () => {
                worker.terminate().catch(() => undefined);
                resolve(fallback);
            });
            worker.once('exit', (code) => {
                if (code !== 0) {
                    resolve(fallback);
                }
            });
        });
    }
    async resolveDocumentSymbols(uri) {
        try {
            const resolved = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
            if (!resolved || resolved.length === 0) {
                if (this.isSymbolDebugEnabled()) {
                    this.logger.info(`[VSContext][debug] Raw symbols: none (${(0, workspaceScanner_1.toWorkspaceRelativePath)(uri)})`);
                }
                return [];
            }
            if (resolved[0] instanceof vscode.DocumentSymbol) {
                const flattened = this.flattenDocumentSymbols(uri, resolved);
                this.logRawResolvedSymbols(uri, flattened);
                return flattened;
            }
            const asSymbolInfo = resolved
                .filter((entry) => entry.location instanceof vscode.Location)
                .map((entry) => ({
                name: entry.name,
                kind: entry.kind,
                uri: entry.location.uri,
                range: entry.location.range,
            }));
            this.logRawResolvedSymbols(uri, asSymbolInfo);
            return asSymbolInfo;
        }
        catch {
            return [];
        }
    }
    toIndexedSymbol(symbol) {
        return {
            id: createSymbolNodeId(symbol.uri, symbol.name, symbol.range.start.line),
            symbolName: symbol.name,
            symbolKind: symbol.kind,
            uri: symbol.uri,
            filePath: (0, workspaceScanner_1.toWorkspaceRelativePath)(symbol.uri),
            lineNumber: symbol.range.start.line + 1,
            range: symbol.range,
        };
    }
    toIndexedSymbolFromFallback(uri, symbol) {
        const kind = this.toSymbolKindFromFallback(symbol.kind);
        const startLine = Math.max(0, symbol.line - 1);
        const range = new vscode.Range(startLine, 0, startLine, 1);
        return {
            id: createSymbolNodeId(uri, symbol.name, startLine),
            symbolName: symbol.name,
            symbolKind: kind,
            uri,
            filePath: (0, workspaceScanner_1.toWorkspaceRelativePath)(uri),
            lineNumber: startLine + 1,
            range,
        };
    }
    toSymbolKindFromFallback(kind) {
        switch (kind) {
            case 'class':
                return vscode.SymbolKind.Class;
            case 'method':
                return vscode.SymbolKind.Method;
            case 'variable':
                return vscode.SymbolKind.Variable;
            case 'constant':
                return vscode.SymbolKind.Constant;
            case 'field':
                return vscode.SymbolKind.Field;
            case 'property':
                return vscode.SymbolKind.Property;
            case 'function':
            default:
                return vscode.SymbolKind.Function;
        }
    }
    flattenDocumentSymbols(uri, symbols) {
        const flattened = [];
        const collectSymbols = (entries) => {
            for (const current of entries) {
                flattened.push({
                    name: current.name,
                    kind: current.kind,
                    range: current.range,
                    uri,
                });
                if (current.children && current.children.length > 0) {
                    collectSymbols(current.children);
                }
            }
        };
        collectSymbols(symbols);
        return flattened;
    }
    async forEachWithConcurrency(values, concurrency, work) {
        let pointer = 0;
        const run = async () => {
            while (pointer < values.length) {
                const current = values[pointer];
                pointer += 1;
                await work(current);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => run()));
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
    hasMeaningfulName(name, kind) {
        const normalized = name.trim();
        if (normalized.length === 0) {
            return false;
        }
        if (!this.isVariableLikeSymbol(kind)) {
            return true;
        }
        return !/^<.*>$/.test(normalized) && normalized.toLowerCase() !== 'anonymous';
    }
    shouldIndexUri(uri) {
        if (uri.scheme !== 'file') {
            return false;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return false;
        }
        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..')) {
            return false;
        }
        return !this.isExcludedPath(relativePath);
    }
    isExcludedPath(relativePath) {
        const segments = relativePath.split('/').map((segment) => segment.toLowerCase());
        return segments.includes('node_modules') || segments.includes('dist') || segments.includes('build');
    }
    logIndexedVariables(symbols) {
        for (const symbol of symbols) {
            if (!this.isVariableLikeSymbol(symbol.symbolKind)) {
                continue;
            }
            this.logger.info(`[VSContext] Indexed variable: ${symbol.symbolName} (${symbol.filePath})`);
        }
    }
    logRawResolvedSymbols(uri, symbols) {
        if (!this.isSymbolDebugEnabled()) {
            return;
        }
        this.logger.info(`[VSContext][debug] Raw symbols: ${symbols.length.toString()} (${(0, workspaceScanner_1.toWorkspaceRelativePath)(uri)})`);
        for (const symbol of symbols) {
            this.logger.info(`[VSContext][debug] Raw symbol: ${symbol.name} (${this.symbolKindLabel(symbol.kind)})`);
        }
    }
    logAcceptedSymbols(symbols) {
        if (!this.isSymbolDebugEnabled()) {
            return;
        }
        for (const symbol of symbols) {
            this.logger.info(`[VSContext][debug] Indexed symbol: ${symbol.symbolName} (${this.symbolKindLabel(symbol.symbolKind)})`);
        }
    }
    symbolKindLabel(kind) {
        const label = vscode.SymbolKind[kind];
        return typeof label === 'string' ? label : kind.toString();
    }
    isSymbolDebugEnabled() {
        return vscode.workspace.getConfiguration('vscontext').get('debugSymbolDetection', false);
    }
    async yieldToEventLoop() {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
    findMatchingSymbolId(callItem, allSymbols) {
        const strictMatchId = createSymbolNodeId(callItem.uri, callItem.name, callItem.selectionRange.start.line);
        if (allSymbols.has(strictMatchId)) {
            return strictMatchId;
        }
        const normalizedTargetName = this.normalizeName(callItem.name);
        for (const candidate of allSymbols.values()) {
            if (candidate.uri.toString() !== callItem.uri.toString()) {
                continue;
            }
            if (this.normalizeName(candidate.symbolName) !== normalizedTargetName) {
                continue;
            }
            const lineDistance = Math.abs(candidate.lineNumber - (callItem.selectionRange.start.line + 1));
            if (lineDistance <= 2) {
                return candidate.id;
            }
        }
        return undefined;
    }
    normalizeName(name) {
        return name.trim().replace(/\(\)$/, '');
    }
}
exports.SymbolIndexer = SymbolIndexer;
//# sourceMappingURL=symbolIndexer.js.map