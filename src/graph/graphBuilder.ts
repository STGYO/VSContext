import * as vscode from 'vscode';

import { IndexedSymbol, SymbolIndexer, WorkspaceIndexResult } from './symbolIndexer';
import { Logger } from '../utils/logger';
import { toWorkspaceRelativePath } from '../utils/workspaceScanner';

export interface GraphNode {
  readonly id: string;
  readonly symbolName: string;
  readonly symbolKind: vscode.SymbolKind;
  readonly filePath: string;
  readonly uriString: string;
  readonly lineNumber: number;
  readonly rangeStartLine: number;
  readonly rangeEndLine: number;
  outgoingCalls: string[];
  incomingCalls: string[];
}

export interface WorkspaceGraph {
  readonly nodes: Map<string, GraphNode>;
  readonly fileIndex: Map<string, string[]>;
  readonly builtAt: Date | undefined;
}

export class WorkspaceGraphBuilder {
  private cachedGraph: WorkspaceGraph = {
    nodes: new Map<string, GraphNode>(),
    fileIndex: new Map<string, string[]>(),
    builtAt: undefined,
  };

  private dirty = true;
  private initialIndexCompleted = false;
  private buildPromise: Promise<WorkspaceGraph> | undefined;
  private symbolCache = new Map<string, IndexedSymbol>();

  public constructor(
    private readonly indexer: SymbolIndexer,
    private readonly logger: Logger,
  ) {}

  public markDirty(): void {
    this.dirty = true;
  }

  public isIndexing(): boolean {
    return this.buildPromise !== undefined;
  }

  public hasCompletedInitialIndex(): boolean {
    return this.initialIndexCompleted;
  }

  public peekGraph(): WorkspaceGraph {
    return this.cachedGraph;
  }

  public getNode(nodeId: string): GraphNode | undefined {
    return this.cachedGraph.nodes.get(nodeId);
  }

  public async getGraph(): Promise<WorkspaceGraph> {
    if (!this.dirty) {
      return this.cachedGraph;
    }

    return this.buildWorkspaceGraph();
  }

  public async ensureDocumentIndexed(uri: vscode.Uri): Promise<void> {
    if (this.isIndexing()) {
      return;
    }

    const filePath = toWorkspaceRelativePath(uri);
    if (this.cachedGraph.fileIndex.has(filePath)) {
      return;
    }

    await this.upsertDocument(uri);
  }

  public async upsertDocument(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }

    if (!this.initialIndexCompleted) {
      return;
    }

    const filePath = toWorkspaceRelativePath(uri);
    this.removeFileSymbols(filePath);

    const symbols = await this.indexer.indexDocumentSymbols(uri);
    for (const symbol of symbols) {
      this.symbolCache.set(symbol.id, symbol);
      this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
    }

