import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import { findImpactOfChange } from './analysis/impactAnalysis';
import { registerVSContextChatParticipant } from './chat/chatParticipant';
import { traceExecutionPath } from './analysis/executionTrace';
import { WorkspaceGraphBuilder } from './graph/graphBuilder';
import { SymbolIndexer } from './graph/symbolIndexer';
import { WorkspaceSemanticIndexer } from './semantic/semanticIndexer';
import { ContextTreeProvider } from './tree/contextTreeProvider';
import { Logger } from './utils/logger';
import { openGraphNodeInEditor, resolveSelectedSymbol } from './utils/symbolResolver';
import {
  findWorkspaceSourceFiles,
  getPrimaryWorkspaceFolder,
  getWorkspaceScanSettings,
  getWorkspaceCacheKey,
  toWorkspaceRelativePath,
} from './utils/workspaceScanner';
import { openExecutionPanel } from './webview/executionPanel';
import { openImpactPanel } from './webview/impactPanel';
import { openCodeGraphView } from './views/codeGraphView';
import { IndexTelemetry, IncrementalChangeTracker } from './indexing/indexTelemetry';

function createGraphCacheUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    return undefined;
  }

  const workspaceHash = crypto
    .createHash('sha256')
    .update(getWorkspaceCacheKey())
    .update('|')
    .update(String(context.extension.packageJSON?.version ?? 'unknown'))
    .digest('hex')
    .slice(0, 16);

  return vscode.Uri.file(path.join(context.globalStorageUri.fsPath, `graph-cache-${workspaceHash}.json`));
}

