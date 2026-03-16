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

    const workspaceNode = new VSContextTreeItem(
      'Workspace',
      vscode.TreeItemCollapsibleState.Expanded,
      'vscontext:workspace',
      [filesNode],
    );
    workspaceNode.iconPath = this.themeIcon('root-folder');

    const symbolsNode = this.buildSymbolsNode(graph);
    symbolsNode.iconPath = this.themeIcon('symbol-namespace');

    return [workspaceNode, symbolsNode];
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

      const variableItems = symbols
        .filter((node) => this.isVariableLike(node.symbolKind))
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
        new VSContextTreeItem(
          'Variables',
          vscode.TreeItemCollapsibleState.Collapsed,
          `vscontext:file:${filePath}:variables`,
          variableItems.length > 0
            ? variableItems
            : [new VSContextTreeItem('No variables', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:variables:empty`)],
        ),
      ];

      groupedChildren[0].iconPath = this.themeIcon('symbol-function');
      groupedChildren[1].iconPath = this.themeIcon('symbol-class');
      groupedChildren[2].iconPath = this.themeIcon('symbol-variable');

      const fileItem = new VSContextTreeItem(
        filePath || 'Unnamed File',
        vscode.TreeItemCollapsibleState.Collapsed,
        `vscontext:file:${filePath}`,
        groupedChildren,
      );
      fileItem.iconPath = this.themeIcon('file');
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
    filesNode.iconPath = this.themeIcon('files');

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
    item.contextValue = this.isVariableLike(node.symbolKind)
      ? 'vscontext.variable'
      : appendCallSuffix
        ? 'vscontext.method'
        : 'vscontext.class';
    item.iconPath = this.getNodeIcon(node.symbolKind);
    return item;
  }

  private isFunctionLike(kind: vscode.SymbolKind): boolean {
    return (
      kind === vscode.SymbolKind.Function
      || kind === vscode.SymbolKind.Method
      || kind === vscode.SymbolKind.Constructor
    );
  }

  private isVariableLike(kind: vscode.SymbolKind): boolean {
    return (
      kind === vscode.SymbolKind.Variable
      || kind === vscode.SymbolKind.Constant
      || kind === vscode.SymbolKind.Field
      || kind === vscode.SymbolKind.Property
    );
  }

  private getNodeIcon(kind: vscode.SymbolKind): vscode.ThemeIcon {
    if (this.isFunctionLike(kind)) {
      return this.themeIcon('symbol-function');
    }

    if (kind === vscode.SymbolKind.Class) {
      return this.themeIcon('symbol-class');
    }

    if (this.isVariableLike(kind)) {
      return this.themeIcon('symbol-variable');
    }

    return this.themeIcon('symbol-misc');
  }

  private themeIcon(id: string): vscode.ThemeIcon {
    const ThemeIconCtor = vscode.ThemeIcon as unknown as { new (iconId: string): vscode.ThemeIcon };
    return new ThemeIconCtor(id);
  }

  private buildSymbolsNode(graph: Awaited<ReturnType<WorkspaceGraphBuilder['getGraph']>>): VSContextTreeItem {
    const allNodes = [...graph.nodes.values()];

    const functionItems = allNodes
      .filter((node) => this.isFunctionLike(node.symbolKind))
      .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
      .map((node) => this.createSymbolItem(node, true));

    const classItems = allNodes
      .filter((node) => node.symbolKind === vscode.SymbolKind.Class)
      .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
      .map((node) => this.createSymbolItem(node, false));

    const variableItems = allNodes
      .filter((node) => this.isVariableLike(node.symbolKind))
      .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
      .map((node) => this.createSymbolItem(node, false));

    const symbolsNode = new VSContextTreeItem(
      'Symbols',
      vscode.TreeItemCollapsibleState.Collapsed,
      'vscontext:symbols',
      [
        this.createSymbolCategoryItem('Functions', 'vscontext:symbols:functions', functionItems, 'symbol-function', 'No functions'),
        this.createSymbolCategoryItem('Classes', 'vscontext:symbols:classes', classItems, 'symbol-class', 'No classes'),
        this.createSymbolCategoryItem('Variables', 'vscontext:symbols:variables', variableItems, 'symbol-variable', 'No variables'),
      ],
    );

    return symbolsNode;
  }

  private createSymbolCategoryItem(
    label: string,
    id: string,
    children: VSContextTreeItem[],
    iconName: string,
    emptyLabel: string,
  ): VSContextTreeItem {
    const category = new VSContextTreeItem(
      label,
      vscode.TreeItemCollapsibleState.Collapsed,
      id,
      children.length > 0 ? children : [new VSContextTreeItem(emptyLabel, vscode.TreeItemCollapsibleState.None, `${id}:empty`)],
    );
    category.iconPath = this.themeIcon(iconName);
    return category;
  }
}
