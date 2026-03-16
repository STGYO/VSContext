import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { Logger } from '../utils/logger';

class VSContextTreeItem extends vscode.TreeItem {
  public readonly children: VSContextTreeItem[];

  public constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    id: string,
    children: VSContextTreeItem[] = [],
  ) {
    super(label || 'Unnamed Item', collapsibleState);
    this.id = id || `item:${Date.now().toString()}`;
    this.children = children;
  }
}

export class ContextTreeProvider implements vscode.TreeDataProvider<VSContextTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();

  public readonly onDidChangeTreeData: vscode.Event<VSContextTreeItem | undefined | null> =
    this._onDidChangeTreeData.event as vscode.Event<VSContextTreeItem | undefined | null>;

  public constructor(
    private readonly graphBuilder: WorkspaceGraphBuilder,
    private readonly logger: Logger,
  ) {}

  public refresh(): void {
    this.logger.info('Tree refresh requested.');
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: VSContextTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: VSContextTreeItem): Promise<VSContextTreeItem[]> {
    try {
      if (element) {
        return element.children ?? [];
      }

      const graph = this.graphBuilder.peekGraph();
      this.logger.info(`Tree root requested with ${graph.nodes.size} nodes.`);
      return this.buildRootTree(graph, this.graphBuilder.isIndexing());
    } catch (error) {
      this.logger.error('Tree rendering failed.', error);
      return [
        new VSContextTreeItem(
          'VSContext tree failed to render',
          vscode.TreeItemCollapsibleState.None,
          'vscontext:error',
        ),
      ];
    }
  }

  private buildRootTree(graph: Awaited<ReturnType<WorkspaceGraphBuilder['getGraph']>>, isIndexing: boolean): VSContextTreeItem[] {
    const filesNode = this.buildFilesNode(graph, isIndexing);
    const analysisNode = this.buildAnalysisNode();

    const workspaceNode = new VSContextTreeItem(
      'Workspace',
      vscode.TreeItemCollapsibleState.Expanded,
      'vscontext:workspace',
      [filesNode, analysisNode],
    );

    return [workspaceNode];
  }

  private buildFilesNode(graph: Awaited<ReturnType<WorkspaceGraphBuilder['getGraph']>>, isIndexing: boolean): VSContextTreeItem {
    const fileItems: VSContextTreeItem[] = [];

    if (isIndexing && graph.nodes.size === 0) {
      fileItems.push(
        new VSContextTreeItem(
          'Indexing workspace symbols...',
          vscode.TreeItemCollapsibleState.None,
          'vscontext:indexing:loading',
        ),
      );
    }

    const sortedFiles = [...graph.fileIndex.keys()].sort((left, right) => left.localeCompare(right));

    for (const filePath of sortedFiles) {
      const nodeIds = graph.fileIndex.get(filePath) ?? [];
      const symbols = nodeIds
        .map((nodeId) => graph.nodes.get(nodeId))
        .filter((node): node is GraphNode => node !== undefined);

      const functionItems = symbols
        .filter((node) => this.isFunctionLike(node.symbolKind))
        .map((node) => this.createSymbolItem(node, true));

      const classItems = symbols
        .filter((node) => node.symbolKind === vscode.SymbolKind.Class)
        .map((node) => this.createSymbolItem(node, false));

      const groupedChildren: VSContextTreeItem[] = [
        new VSContextTreeItem(
          'Functions',
          vscode.TreeItemCollapsibleState.Collapsed,
          `vscontext:file:${filePath}:functions`,
          functionItems.length > 0
            ? functionItems
            : [new VSContextTreeItem('No functions', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:functions:empty`)],
        ),
        new VSContextTreeItem(
          'Classes',
          vscode.TreeItemCollapsibleState.Collapsed,
          `vscontext:file:${filePath}:classes`,
          classItems.length > 0
            ? classItems
            : [new VSContextTreeItem('No classes', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:classes:empty`)],
        ),
      ];

      const fileItem = new VSContextTreeItem(
        filePath || 'Unnamed File',
        vscode.TreeItemCollapsibleState.Collapsed,
        `vscontext:file:${filePath}`,
        groupedChildren,
      );
      fileItems.push(fileItem);
    }

    if (fileItems.length === 0) {
      fileItems.push(
        new VSContextTreeItem(
          'No symbols indexed yet',
          vscode.TreeItemCollapsibleState.None,
          'vscontext:file:empty',
        ),
      );
    }

    const filesNode = new VSContextTreeItem(
      'Files',
      vscode.TreeItemCollapsibleState.Expanded,
      'vscontext:files',
      fileItems,
    );

    return filesNode;
  }

  private createSymbolItem(node: GraphNode, appendCallSuffix: boolean): VSContextTreeItem {
    const baseLabel = node.symbolName && node.symbolName.trim().length > 0 ? node.symbolName : 'Unknown Symbol';
    const item = new VSContextTreeItem(
      appendCallSuffix ? `${baseLabel}()` : baseLabel,
      vscode.TreeItemCollapsibleState.None,
      `vscontext:symbol:${node.id}`,
    );

    item.description = `Line ${node.lineNumber}`;
    item.command = {
      command: 'vscontext.openNode',
      title: 'Open Symbol',
      arguments: [node.id],
    };
    item.contextValue = appendCallSuffix ? 'vscontext.method' : 'vscontext.class';
    return item;
  }

  private isFunctionLike(kind: vscode.SymbolKind): boolean {
    return (
      kind === vscode.SymbolKind.Function
      || kind === vscode.SymbolKind.Method
      || kind === vscode.SymbolKind.Constructor
    );
  }

  private buildAnalysisNode(): VSContextTreeItem {
    const traceItem = new VSContextTreeItem(
      'Trace Execution Path',
      vscode.TreeItemCollapsibleState.None,
      'vscontext:analysis:trace',
    );
    traceItem.command = {
      command: 'vscontext.traceExecution',
      title: 'Trace Execution Path',
    };

    const impactItem = new VSContextTreeItem(
      'Impact Analysis',
      vscode.TreeItemCollapsibleState.None,
      'vscontext:analysis:impact',
    );
    impactItem.command = {
      command: 'vscontext.findImpact',
      title: 'Find Impact of Change',
    };

    const analysisNode = new VSContextTreeItem(
      'Analysis',
      vscode.TreeItemCollapsibleState.Expanded,
      'vscontext:analysis',
      [traceItem, impactItem],
    );

    return analysisNode;
  }
}