async function reconcileHydratedGraph(
  graphBuilder: WorkspaceGraphBuilder,
  logger: Logger,
  maxIndexedFiles: number,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  cancellationToken?: vscode.CancellationToken,
): Promise<{ upserts: number; deletes: number; cancelled: boolean }> {
  const telemetry = new IndexTelemetry(logger, 'reconciliation');
  const changeTracker = new IncrementalChangeTracker();

  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    const metrics = telemetry.finish();
    telemetry.logSummary(metrics);
    return {
      upserts: 0,
      deletes: 0,
      cancelled: false,
    };
  }

  // Stage 1: Scan workspace
  progress?.report({ message: 'VSContext: Scanning workspace files...' });
  const scanResult = await findWorkspaceSourceFiles(maxIndexedFiles);
  const cachedModifiedTimes = graphBuilder.getTrackedFileModifiedTimes();
  const currentPaths = new Set<string>();
  const changedUris: vscode.Uri[] = [];

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

    const filePath = toWorkspaceRelativePath(uri);
    currentPaths.add(filePath);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cachedMtime = cachedModifiedTimes.get(filePath);
      if (cachedMtime === undefined || Math.abs(cachedMtime - stat.mtime) > 1) {
        changedUris.push(uri);
        telemetry.recordFileScanAdded();
        changeTracker.recordModified(filePath);
      } else {
        telemetry.recordFileScanSkipped();
      }
    } catch {
      changedUris.push(uri);
      telemetry.recordFileScanAdded();
      changeTracker.recordModified(filePath);
    }

    checked += 1;
    if (checked % 100 === 0) {
      progress?.report({ message: `VSContext: Scanning workspace (${checked}/${scanResult.files.length})` });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  const deletedUris = [...cachedModifiedTimes.keys()]
    .filter((filePath) => !currentPaths.has(filePath))
    .map((filePath) => {
      changeTracker.recordDeleted(filePath);
      return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, filePath));
    });

  const totalOperations = deletedUris.length + changedUris.length;
  telemetry.recordFilesIndexed(changedUris.length, 0, deletedUris.length);

  // Stage 2: Apply changes
  let processed = 0;

  for (const uri of deletedUris) {
    if (cancellationToken?.isCancellationRequested) {
      logger.info('[VSContext] Hydrated graph refresh cancelled while removing deleted files.');
      const metrics = telemetry.finish();
      telemetry.logSummary(metrics);
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
        message: `VSContext: Removing ${processed}/${totalOperations} (${deletedUris.length} deletes, ${changedUris.length} updates)`,
        increment: (100 / totalOperations),
      });
    }
    if (processed % 25 === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  let appliedUpserts = 0;
  for (const uri of changedUris) {
    if (cancellationToken?.isCancellationRequested) {
      logger.info('[VSContext] Hydrated graph refresh cancelled while applying updated files.');
      const metrics = telemetry.finish();
      telemetry.logSummary(metrics);
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
        message: `VSContext: Updating ${processed}/${totalOperations} (${deletedUris.length} deletes, ${changedUris.length} updates)`,
        increment: (100 / totalOperations),
      });
    }
    if (processed % 25 === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  const delta = changeTracker.getDelta();
  logger.info(`[VSContext] Hydrated graph refresh: ${delta.added.length} added, ${delta.modified.length} modified, ${delta.deleted.length} deleted (${delta.totalChanges} total).`);

  const metrics = telemetry.finish();
  telemetry.logSummary(metrics);

  return {
    upserts: appliedUpserts,
    deletes: deletedUris.length,
    cancelled: false,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger('VSContext');
  context.subscriptions.push(logger);

  try {
    console.log('[VSContext] Extension activated');
    logger.info('Activating VSContext extension.');

    const scanSettings = getWorkspaceScanSettings();
    const symbolIndexer = new SymbolIndexer(logger);
    const semanticIndexer = new WorkspaceSemanticIndexer(logger);
    const cacheFileUri = createGraphCacheUri(context);
    const graphBuilder = new WorkspaceGraphBuilder(symbolIndexer, logger, cacheFileUri);
    let treeProvider: ContextTreeProvider;
    let initializationPromise: Promise<void> | undefined;

    const ensureGraphInitialized = async (): Promise<void> => {
      if (graphBuilder.hasCompletedInitialIndex()) {
        return;
      }

      if (initializationPromise) {
        await initializationPromise;
        return;
      }

      initializationPromise = (async () => {
        const hydrated = await graphBuilder.hydrateFromCache();
        if (hydrated) {
          treeProvider.refresh();
          logger.info('[VSContext] Cache hydration completed; refreshing for file changes.');
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: 'VSContext: Refreshing cached graph',
              cancellable: true,
            },
            async (progress, token) => {
              try {
                const refreshed = await reconcileHydratedGraph(
                  graphBuilder,
                  logger,
                  scanSettings.maxIndexedFiles,
                  progress,
                  token,
                );
                if (!refreshed.cancelled && (refreshed.upserts > 0 || refreshed.deletes > 0)) {
                  treeProvider.refresh();
                  logger.info(`[VSContext] Reconciliation completed: ${refreshed.upserts} upserts, ${refreshed.deletes} deletes.`);
                } else if (refreshed.cancelled) {
                  logger.info('[VSContext] Graph refresh was cancelled by user.');
                }
              } catch (error) {
                logger.warn(`Failed to reconcile hydrated graph state. ${String(error)}`);
              }
            },
          );
          return;
        }

        logger.info('[VSContext] No cache found; performing full workspace indexing.');
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'VSContext: Indexing workspace (full build)',
            cancellable: true,
          },
          async (progress) => {
            try {
              progress.report({ message: 'Indexing source files...' });
              await graphBuilder.buildWorkspaceGraph();
              treeProvider.refresh();
              logger.info('[VSContext] Full workspace indexing completed.');
            } catch (error) {
              logger.error('Workspace indexing failed.', error);
            }
          },
        );
      })().finally(() => {
        initializationPromise = undefined;
      });

      await initializationPromise;
    };

    treeProvider = new ContextTreeProvider(graphBuilder, logger, () => {
      void ensureGraphInitialized();
    });

    const treeView = vscode.window.createTreeView('vscontext.explorer', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });

    context.subscriptions.push(treeProvider);
    context.subscriptions.push(treeView);

    let lastSelectedNodeId: string | undefined;
    context.subscriptions.push(
      treeView.onDidChangeSelection((event) => {
        const selected = event.selection[0];
        if (selected?.nodeId) {
          lastSelectedNodeId = selected.nodeId;
        }
      }),
    );

    context.subscriptions.push(
      registerVSContextChatParticipant({
        extensionUri: context.extensionUri,
        graphBuilder,
        semanticIndexer,
        logger,
        getLastTreeSelectionNodeId: () => lastSelectedNodeId,
        ensureGraphInitialized,
      }),
    );

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
            cancellable: true,
          },
          async (progress, token) => {
            const telemetry = new IndexTelemetry(logger, 'incremental-update');
            const changeTracker = new IncrementalChangeTracker();

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
            telemetry.recordFilesIndexed(0, upsertUris.length, deleteUris.length);

            for (let index = 0; index < deleteUris.length; index += 1) {
              if (token.isCancellationRequested) {
                for (let remaining = index; remaining < deleteUris.length; remaining += 1) {
                  pendingDeletes.add(deleteUris[remaining].toString());
                }

                for (const pendingUri of upsertUris) {
                  pendingUpserts.add(pendingUri.toString());
                }

                logger.info('[VSContext] Incremental indexing update cancelled; remaining files were re-queued.');
                const metrics = telemetry.finish();
                telemetry.logSummary(metrics);
                return;
              }

              const uri = deleteUris[index];
              changeTracker.recordDeleted(toWorkspaceRelativePath(uri));
              await graphBuilder.removeDocument(uri);
              updatedCount += 1;
              if (totalUpdates > 0) {
                progress.report({
                  message: `VSContext: Updating index (${updatedCount}/${totalUpdates}) after ${trigger}`,
                  increment: (100 / totalUpdates),
                });
              }
              if (updatedCount % 10 === 0) {
                await new Promise<void>((resolve) => {
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
                const metrics = telemetry.finish();
                telemetry.logSummary(metrics);
                return;
              }

              const uri = upsertUris[index];
              changeTracker.recordModified(toWorkspaceRelativePath(uri));
              await graphBuilder.upsertDocument(uri);
              updatedCount += 1;
              if (totalUpdates > 0) {
                progress.report({
                  message: `VSContext: Updating index (${updatedCount}/${totalUpdates}) after ${trigger}`,
                  increment: (100 / totalUpdates),
                });
              }
              if (updatedCount % 10 === 0) {
                await new Promise<void>((resolve) => {
                  setImmediate(resolve);
                });
              }
            }

            const delta = changeTracker.getDelta();
            logger.info(`[VSContext] Incremental indexing completed after ${trigger}: ${delta.modified.length} updated, ${delta.deleted.length} removed.`);
            const metrics = telemetry.finish();
            telemetry.logSummary(metrics);
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

        void graphBuilder.flushPersistence();
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
          await ensureGraphInitialized();
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
          await ensureGraphInitialized();

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
              throw new Error('The selected symbol is no longer available in the graph.');
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
          await ensureGraphInitialized();

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
              throw new Error('The selected symbol is no longer available in the graph.');
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
          await ensureGraphInitialized();
          await openCodeGraphView(context, graphBuilder, logger);
        } catch (error) {
          logger.error('Command failed: vscontext.viewCodeGraph', error);
          void vscode.window.showErrorMessage('VSContext failed to open the code graph view.');
        }
      }),
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
