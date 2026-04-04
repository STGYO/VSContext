import * as vscode from 'vscode';
import { type SavedSearch, type SavedView, SavedSearchManager } from './savedSearchManager';
import { type Logger } from '../utils/logger';
import { type HybridQueryResult } from '../chat/queryOrchestrator';

type TreeNode = SavedSearchesCategory | SavedViewsCategory | SavedSearchTreeItem | SavedViewTreeItem;

function isHybridQueryResult(value: unknown): value is HybridQueryResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<HybridQueryResult>;
  return (
    typeof candidate.templateId === 'string' &&
    typeof candidate.prompt === 'string' &&
    typeof candidate.confidence === 'string'
  );
}

export class SavedSearchesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined> = new vscode.EventEmitter<TreeNode | undefined>();
  public readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this._onDidChangeTreeData.event;

  constructor(private readonly manager: SavedSearchManager, private readonly logger: Logger) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.getTreeItem();
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // Root level - show categories
      return [
        new SavedSearchesCategory(this.manager, this.logger),
        new SavedViewsCategory(this.manager, this.logger),
      ];
    }

    if (element instanceof SavedSearchesCategory) {
      const searches = this.manager.getAllSearches();
      return searches.map(search => new SavedSearchTreeItem(search, this.manager, this.logger));
    }

    if (element instanceof SavedViewsCategory) {
      const views = this.manager.getAllViews();
      return views.map(view => new SavedViewTreeItem(view, this.manager, this.logger));
    }

    return [];
  }
}

abstract class TreeNodeBase {
  abstract getTreeItem(): vscode.TreeItem;
}

class SavedSearchesCategory extends TreeNodeBase {
  constructor(private readonly manager: SavedSearchManager, private readonly logger: Logger) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Saved Searches', vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = '$(bookmark)';
    item.contextValue = 'savedSearchesCategory';

    const searches = this.manager.getAllSearches();
    item.description = `(${searches.length})`;

    return item;
  }
}

class SavedViewsCategory extends TreeNodeBase {
  constructor(private readonly manager: SavedSearchManager, private readonly logger: Logger) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Saved Views', vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = '$(layout)';
    item.contextValue = 'savedViewsCategory';

    const views = this.manager.getAllViews();
    item.description = `(${views.length})`;

    return item;
  }
}

class SavedSearchTreeItem extends TreeNodeBase {
  constructor(private readonly search: SavedSearch, private readonly manager: SavedSearchManager, private readonly logger: Logger) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.search.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = '$(search)';
    item.contextValue = 'savedSearch';

    const hints: string[] = [];
    hints.push(`/${this.search.command}`);
    if (this.search.runCount > 0) {
      hints.push(`run ${this.search.runCount}x`);
    }
    if (this.search.lastRun) {
      const daysAgo = Math.floor((Date.now() - this.search.lastRun) / (24 * 60 * 60 * 1000));
      hints.push(`${daysAgo}d ago`);
    }
    item.description = hints.join(' • ');

    item.command = {
      command: 'vscontext.executeSavedSearch',
      title: 'Execute Saved Search',
      arguments: [this.search.id],
    };

    return item;
  }
}

class SavedViewTreeItem extends TreeNodeBase {
  constructor(private readonly view: SavedView, private readonly manager: SavedSearchManager, private readonly logger: Logger) {
    super();
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.view.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = '$(preview)';
    item.contextValue = 'savedView';

    const hints: string[] = [];
    hints.push(this.view.queryResult.templateId);
    hints.push(`viewed ${this.view.viewCount}x`);
    item.description = hints.join(' • ');

    item.command = {
      command: 'vscontext.restoreSavedView',
      title: 'Restore Saved View',
      arguments: [this.view.id],
    };

    return item;
  }
}

