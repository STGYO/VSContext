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
exports.activate = activate;
exports.deactivate = deactivate;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const impactAnalysis_1 = require("./analysis/impactAnalysis");
const chatParticipant_1 = require("./chat/chatParticipant");
const executionTrace_1 = require("./analysis/executionTrace");
const graphBuilder_1 = require("./graph/graphBuilder");
const symbolIndexer_1 = require("./graph/symbolIndexer");
const semanticIndexer_1 = require("./semantic/semanticIndexer");
const contextTreeProvider_1 = require("./tree/contextTreeProvider");
const logger_1 = require("./utils/logger");
const symbolResolver_1 = require("./utils/symbolResolver");
const workspaceScanner_1 = require("./utils/workspaceScanner");
const executionPanel_1 = require("./webview/executionPanel");
const impactPanel_1 = require("./webview/impactPanel");
const codeGraphView_1 = require("./views/codeGraphView");
function createGraphCacheUri(context) {
    const workspaceFolder = (0, workspaceScanner_1.getPrimaryWorkspaceFolder)();
    if (!workspaceFolder) {
        return undefined;
    }
    const workspaceHash = crypto
        .createHash('sha256')
        .update(workspaceFolder.uri.toString())
        .digest('hex')
        .slice(0, 16);
    return vscode.Uri.file(path.join(context.globalStorageUri.fsPath, `graph-cache-${workspaceHash}.json`));
}
async function reconcileHydratedGraph(graphBuilder, logger, maxIndexedFiles, progress, cancellationToken) {
    const workspaceFolder = (0, workspaceScanner_1.getPrimaryWorkspaceFolder)();
    if (!workspaceFolder) {
        return {
            upserts: 0,
            deletes: 0,
            cancelled: false,
        };
    }
    const scanResult = await (0, workspaceScanner_1.findWorkspaceSourceFiles)(maxIndexedFiles);
    const cachedModifiedTimes = graphBuilder.getTrackedFileModifiedTimes();
    const currentPaths = new Set();
    const changedUris = [];
    let checked = 0;
    for (const uri of scanResult.files) {
        if (cancellationToken?.isCancellationRequested) {
            logger.info('[VSContext] Hydrated graph refresh cancelled while scanning workspace files.');
            return {
                upserts: 0,
                deletes: 0,
                cancelled: true,
            };
        }
        const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(uri);
        currentPaths.add(filePath);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const cachedMtime = cachedModifiedTimes.get(filePath);
            if (cachedMtime === undefined || Math.abs(cachedMtime - stat.mtime) > 1) {
                changedUris.push(uri);
            }
        }
        catch {
            changedUris.push(uri);
        }
        checked += 1;
        if (checked % 100 === 0) {
            progress?.report({ message: `Scanning workspace (${checked}/${scanResult.files.length})` });
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
        }
    }
    const deletedUris = [...cachedModifiedTimes.keys()]
        .filter((filePath) => !currentPaths.has(filePath))
        .map((filePath) => vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, filePath)));
    const totalOperations = deletedUris.length + changedUris.length;
    let processed = 0;
    for (const uri of deletedUris) {
        if (cancellationToken?.isCancellationRequested) {
            logger.info('[VSContext] Hydrated graph refresh cancelled while removing deleted files.');
            return {
                upserts: 0,
                deletes: processed,
                cancelled: true,
            };
        }
        await graphBuilder.removeDocument(uri);
        processed += 1;
        if (totalOperations > 0) {
            progress?.report({
                message: `Refreshing graph (${processed}/${totalOperations})`,
                increment: (100 / totalOperations),
            });
        }
        if (processed % 25 === 0) {
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
        }
    }
    let appliedUpserts = 0;
    for (const uri of changedUris) {
        if (cancellationToken?.isCancellationRequested) {
            logger.info('[VSContext] Hydrated graph refresh cancelled while applying updated files.');
            return {
                upserts: appliedUpserts,
                deletes: deletedUris.length,
                cancelled: true,
            };
        }
        await graphBuilder.upsertDocument(uri);
        appliedUpserts += 1;
        processed += 1;
        if (totalOperations > 0) {
            progress?.report({
                message: `Refreshing graph (${processed}/${totalOperations})`,
                increment: (100 / totalOperations),
            });
        }
        if (processed % 25 === 0) {
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
        }
    }
    logger.info(`[VSContext] Hydrated graph refresh applied ${changedUris.length} upserts and ${deletedUris.length} deletes.`);
    return {
        upserts: appliedUpserts,
        deletes: deletedUris.length,
        cancelled: false,
    };
}
async function activate(context) {
    const logger = new logger_1.Logger('VSContext');
    context.subscriptions.push(logger);
    try {
        console.log('[VSContext] Extension activated');
        logger.info('Activating VSContext extension.');
        const scanSettings = (0, workspaceScanner_1.getWorkspaceScanSettings)();
        const symbolIndexer = new symbolIndexer_1.SymbolIndexer(logger);
        const semanticIndexer = new semanticIndexer_1.WorkspaceSemanticIndexer(logger);
        const cacheFileUri = createGraphCacheUri(context);
        const graphBuilder = new graphBuilder_1.WorkspaceGraphBuilder(symbolIndexer, logger, cacheFileUri);
        const treeProvider = new contextTreeProvider_1.ContextTreeProvider(graphBuilder, logger);
        const treeView = vscode.window.createTreeView('vscontext.explorer', {
            treeDataProvider: treeProvider,
            showCollapseAll: true,
        });
        context.subscriptions.push(treeView);
        let lastSelectedNodeId;
        context.subscriptions.push(treeView.onDidChangeSelection((event) => {
            const selected = event.selection[0];
            if (selected?.nodeId) {
                lastSelectedNodeId = selected.nodeId;
            }
        }));
        context.subscriptions.push((0, chatParticipant_1.registerVSContextChatParticipant)({
            extensionUri: context.extensionUri,
            graphBuilder,
            semanticIndexer,
            logger,
            getLastTreeSelectionNodeId: () => lastSelectedNodeId,
        }));
        let refreshTimer;
        const pendingUpserts = new Set();
        const pendingDeletes = new Set();
        const scheduleIncrementalRefresh = (trigger) => {
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            refreshTimer = setTimeout(() => {
                void vscode.window.withProgress({
                    location: vscode.ProgressLocation.Window,
                    title: 'VSContext: Updating index',
                    cancellable: true,
                }, async (progress, token) => {
                    if (graphBuilder.isIndexing()) {
                        if (pendingUpserts.size > 0 || pendingDeletes.size > 0) {
                            scheduleIncrementalRefresh('deferred update');
                        }
                        return;
                    }
                    const deleteUris = [...pendingDeletes].map((uriString) => vscode.Uri.parse(uriString));
                    const upsertUris = [...pendingUpserts]
                        .filter((uriString) => !pendingDeletes.has(uriString))
                        .map((uriString) => vscode.Uri.parse(uriString));
                    pendingDeletes.clear();
                    pendingUpserts.clear();
                    let updatedCount = 0;
                    const totalUpdates = deleteUris.length + upsertUris.length;
                    for (let index = 0; index < deleteUris.length; index += 1) {
                        if (token.isCancellationRequested) {
                            for (let remaining = index; remaining < deleteUris.length; remaining += 1) {
                                pendingDeletes.add(deleteUris[remaining].toString());
                            }
                            for (const pendingUri of upsertUris) {
                                pendingUpserts.add(pendingUri.toString());
                            }
                            logger.info('[VSContext] Incremental indexing update cancelled; remaining files were re-queued.');
                            return;
                        }
                        const uri = deleteUris[index];
                        await graphBuilder.removeDocument(uri);
                        updatedCount += 1;
                        if (totalUpdates > 0) {
                            progress.report({
                                message: `Updating index (${updatedCount}/${totalUpdates})`,
                                increment: (100 / totalUpdates),
                            });
                        }
                        if (updatedCount % 10 === 0) {
                            await new Promise((resolve) => {
                                setImmediate(resolve);
                            });
                        }
                    }
                    for (let index = 0; index < upsertUris.length; index += 1) {
                        if (token.isCancellationRequested) {
                            for (let remaining = index; remaining < upsertUris.length; remaining += 1) {
                                pendingUpserts.add(upsertUris[remaining].toString());
                            }
                            logger.info('[VSContext] Incremental indexing update cancelled; remaining files were re-queued.');
                            return;
                        }
                        const uri = upsertUris[index];
                        await graphBuilder.upsertDocument(uri);
                        updatedCount += 1;
                        if (totalUpdates > 0) {
                            progress.report({
                                message: `Updating index (${updatedCount}/${totalUpdates})`,
                                increment: (100 / totalUpdates),
                            });
                        }
                        if (updatedCount % 10 === 0) {
                            await new Promise((resolve) => {
                                setImmediate(resolve);
                            });
                        }
                    }
                    logger.info(`[VSContext] Incremental indexing updated ${updatedCount} files after ${trigger}.`);
                    treeProvider.refresh();
                });
            }, scanSettings.refreshDebounceMs);
        };
        context.subscriptions.push(new vscode.Disposable(() => {
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            void graphBuilder.flushPersistence();
        }), vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== 'file') {
                return;
            }
            pendingUpserts.add(document.uri.toString());
            scheduleIncrementalRefresh('file save');
        }), vscode.workspace.onDidCreateFiles((event) => {
            for (const uri of event.files) {
                if (uri.scheme !== 'file') {
                    continue;
                }
                pendingUpserts.add(uri.toString());
            }
            scheduleIncrementalRefresh('file create');
        }), vscode.workspace.onDidDeleteFiles((event) => {
            for (const uri of event.files) {
                if (uri.scheme !== 'file') {
                    continue;
                }
                pendingDeletes.add(uri.toString());
            }
            scheduleIncrementalRefresh('file delete');
        }));
        context.subscriptions.push(vscode.commands.registerCommand('vscontext.openNode', async (nodeId) => {
            try {
                logger.info(`Command executed: vscontext.openNode (${String(nodeId ?? '')})`);
                if (!nodeId || typeof nodeId !== 'string') {
                    return;
                }
                const graph = await graphBuilder.getGraph();
                const node = graph.nodes.get(nodeId);
                if (!node) {
                    void vscode.window.showWarningMessage('The selected symbol is no longer available in the graph.');
                    return;
                }
                await (0, symbolResolver_1.openGraphNodeInEditor)(node);
            }
            catch (error) {
                logger.error('Command failed: vscontext.openNode', error);
                void vscode.window.showErrorMessage('VSContext failed to open the selected symbol.');
            }
        }), vscode.commands.registerCommand('vscontext.traceExecution', async (argument) => {
            try {
                logger.info('Command executed: vscontext.traceExecution');
                if (graphBuilder.isIndexing() && !graphBuilder.hasCompletedInitialIndex()) {
                    void vscode.window.showInformationMessage('VSContext is still indexing the workspace.');
                    return;
                }
                const activeUri = vscode.window.activeTextEditor?.document.uri;
                if (activeUri?.scheme === 'file') {
                    await graphBuilder.ensureDocumentIndexed(activeUri);
                }
                const graph = await graphBuilder.getGraph();
                const explicitNodeId = typeof argument === 'string' ? argument : argument?.nodeId;
                const selectedNode = await (0, symbolResolver_1.resolveSelectedSymbol)(graph, explicitNodeId, {
                    isIndexing: graphBuilder.isIndexing(),
                });
                if (!selectedNode) {
                    logger.warn('Trace execution command was invoked without a resolvable symbol selection.');
                    return;
                }
                logger.info(`Trace command started for ${selectedNode.symbolName} (${selectedNode.filePath}:${selectedNode.lineNumber}).`);
                const result = await (0, executionTrace_1.traceExecutionPath)(graph, selectedNode.id, 25);
                logger.info(`Trace command completed with ${result.nodes.length} traversal nodes.`);
                (0, executionPanel_1.openExecutionPanel)(result, logger, async (nodeId) => {
                    const latestGraph = await graphBuilder.getGraph();
                    const node = latestGraph.nodes.get(nodeId);
                    if (!node) {
                        throw new Error('The selected symbol is no longer available in the graph.');
                    }
                    await (0, symbolResolver_1.openGraphNodeInEditor)(node);
                });
            }
            catch (error) {
                logger.error('Command failed: vscontext.traceExecution', error);
                void vscode.window.showErrorMessage('VSContext trace execution failed.');
            }
        }), vscode.commands.registerCommand('vscontext.findImpact', async (argument) => {
            try {
                logger.info('Command executed: vscontext.findImpact');
                if (graphBuilder.isIndexing() && !graphBuilder.hasCompletedInitialIndex()) {
                    void vscode.window.showInformationMessage('VSContext is still indexing the workspace.');
                    return;
                }
                const activeUri = vscode.window.activeTextEditor?.document.uri;
                if (activeUri?.scheme === 'file') {
                    await graphBuilder.ensureDocumentIndexed(activeUri);
                }
                const graph = await graphBuilder.getGraph();
                const explicitNodeId = typeof argument === 'string' ? argument : argument?.nodeId;
                const selectedNode = await (0, symbolResolver_1.resolveSelectedSymbol)(graph, explicitNodeId, {
                    isIndexing: graphBuilder.isIndexing(),
                });
                if (!selectedNode) {
                    logger.warn('Impact analysis command was invoked without a resolvable symbol selection.');
                    return;
                }
                logger.info(`Impact command started for ${selectedNode.symbolName} (${selectedNode.filePath}:${selectedNode.lineNumber}).`);
                const result = await (0, impactAnalysis_1.findImpactOfChange)(graph, selectedNode.id, 25);
                logger.info(`Impact command completed with ${result.nodes.length} traversal nodes.`);
                (0, impactPanel_1.openImpactPanel)(result, logger, async (nodeId) => {
                    const latestGraph = await graphBuilder.getGraph();
                    const node = latestGraph.nodes.get(nodeId);
                    if (!node) {
                        throw new Error('The selected symbol is no longer available in the graph.');
                    }
                    await (0, symbolResolver_1.openGraphNodeInEditor)(node);
                });
            }
            catch (error) {
                logger.error('Command failed: vscontext.findImpact', error);
                void vscode.window.showErrorMessage('VSContext impact analysis failed.');
            }
        }), vscode.commands.registerCommand('vscontext.viewCodeGraph', async () => {
            try {
                logger.info('Command executed: vscontext.viewCodeGraph');
                await (0, codeGraphView_1.openCodeGraphView)(context, graphBuilder, logger);
            }
            catch (error) {
                logger.error('Command failed: vscontext.viewCodeGraph', error);
                void vscode.window.showErrorMessage('VSContext failed to open the code graph view.');
            }
        }));
        const hydrated = await graphBuilder.hydrateFromCache();
        if (hydrated) {
            treeProvider.refresh();
            void vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'VSContext: Refreshing cached graph',
                cancellable: true,
            }, async (progress, token) => {
                try {
                    const refreshed = await reconcileHydratedGraph(graphBuilder, logger, scanSettings.maxIndexedFiles, progress, token);
                    if (!refreshed.cancelled && (refreshed.upserts > 0 || refreshed.deletes > 0)) {
                        treeProvider.refresh();
                    }
                }
                catch (error) {
                    logger.warn(`Failed to reconcile hydrated graph state. ${String(error)}`);
                }
            });
        }
        else {
            void vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'VSContext: Indexing workspace',
            }, async () => {
                await graphBuilder.buildWorkspaceGraph();
                treeProvider.refresh();
            });
        }
        treeProvider.refresh();
        logger.info('VSContext activation completed.');
    }
    catch (error) {
        logger.error('VSContext activation failed.', error);
        void vscode.window.showErrorMessage('VSContext failed to activate. Check the VSContext output channel.');
        throw error;
    }
}
function deactivate() {
    // No-op. VS Code disposes registered disposables automatically.
}
//# sourceMappingURL=extension.js.map