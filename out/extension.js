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
const vscode = __importStar(require("vscode"));
const impactAnalysis_1 = require("./analysis/impactAnalysis");
const executionTrace_1 = require("./analysis/executionTrace");
const graphBuilder_1 = require("./graph/graphBuilder");
const symbolIndexer_1 = require("./graph/symbolIndexer");
const contextTreeProvider_1 = require("./tree/contextTreeProvider");
const logger_1 = require("./utils/logger");
const symbolResolver_1 = require("./utils/symbolResolver");
const workspaceScanner_1 = require("./utils/workspaceScanner");
const executionPanel_1 = require("./webview/executionPanel");
const impactPanel_1 = require("./webview/impactPanel");
async function activate(context) {
    const logger = new logger_1.Logger('VSContext');
    context.subscriptions.push(logger);
    try {
        console.log('[VSContext] Extension activated');
        logger.info('Activating VSContext extension.');
        const scanSettings = (0, workspaceScanner_1.getWorkspaceScanSettings)();
        const symbolIndexer = new symbolIndexer_1.SymbolIndexer(logger);
        const graphBuilder = new graphBuilder_1.WorkspaceGraphBuilder(symbolIndexer, logger);
        const treeProvider = new contextTreeProvider_1.ContextTreeProvider(graphBuilder, logger);
        const treeView = vscode.window.createTreeView('vscontext.explorer', {
            treeDataProvider: treeProvider,
            showCollapseAll: true,
        });
        context.subscriptions.push(treeView);
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
                }, async () => {
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
                    for (const uri of deleteUris) {
                        await graphBuilder.removeDocument(uri);
                        updatedCount += 1;
                        if (updatedCount % 10 === 0) {
                            await new Promise((resolve) => {
                                setImmediate(resolve);
                            });
                        }
                    }
                    for (const uri of upsertUris) {
                        await graphBuilder.upsertDocument(uri);
                        updatedCount += 1;
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
                        return;
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
                        return;
                    }
                    await (0, symbolResolver_1.openGraphNodeInEditor)(node);
                });
            }
            catch (error) {
                logger.error('Command failed: vscontext.findImpact', error);
                void vscode.window.showErrorMessage('VSContext impact analysis failed.');
            }
        }));
        void vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'VSContext: Indexing workspace',
        }, async () => {
            await graphBuilder.buildWorkspaceGraph();
            treeProvider.refresh();
        });
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