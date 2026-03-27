import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { type Logger } from '../utils/logger';
import { type HybridQueryResult, type QueryPlan } from '../chat/queryOrchestrator';

export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly prompt: string;
  readonly templateId: string;
  readonly createdAt: number;
  readonly lastRun: number | undefined;
  readonly runCount: number;
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly queryResult: SavedQuerySnapshot;
  readonly createdAt: number;
  readonly lastViewed: number | undefined;
  readonly viewCount: number;
}

interface SavedQuerySnapshot {
  readonly templateId: string;
  readonly prompt: string;
  readonly focusNodeId: string | undefined;
  readonly focusNodeName: string | undefined;
  readonly confidence: string;
  readonly timestamp: number;
}

export class SavedSearchManager {
  private readonly storageUri: vscode.Uri;
  private readonly logger: Logger;
  private searches: Map<string, SavedSearch> = new Map();
  private views: Map<string, SavedView> = new Map();

  constructor(context: vscode.ExtensionContext, logger: Logger) {
    this.storageUri = context.storageUri || vscode.Uri.file(path.join(context.extensionPath, '.storage'));
    this.logger = logger;
    this.ensureStorageDirectory();
    this.loadState();
  }

  private ensureStorageDirectory(): void {
    try {
      const dirPath = this.storageUri.fsPath;
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch (error) {
      this.logger.warn(`Failed to create storage directory: ${error}`);
    }
  }

  private getSearchesFile(): string {
    return path.join(this.storageUri.fsPath, 'searches.json');
  }

  private getViewsFile(): string {
    return path.join(this.storageUri.fsPath, 'views.json');
  }

  private loadState(): void {
    try {
      const searchesFile = this.getSearchesFile();
      if (fs.existsSync(searchesFile)) {
        const data = JSON.parse(fs.readFileSync(searchesFile, 'utf-8'));
        this.searches = new Map(Object.entries(data) as [string, SavedSearch][]);
      }
    } catch (error) {
      this.logger.warn(`Failed to load searches: ${error}`);
    }

    try {
      const viewsFile = this.getViewsFile();
      if (fs.existsSync(viewsFile)) {
        const data = JSON.parse(fs.readFileSync(viewsFile, 'utf-8'));
        this.views = new Map(Object.entries(data) as [string, SavedView][]);
      }
    } catch (error) {
      this.logger.warn(`Failed to load views: ${error}`);
    }
  }

  private saveState(): void {
    try {
      const searchesFile = this.getSearchesFile();
      const searchesData = Object.fromEntries(this.searches);
      fs.writeFileSync(searchesFile, JSON.stringify(searchesData, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to save searches: ${error}`);
    }

    try {
      const viewsFile = this.getViewsFile();
      const viewsData = Object.fromEntries(this.views);
      fs.writeFileSync(viewsFile, JSON.stringify(viewsData, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to save views: ${error}`);
    }
  }

  saveSearch(command: string, prompt: string, templateId: string, name?: string): SavedSearch {
    const id = `search-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const search: SavedSearch = {
      id,
      name: name || `Search at ${new Date().toLocaleString()}`,
      command,
      prompt,
      templateId,
      createdAt: Date.now(),
      lastRun: undefined,
      runCount: 0,
    };

    this.searches.set(id, search);
    this.saveState();
    this.logger.info(`[VSContext] Saved search: ${search.name}`);
    return search;
  }

  saveView(result: HybridQueryResult, name?: string): SavedView {
    const id = `view-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const snapshot: SavedQuerySnapshot = {
      templateId: result.templateId,
      prompt: result.prompt,
      focusNodeId: result.focusNode?.id,
      focusNodeName: result.focusNode?.symbolName,
      confidence: result.confidence,
      timestamp: Date.now(),
    };

    const view: SavedView = {
      id,
      name: name || `View at ${new Date().toLocaleString()}`,
      queryResult: snapshot,
      createdAt: Date.now(),
      lastViewed: undefined,
      viewCount: 0,
    };

    this.views.set(id, view);
    this.saveState();
    this.logger.info(`[VSContext] Saved view: ${view.name}`);
    return view;
  }

  updateSearchRun(searchId: string): void {
    const search = this.searches.get(searchId);
    if (search) {
      const updated: SavedSearch = {
        ...search,
        lastRun: Date.now(),
        runCount: search.runCount + 1,
      };
      this.searches.set(searchId, updated);
      this.saveState();
    }
  }

  updateViewAccess(viewId: string): void {
    const view = this.views.get(viewId);
    if (view) {
      const updated: SavedView = {
        ...view,
        lastViewed: Date.now(),
        viewCount: view.viewCount + 1,
      };
      this.views.set(viewId, updated);
      this.saveState();
    }
  }

  getSearch(searchId: string): SavedSearch | undefined {
    return this.searches.get(searchId);
  }

  getView(viewId: string): SavedView | undefined {
    return this.views.get(viewId);
  }

  getAllSearches(): SavedSearch[] {
    return Array.from(this.searches.values());
  }

  getAllViews(): SavedView[] {
    return Array.from(this.views.values());
  }

  deleteSearch(searchId: string): boolean {
    const deleted = this.searches.delete(searchId);
    if (deleted) {
      this.saveState();
      this.logger.info(`[VSContext] Deleted search: ${searchId}`);
    }
    return deleted;
  }

  deleteView(viewId: string): boolean {
    const deleted = this.views.delete(viewId);
    if (deleted) {
      this.saveState();
      this.logger.info(`[VSContext] Deleted view: ${viewId}`);
    }
    return deleted;
  }

  renameSearch(searchId: string, newName: string): boolean {
    const search = this.searches.get(searchId);
    if (search) {
      const updated: SavedSearch = { ...search, name: newName };
      this.searches.set(searchId, updated);
      this.saveState();
      return true;
    }
    return false;
  }

  renameView(viewId: string, newName: string): boolean {
    const view = this.views.get(viewId);
    if (view) {
      const updated: SavedView = { ...view, name: newName };
      this.views.set(viewId, updated);
      this.saveState();
      return true;
    }
    return false;
  }

  clearOldSearches(olderThanDays: number): number {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0;

    for (const [id, search] of this.searches.entries()) {
      if (search.createdAt < cutoffTime && search.lastRun === undefined) {
        this.searches.delete(id);
        count++;
      }
    }

    if (count > 0) {
      this.saveState();
      this.logger.info(`[VSContext] Cleared ${count} old saved searches`);
    }

    return count;
  }

  exportSearchesAsJSON(): string {
    return JSON.stringify(Array.from(this.searches.values()), null, 2);
  }

  exportViewsAsJSON(): string {
    return JSON.stringify(Array.from(this.views.values()), null, 2);
  }
}
