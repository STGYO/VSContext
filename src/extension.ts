import * as vscode from 'vscode';

import { findImpactOfChange } from './analysis/impactAnalysis';
import { traceExecutionPath } from './analysis/executionTrace';
import { WorkspaceGraphBuilder } from './graph/graphBuilder';
import { SymbolIndexer } from './graph/symbolIndexer';
import { ContextTreeProvider } from './tree/contextTreeProvider';
import { Logger } from './utils/logger';
import { openGraphNodeInEditor, resolveSelectedSymbol } from './utils/symbolResolver';
import { getWorkspaceScanSettings } from './utils/workspaceScanner';
import { openExecutionPanel } from './webview/executionPanel';
import { openImpactPanel } from './webview/impactPanel';
import { openCodeGraphView } from './views/codeGraphView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger('VSContext');
  context.subscriptions.push(logger);

  try {
    console.log('[VSContext] Extension activated');
    logger.info('Activating VSContext extension.');

    const scanSettings = getWorkspaceScanSettings();
    const symbolIndexer = new SymbolIndexer(logger);
    const graphBuilder = new WorkspaceGraphBuilder(symbolIndexer, logger);
    const treeProvider = new ContextTreeProvider(graphBuilder, logger);

    const treeView = vscode.window.createTreeView('vscontext.explorer', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });

    context.subscriptions.push(treeView);

    let refreshTimer: NodeJS.Timeout | undefined;
    const pendingUpserts = new Set<string>();
    const pendingDeletes = new Set<string>();

    const scheduleIncrementalRefresh = (trigger: string): void => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      refreshTimer = setTimeout(() => {
        void vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'VSContext: Updating index',
          },
          async () => {
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
                await new Promise<void>((resolve) => {
                  setImmediate(resolve);
                });
              }
            }

            for (const uri of upsertUris) {
              await graphBuilder.upsertDocument(uri);
              updatedCount += 1;
              if (updatedCount % 10 === 0) {
                await new Promise<void>((resolve) => {
                  setImmediate(resolve);
                });
              }
            }

            logger.info(`[VSContext] Incremental indexing updated ${updatedCount} files after ${trigger}.`);
            treeProvider.refresh();
          },
        );
      }, scanSettings.refreshDebounceMs);
    };

    context.subscriptions.push(
      new vscode.Disposable(() => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file') {
          return;
        }

        pendingUpserts.add(document.uri.toString());
        scheduleIncrementalRefresh('file save');
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          if (uri.scheme !== 'file') {
            continue;
          }

          pendingUpserts.add(uri.toString());
        }

        scheduleIncrementalRefresh('file create');
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
          if (uri.scheme !== 'file') {
            continue;
          }

          pendingDeletes.add(uri.toString());
        }

        scheduleIncrementalRefresh('file delete');
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.openNode', async (nodeId?: string) => {
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

          await openGraphNodeInEditor(node);
        } catch (error) {
          logger.error('Command failed: vscontext.openNode', error);
          void vscode.window.showErrorMessage('VSContext failed to open the selected symbol.');
        }
      }),

      vscode.commands.registerCommand('vscontext.traceExecution', async (argument?: { nodeId?: string } | string) => {
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
          const selectedNode = await resolveSelectedSymbol(graph, explicitNodeId, {
            isIndexing: graphBuilder.isIndexing(),
          });

          if (!selectedNode) {
            logger.warn('Trace execution command was invoked without a resolvable symbol selection.');
            return;
          }

          logger.info(`Trace command started for ${selectedNode.symbolName} (${selectedNode.filePath}:${selectedNode.lineNumber}).`);
          const result = await traceExecutionPath(graph, selectedNode.id, 25);
          logger.info(`Trace command completed with ${result.nodes.length} traversal nodes.`);

          openExecutionPanel(result, logger, async (nodeId: string) => {
            const latestGraph = await graphBuilder.getGraph();
            const node = latestGraph.nodes.get(nodeId);
            if (!node) {
              return;
            }

            await openGraphNodeInEditor(node);
          });
        } catch (error) {
          logger.error('Command failed: vscontext.traceExecution', error);
          void vscode.window.showErrorMessage('VSContext trace execution failed.');
        }
      }),

      vscode.commands.registerCommand('vscontext.findImpact', async (argument?: { nodeId?: string } | string) => {
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
          const selectedNode = await resolveSelectedSymbol(graph, explicitNodeId, {
            isIndexing: graphBuilder.isIndexing(),
          });

          if (!selectedNode) {
            logger.warn('Impact analysis command was invoked without a resolvable symbol selection.');
            return;
          }

          logger.info(`Impact command started for ${selectedNode.symbolName} (${selectedNode.filePath}:${selectedNode.lineNumber}).`);
          const result = await findImpactOfChange(graph, selectedNode.id, 25);
          logger.info(`Impact command completed with ${result.nodes.length} traversal nodes.`);

          openImpactPanel(result, logger, async (nodeId: string) => {
            const latestGraph = await graphBuilder.getGraph();
            const node = latestGraph.nodes.get(nodeId);
            if (!node) {
              return;
            }

            await openGraphNodeInEditor(node);
          });
        } catch (error) {
          logger.error('Command failed: vscontext.findImpact', error);
          void vscode.window.showErrorMessage('VSContext impact analysis failed.');
        }
      }),

      vscode.commands.registerCommand('vscontext.viewCodeGraph', async () => {
        try {
          logger.info('Command executed: vscontext.viewCodeGraph');
          await openCodeGraphView(context, graphBuilder, logger);
        } catch (error) {
          logger.error('Command failed: vscontext.viewCodeGraph', error);
          void vscode.window.showErrorMessage('VSContext failed to open the code graph view.');
        }
      }),
    );

    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'VSContext: Indexing workspace',
      },
      async () => {
        await graphBuilder.buildWorkspaceGraph();
        treeProvider.refresh();
      },
    );

    treeProvider.refresh();
    logger.info('VSContext activation completed.');
  } catch (error) {
    logger.error('VSContext activation failed.', error);
    void vscode.window.showErrorMessage('VSContext failed to activate. Check the VSContext output channel.');
    throw error;
  }
}

export function deactivate(): void {
  // No-op. VS Code disposes registered disposables automatically.
}