export class SavedSearchCommandsManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SavedSearchManager,
    private readonly treeProvider: SavedSearchesTreeProvider,
    private readonly logger: Logger
  ) {
    this.registerCommands();
  }

  private registerCommands(): void {
    // Execute saved search
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.executeSavedSearch', async (searchId: string) => {
        const search = this.manager.getSearch(searchId);
        if (search) {
          this.manager.updateSearchRun(searchId);
          this.treeProvider.refresh();

          const chatCommand = `@vscontext /${search.command} ${search.prompt}`.trim();
          await vscode.commands.executeCommand('workbench.action.chat.open', chatCommand);
          this.logger.info(`[VSContext] Executed saved search: ${search.name}`);
        }
      })
    );

    // Restore saved view
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.restoreSavedView', async (viewId: string) => {
        const view = this.manager.getView(viewId);
        if (view) {
          this.manager.updateViewAccess(viewId);
          this.treeProvider.refresh();

          vscode.window.showInformationMessage(`Restored view: ${view.name}`);
          this.logger.info(`[VSContext] Restored saved view: ${view.name}`);
        }
      })
    );

    // Save current search
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.saveCurrentSearch', async (command: string, prompt: string, templateId: string) => {
        const name = await vscode.window.showInputBox({
          prompt: 'Enter name for this search',
          placeHolder: `Search at ${new Date().toLocaleTimeString()}`,
        });

        if (name) {
          this.manager.saveSearch(command, prompt, templateId, name);
          this.treeProvider.refresh();
          vscode.window.showInformationMessage(`Saved search: ${name}`);
        }
      })
    );

    // Save current view
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.saveCurrentView', async (result: unknown) => {
        const name = await vscode.window.showInputBox({
          prompt: 'Enter name for this view',
          placeHolder: `View at ${new Date().toLocaleTimeString()}`,
        });

        if (!isHybridQueryResult(result)) {
          this.logger.warn('[VSContext] saveCurrentView received an invalid query result payload.');
          vscode.window.showWarningMessage('Unable to save this view because the result payload was invalid.');
          return;
        }

        if (name) {
          this.manager.saveView(result, name);
          this.treeProvider.refresh();
          vscode.window.showInformationMessage(`Saved view: ${name}`);
        }
      })
    );

    // Rename search
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.renameSearch', async (searchId: string) => {
        const search = this.manager.getSearch(searchId);
        if (search) {
          const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name',
            value: search.name,
          });

          if (newName && newName !== search.name) {
            this.manager.renameSearch(searchId, newName);
            this.treeProvider.refresh();
          }
        }
      })
    );

    // Rename view
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.renameView', async (viewId: string) => {
        const view = this.manager.getView(viewId);
        if (view) {
          const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name',
            value: view.name,
          });

          if (newName && newName !== view.name) {
            this.manager.renameView(viewId, newName);
            this.treeProvider.refresh();
          }
        }
      })
    );

    // Delete search
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.deleteSearch', async (searchId: string) => {
        const search = this.manager.getSearch(searchId);
        if (search) {
          const confirmed = await vscode.window.showWarningMessage(
            `Delete search "${search.name}"?`,
            { modal: true },
            'Delete'
          );

          if (confirmed === 'Delete') {
            this.manager.deleteSearch(searchId);
            this.treeProvider.refresh();
          }
        }
      })
    );

    // Delete view
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.deleteView', async (viewId: string) => {
        const view = this.manager.getView(viewId);
        if (view) {
          const confirmed = await vscode.window.showWarningMessage(
            `Delete view "${view.name}"?`,
            { modal: true },
            'Delete'
          );

          if (confirmed === 'Delete') {
            this.manager.deleteView(viewId);
            this.treeProvider.refresh();
          }
        }
      })
    );

    // Export all searches
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.exportSearches', async () => {
        const json = this.manager.exportSearchesAsJSON();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file('vscontext-searches.json'),
          filters: { JSON: ['json'] },
        });

        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(json));
          vscode.window.showInformationMessage('Searches exported');
        }
      })
    );

    // Export all views
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.exportViews', async () => {
        const json = this.manager.exportViewsAsJSON();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file('vscontext-views.json'),
          filters: { JSON: ['json'] },
        });

        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(json));
          vscode.window.showInformationMessage('Views exported');
        }
      })
    );

    // Clear old searches
    this.context.subscriptions.push(
      vscode.commands.registerCommand('vscontext.clearOldSearches', async () => {
        const cleared = this.manager.clearOldSearches(30); // Older than 30 days
        this.treeProvider.refresh();
        vscode.window.showInformationMessage(`Cleared ${cleared} old searches`);
      })
    );
  }
}
