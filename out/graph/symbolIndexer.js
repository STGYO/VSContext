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
]);
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
                scannedFileCount: 0,
                indexedSymbolCount: 0,
                skippedByExclusions: 0,
                skippedByLimit: 0,
            };
        }
    }
    async indexDocumentSymbols(uri, fallbackSymbols = []) {
        const resolved = await this.resolveDocumentSymbols(uri);
        if (resolved.length > 0) {
            return resolved
                .filter((symbol) => SUPPORTED_SYMBOL_KINDS.has(symbol.kind))
                .map((symbol) => this.toIndexedSymbol(symbol));
        }
        if (fallbackSymbols.length > 0) {
            return fallbackSymbols.map((symbol) => this.toIndexedSymbolFromFallback(uri, symbol));
        }
        return [];
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
        const filePaths = files.map((uri) => uri.fsPath);
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
                return [];
            }
            if (resolved[0] instanceof vscode.DocumentSymbol) {
                return this.flattenDocumentSymbols(uri, resolved);
            }
            const asSymbolInfo = resolved;
            return asSymbolInfo
                .filter((entry) => entry.location instanceof vscode.Location)
                .map((entry) => ({
                name: entry.name,
                kind: entry.kind,
                uri: entry.location.uri,
                range: entry.location.range,
            }));
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
        const kind = symbol.kind === 'class' ? vscode.SymbolKind.Class : vscode.SymbolKind.Function;
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
    flattenDocumentSymbols(uri, symbols) {
        const queue = [...symbols];
        const flattened = [];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
                continue;
            }
            flattened.push({
                name: current.name,
                kind: current.kind,
                range: current.range,
                uri,
            });
            if (current.children && current.children.length > 0) {
                queue.push(...current.children);
            }
        }
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