    await this.populateOutgoingCallsForSymbols(symbols);
    this.trimDanglingOutgoingEdges();
    this.rebuildFileIndex();
    this.populateIncomingCalls(this.cachedGraph.nodes);
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      builtAt: new Date(),
    };
    this.dirty = false;
  }

  public async removeDocument(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }

    if (!this.initialIndexCompleted) {
      return;
    }

    const filePath = toWorkspaceRelativePath(uri);
    this.removeFileSymbols(filePath);
    this.trimDanglingOutgoingEdges();
    this.rebuildFileIndex();
    this.populateIncomingCalls(this.cachedGraph.nodes);
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      builtAt: new Date(),
    };
    this.dirty = false;
  }

  public async buildWorkspaceGraph(): Promise<WorkspaceGraph> {
    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = this.doBuildWorkspaceGraph();
    try {
      return await this.buildPromise;
    } finally {
      this.buildPromise = undefined;
    }
  }

  private async doBuildWorkspaceGraph(): Promise<WorkspaceGraph> {
    this.logger.info('Building workspace graph.');

    try {
      const indexResult = await this.indexer.indexWorkspaceSymbols();
      const indexedSymbols = indexResult.indexed;
      this.symbolCache = new Map<string, IndexedSymbol>(indexedSymbols);
      const nodeMap = this.createNodeMap(indexedSymbols);

      await this.populateOutgoingCallsForSymbols([...indexedSymbols.values()], nodeMap);

      this.populateIncomingCalls(nodeMap);

      const fileIndex = this.createFileIndex(nodeMap);
      const edgeCount = [...nodeMap.values()].reduce((count, node) => count + node.outgoingCalls.length, 0);

      this.cachedGraph = {
        nodes: nodeMap,
        fileIndex,
        builtAt: new Date(),
      };

      this.initialIndexCompleted = true;
      this.dirty = false;
      this.logIndexingSummary(indexResult);
      this.logger.info(`Workspace graph built with ${nodeMap.size} nodes and ${edgeCount} edges.`);
      return this.cachedGraph;
    } catch (error) {
      this.logger.error('Workspace graph build failed.', error);
      this.cachedGraph = {
        nodes: new Map<string, GraphNode>(),
        fileIndex: new Map<string, string[]>(),
        builtAt: new Date(),
      };
      this.initialIndexCompleted = true;
      this.dirty = false;
      return this.cachedGraph;
    }
  }

  private createNodeMap(indexedSymbols: Map<string, IndexedSymbol>): Map<string, GraphNode> {
    const nodeMap = new Map<string, GraphNode>();

    for (const symbol of indexedSymbols.values()) {
      nodeMap.set(symbol.id, {
        id: symbol.id,
        symbolName: symbol.symbolName,
        symbolKind: symbol.symbolKind,
        filePath: symbol.filePath,
        uriString: symbol.uri.toString(),
        lineNumber: symbol.lineNumber,
        rangeStartLine: symbol.range.start.line + 1,
        rangeEndLine: symbol.range.end.line + 1,
        outgoingCalls: [],
        incomingCalls: [],
      });
    }

    return nodeMap;
  }

  private toGraphNode(symbol: IndexedSymbol): GraphNode {
    return {
      id: symbol.id,
      symbolName: symbol.symbolName,
      symbolKind: symbol.symbolKind,
      filePath: symbol.filePath,
      uriString: symbol.uri.toString(),
      lineNumber: symbol.lineNumber,
      rangeStartLine: symbol.range.start.line + 1,
      rangeEndLine: symbol.range.end.line + 1,
      outgoingCalls: [],
      incomingCalls: [],
    };
  }

  private async populateOutgoingCallsForSymbols(
    symbols: IndexedSymbol[],
    targetNodes: Map<string, GraphNode> = this.cachedGraph.nodes,
  ): Promise<void> {
    let processed = 0;

    for (const symbol of symbols) {
      const node = targetNodes.get(symbol.id);
      if (!node) {
        continue;
      }

      const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
      node.outgoingCalls = outgoing.filter((targetId) => targetNodes.has(targetId));

      processed += 1;
      if (processed % 25 === 0) {
        await this.yieldToEventLoop();
      }
    }
  }

  private populateIncomingCalls(nodeMap: Map<string, GraphNode>): void {
    for (const node of nodeMap.values()) {
      node.incomingCalls = [];
    }

    for (const node of nodeMap.values()) {
      for (const outgoingId of node.outgoingCalls) {
        const target = nodeMap.get(outgoingId);
        if (!target) {
          continue;
        }

        if (!target.incomingCalls.includes(node.id)) {
          target.incomingCalls.push(node.id);
        }
      }
    }
  }

  private createFileIndex(nodeMap: Map<string, GraphNode>): Map<string, string[]> {
    const fileIndex = new Map<string, string[]>();

    for (const node of nodeMap.values()) {
      const existing = fileIndex.get(node.filePath) ?? [];
      existing.push(node.id);
      fileIndex.set(node.filePath, existing);
    }

    for (const [filePath, nodeIds] of fileIndex) {
      const sorted = [...nodeIds].sort((left, right) => {
        const leftNode = nodeMap.get(left);
        const rightNode = nodeMap.get(right);

        if (!leftNode || !rightNode) {
          return left.localeCompare(right);
        }

        return leftNode.lineNumber - rightNode.lineNumber;
      });

      fileIndex.set(filePath, sorted);
    }

    return fileIndex;
  }

  private removeFileSymbols(filePath: string): void {
    const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
    for (const nodeId of existingIds) {
      this.cachedGraph.nodes.delete(nodeId);
      this.symbolCache.delete(nodeId);
    }

    this.cachedGraph.fileIndex.delete(filePath);
  }

  private trimDanglingOutgoingEdges(): void {
    for (const node of this.cachedGraph.nodes.values()) {
      node.outgoingCalls = node.outgoingCalls.filter((targetId) => this.cachedGraph.nodes.has(targetId));
    }
  }

  private rebuildFileIndex(): void {
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.createFileIndex(this.cachedGraph.nodes),
      builtAt: this.cachedGraph.builtAt,
    };
  }

  private logIndexingSummary(indexResult: WorkspaceIndexResult): void {
    this.logger.info(`[VSContext] Indexed ${indexResult.scannedFileCount} files.`);
    this.logger.info(`[VSContext] Indexed ${indexResult.indexedSymbolCount} symbols.`);
    this.logger.info(`[VSContext] Skipped dependency directories: ${indexResult.skippedByExclusions} files.`);
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
