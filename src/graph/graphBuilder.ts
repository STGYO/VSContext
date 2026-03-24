import * as path from 'path';
import * as vscode from 'vscode';

import {
  deserializeIndexedSymbolMap,
  IndexedSymbol,
  SerializedIndexedSymbol,
  serializeIndexedSymbolMap,
  SymbolReferenceBuckets,
  SymbolIndexer,
  WorkspaceIndexResult,
} from './symbolIndexer';
import { Logger } from '../utils/logger';
import { getPrimaryWorkspaceFolder, toWorkspaceRelativePath } from '../utils/workspaceScanner';
import type { WorkspaceFileRoleSummary } from '../utils/fileRoleClassifier';
import { KNOWLEDGE_MODEL_VERSION, type KnowledgeNodeKind, type KnowledgeRelationshipKind } from './knowledgeModel';

export type GraphNodeType = Extract<KnowledgeNodeKind, 'class' | 'function' | 'method' | 'variable'>;

export type GraphEdgeType = Extract<KnowledgeRelationshipKind, 'calls' | 'implements' | 'reads' | 'writes'>;

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly edgeType: GraphEdgeType;
}

export interface GraphReferenceBuckets {
  reads: string[];
  writes: string[];
}

export interface GraphNode {
  readonly id: string;
  readonly symbolName: string;
  readonly symbolKind: vscode.SymbolKind;
  readonly nodeType: GraphNodeType;
  readonly filePath: string;
  readonly uriString: string;
  readonly lineNumber: number;
  readonly rangeStartLine: number;
  readonly rangeStartCharacter: number;
  readonly rangeEndLine: number;
  readonly rangeEndCharacter: number;
  outgoingCalls: string[];
  implementations: string[];
  references: GraphReferenceBuckets;
  incomingCalls: string[];
  incomingImplementations: string[];
  incomingReferences: GraphReferenceBuckets;
}

export interface WorkspaceGraph {
  readonly nodes: Map<string, GraphNode>;
  readonly fileIndex: Map<string, string[]>;
  readonly builtAt: Date | undefined;
  readonly fileRoleSummary?: WorkspaceFileRoleSummary;
}

interface SerializedGraphNode {
  readonly id: string;
  readonly symbolName: string;
  readonly symbolKind: number;
  readonly filePath: string;
  readonly uriString: string;
  readonly lineNumber: number;
  readonly rangeStartLine: number;
  readonly rangeStartCharacter: number;
  readonly rangeEndLine: number;
  readonly rangeEndCharacter: number;
  readonly outgoingCalls: string[];
  readonly implementations: string[];
  readonly referenceReads: string[];
  readonly referenceWrites: string[];
}

interface SerializedWorkspaceGraphSnapshot {
  readonly version: number;
  readonly knowledgeModelVersion: number;
  readonly workspaceFolderUri: string | undefined;
  readonly savedAtIso: string;
  readonly builtAtIso: string | undefined;
  readonly fileRoleSummary?: WorkspaceFileRoleSummary;
  readonly nodes: SerializedGraphNode[];
  readonly symbolCache: SerializedIndexedSymbol[];
  readonly fileModifiedTimes: Record<string, number>;
}

const GRAPH_CACHE_VERSION = 3;
const PERSIST_DEBOUNCE_MS = 800;

export class WorkspaceGraphBuilder {
  private cachedGraph: WorkspaceGraph = {
    nodes: new Map<string, GraphNode>(),
    fileIndex: new Map<string, string[]>(),
    builtAt: undefined,
    fileRoleSummary: undefined,
  };

  private dirty = true;
  private initialIndexCompleted = false;
  private buildPromise: Promise<WorkspaceGraph> | undefined;
  private symbolCache = new Map<string, IndexedSymbol>();
  private fileModifiedTimes = new Map<string, number>();
  private persistTimer: NodeJS.Timeout | undefined;
  private persistQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly indexer: SymbolIndexer,
    private readonly logger: Logger,
    private readonly cacheFileUri?: vscode.Uri,
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

  public getTrackedFileModifiedTimes(): ReadonlyMap<string, number> {
    return new Map<string, number>(this.fileModifiedTimes);
  }

  public async hydrateFromCache(): Promise<boolean> {
    if (!this.cacheFileUri) {
      return false;
    }

    let rawContent: Uint8Array;
    try {
      rawContent = await vscode.workspace.fs.readFile(this.cacheFileUri);
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return false;
      }

      this.logger.warn(`Unable to read VSContext graph cache. Falling back to full rebuild. ${String(error)}`);
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(rawContent).toString('utf8'));
    } catch {
      this.logger.warn('VSContext graph cache is not valid JSON. Falling back to full rebuild.');
      return false;
    }

    const snapshot = this.parseSnapshot(parsed);
    if (!snapshot) {
      this.logger.warn('VSContext graph cache schema is invalid. Falling back to full rebuild.');
      return false;
    }

    const currentWorkspaceUri = getPrimaryWorkspaceFolder()?.uri.toString();
    if (snapshot.workspaceFolderUri && currentWorkspaceUri && snapshot.workspaceFolderUri !== currentWorkspaceUri) {
      return false;
    }

    const nodeMap = new Map<string, GraphNode>();
    for (const serializedNode of snapshot.nodes) {
      const node = this.deserializeNode(serializedNode);
      if (!node) {
        continue;
      }

      nodeMap.set(node.id, node);
    }

    this.trimDanglingRelationshipsFor(nodeMap);
    this.populateIncomingRelationships(nodeMap);

    const restoredSymbolCache = deserializeIndexedSymbolMap(snapshot.symbolCache);
    for (const node of nodeMap.values()) {
      if (!restoredSymbolCache.has(node.id)) {
        restoredSymbolCache.set(node.id, this.toIndexedSymbolFromNode(node));
      }
    }

    for (const symbolId of [...restoredSymbolCache.keys()]) {
      if (!nodeMap.has(symbolId)) {
        restoredSymbolCache.delete(symbolId);
      }
    }

    const builtAt = snapshot.builtAtIso ? new Date(snapshot.builtAtIso) : undefined;
    const isBuiltAtValid = builtAt && !Number.isNaN(builtAt.getTime());

    this.cachedGraph = {
      nodes: nodeMap,
      fileIndex: this.createFileIndex(nodeMap),
      builtAt: isBuiltAtValid ? builtAt : undefined,
      fileRoleSummary: snapshot.fileRoleSummary,
    };
    this.symbolCache = restoredSymbolCache;
    this.fileModifiedTimes = this.deserializeFileModifiedTimes(snapshot.fileModifiedTimes);
    this.initialIndexCompleted = true;
    this.dirty = false;

    const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);
    this.logger.info(`Hydrated workspace graph from cache with ${nodeMap.size} nodes and ${edgeCount} edges.`);
    return true;
  }

  public async flushPersistence(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    await this.enqueuePersistence();
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
    const modifiedAt = await this.getFileModifiedTime(uri);
    this.removeFileSymbols(filePath);

    const symbols = await this.indexer.indexDocumentSymbols(uri);
    for (const symbol of symbols) {
      this.symbolCache.set(symbol.id, symbol);
      this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
    }

    await this.populateNodeRelationshipsForSymbols([...this.symbolCache.values()]);
    this.trimDanglingRelationships();
    this.rebuildFileIndex();
    this.populateIncomingRelationships(this.cachedGraph.nodes);
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      builtAt: new Date(),
    };
    if (modifiedAt !== undefined) {
      this.fileModifiedTimes.set(filePath, modifiedAt);
    }
    this.dirty = false;
    this.schedulePersistence();
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
    this.fileModifiedTimes.delete(filePath);
    this.trimDanglingRelationships();
    this.rebuildFileIndex();
    this.populateIncomingRelationships(this.cachedGraph.nodes);
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      builtAt: new Date(),
    };
    this.dirty = false;
    this.schedulePersistence();
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

      await this.populateNodeRelationshipsForSymbols([...indexedSymbols.values()], nodeMap);

      this.populateIncomingRelationships(nodeMap);

      const fileIndex = this.createFileIndex(nodeMap);
      const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);

      this.cachedGraph = {
        nodes: nodeMap,
        fileIndex,
        builtAt: new Date(),
        fileRoleSummary: indexResult.fileRoleSummary,
      };

      await this.refreshTrackedFileModifiedTimes(indexResult.scannedFiles);

      this.initialIndexCompleted = true;
      this.dirty = false;
      this.logIndexingSummary(indexResult);
      this.logger.info(`Workspace graph built with ${nodeMap.size} nodes and ${edgeCount} edges.`);
      this.schedulePersistence();
      return this.cachedGraph;
    } catch (error) {
      this.logger.error('Workspace graph build failed.', error);
      this.cachedGraph = {
        nodes: new Map<string, GraphNode>(),
        fileIndex: new Map<string, string[]>(),
        builtAt: new Date(),
        fileRoleSummary: undefined,
      };
      this.symbolCache = new Map<string, IndexedSymbol>();
      this.fileModifiedTimes = new Map<string, number>();
      this.initialIndexCompleted = true;
      this.dirty = false;
      this.schedulePersistence();
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
        nodeType: this.resolveNodeType(symbol.symbolKind),
        filePath: symbol.filePath,
        uriString: symbol.uri.toString(),
        lineNumber: symbol.lineNumber,
        rangeStartLine: symbol.range.start.line + 1,
        rangeStartCharacter: symbol.range.start.character,
        rangeEndLine: symbol.range.end.line + 1,
        rangeEndCharacter: symbol.range.end.character,
        outgoingCalls: [],
        implementations: [],
        references: this.emptyReferenceBuckets(),
        incomingCalls: [],
        incomingImplementations: [],
        incomingReferences: this.emptyReferenceBuckets(),
      });

      this.logGraphNodeCreation(symbol);
    }

    return nodeMap;
  }

  private toGraphNode(symbol: IndexedSymbol): GraphNode {
    return {
      id: symbol.id,
      symbolName: symbol.symbolName,
      symbolKind: symbol.symbolKind,
      nodeType: this.resolveNodeType(symbol.symbolKind),
      filePath: symbol.filePath,
      uriString: symbol.uri.toString(),
      lineNumber: symbol.lineNumber,
      rangeStartLine: symbol.range.start.line + 1,
      rangeStartCharacter: symbol.range.start.character,
      rangeEndLine: symbol.range.end.line + 1,
      rangeEndCharacter: symbol.range.end.character,
      outgoingCalls: [],
      implementations: [],
      references: this.emptyReferenceBuckets(),
      incomingCalls: [],
      incomingImplementations: [],
      incomingReferences: this.emptyReferenceBuckets(),
    };
  }

  private async populateNodeRelationshipsForSymbols(
    symbols: IndexedSymbol[],
    targetNodes: Map<string, GraphNode> = this.cachedGraph.nodes,
  ): Promise<void> {
    for (const node of targetNodes.values()) {
      node.outgoingCalls = [];
      node.implementations = [];
      node.references = this.emptyReferenceBuckets();
    }

    let processed = 0;

    for (const symbol of symbols) {
      const node = targetNodes.get(symbol.id);
      if (!node) {
        continue;
      }

      if (this.isCallableSymbol(symbol.symbolKind)) {
        const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
        node.outgoingCalls = outgoing.filter((targetId) => targetNodes.has(targetId) && targetId !== symbol.id);
      }

      const implementations = await this.indexer.resolveImplementations(symbol, this.symbolCache);
      node.implementations = implementations.filter((targetId) => targetNodes.has(targetId) && targetId !== symbol.id);

      if (this.isVariableLikeSymbol(symbol.symbolKind)) {
        const variableReferences = await this.indexer.resolveVariableReferences(symbol, this.symbolCache);
        const filteredReferences = this.filterReferenceBuckets(variableReferences, targetNodes, symbol.id);

        for (const sourceNodeId of filteredReferences.reads) {
          const sourceNode = targetNodes.get(sourceNodeId);
          if (!sourceNode || sourceNode.references.reads.includes(symbol.id)) {
            continue;
          }

          sourceNode.references.reads.push(symbol.id);
        }

        for (const sourceNodeId of filteredReferences.writes) {
          const sourceNode = targetNodes.get(sourceNodeId);
          if (!sourceNode || sourceNode.references.writes.includes(symbol.id)) {
            continue;
          }

          sourceNode.references.writes.push(symbol.id);
        }
      }

      processed += 1;
      if (processed % 25 === 0) {
        await this.yieldToEventLoop();
      }
    }
  }

  private populateIncomingRelationships(nodeMap: Map<string, GraphNode>): void {
    for (const node of nodeMap.values()) {
      node.incomingCalls = [];
      node.incomingImplementations = [];
      node.incomingReferences = this.emptyReferenceBuckets();
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

      for (const implementationId of node.implementations) {
        const target = nodeMap.get(implementationId);
        if (!target) {
          continue;
        }

        if (!target.incomingImplementations.includes(node.id)) {
          target.incomingImplementations.push(node.id);
        }
      }

      for (const readId of node.references.reads) {
        const target = nodeMap.get(readId);
        if (!target) {
          continue;
        }

        if (!target.incomingReferences.reads.includes(node.id)) {
          target.incomingReferences.reads.push(node.id);
        }
      }

      for (const writeId of node.references.writes) {
        const target = nodeMap.get(writeId);
        if (!target) {
          continue;
        }

        if (!target.incomingReferences.writes.includes(node.id)) {
          target.incomingReferences.writes.push(node.id);
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

  private trimDanglingRelationships(): void {
    for (const node of this.cachedGraph.nodes.values()) {
      node.outgoingCalls = node.outgoingCalls.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
      node.implementations = node.implementations.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
      node.references.reads = node.references.reads.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
      node.references.writes = node.references.writes.filter((targetId) => this.cachedGraph.nodes.has(targetId) && targetId !== node.id);
    }
  }

  private rebuildFileIndex(): void {
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.createFileIndex(this.cachedGraph.nodes),
      builtAt: this.cachedGraph.builtAt,
    };
  }

  private schedulePersistence(): void {
    if (!this.cacheFileUri || !this.initialIndexCompleted) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.enqueuePersistence();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async enqueuePersistence(): Promise<void> {
    if (!this.cacheFileUri || !this.initialIndexCompleted) {
      return;
    }

    this.persistQueue = this.persistQueue
      .then(async () => {
        await this.persistSnapshot();
      })
      .catch((error) => {
        this.logger.warn(`Unable to persist VSContext graph cache. ${String(error)}`);
      });

    await this.persistQueue;
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.cacheFileUri) {
      return;
    }

    const directoryUri = vscode.Uri.file(path.dirname(this.cacheFileUri.fsPath));
    await vscode.workspace.fs.createDirectory(directoryUri);

    const snapshot: SerializedWorkspaceGraphSnapshot = {
      version: GRAPH_CACHE_VERSION,
      knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
      workspaceFolderUri: getPrimaryWorkspaceFolder()?.uri.toString(),
      savedAtIso: new Date().toISOString(),
      builtAtIso: this.cachedGraph.builtAt?.toISOString(),
      fileRoleSummary: this.cachedGraph.fileRoleSummary,
      nodes: [...this.cachedGraph.nodes.values()].map((node) => this.serializeNode(node)),
      symbolCache: serializeIndexedSymbolMap(this.symbolCache),
      fileModifiedTimes: Object.fromEntries(this.fileModifiedTimes.entries()),
    };

    const payload = Buffer.from(JSON.stringify(snapshot), 'utf8');
    await vscode.workspace.fs.writeFile(this.cacheFileUri, payload);
  }

  private parseSnapshot(value: unknown): SerializedWorkspaceGraphSnapshot | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Partial<SerializedWorkspaceGraphSnapshot>;
    if (candidate.version !== GRAPH_CACHE_VERSION) {
      return undefined;
    }

    if (candidate.knowledgeModelVersion !== KNOWLEDGE_MODEL_VERSION) {
      return undefined;
    }

    if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.symbolCache)) {
      return undefined;
    }

    if (!candidate.fileModifiedTimes || typeof candidate.fileModifiedTimes !== 'object') {
      return undefined;
    }

    const safeWorkspaceUri = typeof candidate.workspaceFolderUri === 'string' ? candidate.workspaceFolderUri : undefined;
    const safeSavedAtIso = typeof candidate.savedAtIso === 'string' ? candidate.savedAtIso : '';
    if (!safeSavedAtIso) {
      return undefined;
    }

    const safeBuiltAtIso = typeof candidate.builtAtIso === 'string' ? candidate.builtAtIso : undefined;
    const fileRoleSummary = this.parseFileRoleSummary(candidate.fileRoleSummary);

    return {
      version: candidate.version,
      knowledgeModelVersion: candidate.knowledgeModelVersion,
      workspaceFolderUri: safeWorkspaceUri,
      savedAtIso: safeSavedAtIso,
      builtAtIso: safeBuiltAtIso,
      fileRoleSummary,
      nodes: candidate.nodes as SerializedGraphNode[],
      symbolCache: candidate.symbolCache as SerializedIndexedSymbol[],
      fileModifiedTimes: candidate.fileModifiedTimes as Record<string, number>,
    };
  }

  private parseFileRoleSummary(value: unknown): WorkspaceFileRoleSummary | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Partial<WorkspaceFileRoleSummary>;
    if (
      typeof candidate.source !== 'number'
      || typeof candidate.test !== 'number'
      || typeof candidate.documentation !== 'number'
      || typeof candidate.template !== 'number'
      || typeof candidate.other !== 'number'
    ) {
      return undefined;
    }

    return {
      source: candidate.source,
      test: candidate.test,
      documentation: candidate.documentation,
      template: candidate.template,
      other: candidate.other,
    };
  }

  private serializeNode(node: GraphNode): SerializedGraphNode {
    return {
      id: node.id,
      symbolName: node.symbolName,
      symbolKind: node.symbolKind,
      filePath: node.filePath,
      uriString: node.uriString,
      lineNumber: node.lineNumber,
      rangeStartLine: node.rangeStartLine,
      rangeStartCharacter: node.rangeStartCharacter,
      rangeEndLine: node.rangeEndLine,
      rangeEndCharacter: node.rangeEndCharacter,
      outgoingCalls: [...node.outgoingCalls],
      implementations: [...node.implementations],
      referenceReads: [...node.references.reads],
      referenceWrites: [...node.references.writes],
    };
  }

  private deserializeNode(node: SerializedGraphNode): GraphNode | undefined {
    if (!node || typeof node !== 'object') {
      return undefined;
    }

    if (
      typeof node.id !== 'string'
      || typeof node.symbolName !== 'string'
      || typeof node.symbolKind !== 'number'
      || typeof node.filePath !== 'string'
      || typeof node.uriString !== 'string'
      || typeof node.lineNumber !== 'number'
      || typeof node.rangeStartLine !== 'number'
      || typeof node.rangeStartCharacter !== 'number'
      || typeof node.rangeEndLine !== 'number'
      || typeof node.rangeEndCharacter !== 'number'
      || !Array.isArray(node.outgoingCalls)
      || !Array.isArray(node.implementations)
      || !Array.isArray(node.referenceReads)
      || !Array.isArray(node.referenceWrites)
    ) {
      return undefined;
    }

    const outgoingCalls = node.outgoingCalls.filter((entry) => typeof entry === 'string');
    const implementations = node.implementations.filter((entry) => typeof entry === 'string');
    const referenceReads = node.referenceReads.filter((entry) => typeof entry === 'string');
    const referenceWrites = node.referenceWrites.filter((entry) => typeof entry === 'string');

    return {
      id: node.id,
      symbolName: node.symbolName,
      symbolKind: node.symbolKind,
      nodeType: this.resolveNodeType(node.symbolKind),
      filePath: node.filePath,
      uriString: node.uriString,
      lineNumber: node.lineNumber,
      rangeStartLine: node.rangeStartLine,
      rangeStartCharacter: node.rangeStartCharacter,
      rangeEndLine: node.rangeEndLine,
      rangeEndCharacter: node.rangeEndCharacter,
      outgoingCalls,
      implementations,
      references: {
        reads: referenceReads,
        writes: referenceWrites,
      },
      incomingCalls: [],
      incomingImplementations: [],
      incomingReferences: this.emptyReferenceBuckets(),
    };
  }

  private deserializeFileModifiedTimes(value: Record<string, number>): Map<string, number> {
    const map = new Map<string, number>();

    for (const [filePath, modifiedAt] of Object.entries(value)) {
      if (typeof filePath !== 'string' || typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt)) {
        continue;
      }

      map.set(filePath, modifiedAt);
    }

    return map;
  }

  private toIndexedSymbolFromNode(node: GraphNode): IndexedSymbol {
    const uri = vscode.Uri.parse(node.uriString);
    const range = new vscode.Range(
      Math.max(0, node.rangeStartLine - 1),
      Math.max(0, node.rangeStartCharacter),
      Math.max(0, node.rangeEndLine - 1),
      Math.max(0, node.rangeEndCharacter),
    );

    return {
      id: node.id,
      symbolName: node.symbolName,
      symbolKind: node.symbolKind,
      uri,
      filePath: node.filePath,
      lineNumber: node.lineNumber,
      range,
    };
  }

  private trimDanglingRelationshipsFor(nodeMap: Map<string, GraphNode>): void {
    for (const node of nodeMap.values()) {
      node.outgoingCalls = node.outgoingCalls.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
      node.implementations = node.implementations.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
      node.references.reads = node.references.reads.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
      node.references.writes = node.references.writes.filter((targetId) => nodeMap.has(targetId) && targetId !== node.id);
    }
  }

  private async refreshTrackedFileModifiedTimes(uris: readonly vscode.Uri[]): Promise<void> {
    const next = new Map<string, number>();
    let processed = 0;

    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        continue;
      }

      const modifiedAt = await this.getFileModifiedTime(uri);
      if (modifiedAt !== undefined) {
        next.set(toWorkspaceRelativePath(uri), modifiedAt);
      }

      processed += 1;
      if (processed % 50 === 0) {
        await this.yieldToEventLoop();
      }
    }

    this.fileModifiedTimes = next;
  }

  private async getFileModifiedTime(uri: vscode.Uri): Promise<number | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.mtime;
    } catch {
      return undefined;
    }
  }

  private isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
      return /not found|enoent/i.test(error.message);
    }

    return false;
  }

  private logIndexingSummary(indexResult: WorkspaceIndexResult): void {
    this.logger.info(`[VSContext] Indexed ${indexResult.scannedFileCount} files.`);
    this.logger.info(`[VSContext] Indexed ${indexResult.indexedSymbolCount} symbols.`);
    this.logger.info(`[VSContext] Skipped dependency directories: ${indexResult.skippedByExclusions} files.`);
    this.logger.info(
      `[VSContext] File roles: source=${indexResult.fileRoleSummary.source}, test=${indexResult.fileRoleSummary.test}, documentation=${indexResult.fileRoleSummary.documentation}, template=${indexResult.fileRoleSummary.template}, other=${indexResult.fileRoleSummary.other}.`,
    );
  }

  private resolveNodeType(kind: vscode.SymbolKind): GraphNodeType {
    if (kind === vscode.SymbolKind.Class) {
      return 'class';
    }

    if (kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Constructor) {
      return 'method';
    }

    if (
      kind === vscode.SymbolKind.Variable
      || kind === vscode.SymbolKind.Constant
      || kind === vscode.SymbolKind.Field
      || kind === vscode.SymbolKind.Property
    ) {
      return 'variable';
    }

    return 'function';
  }

  private isCallableSymbol(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Function || kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Constructor;
  }

  private isVariableLikeSymbol(kind: vscode.SymbolKind): boolean {
    return (
      kind === vscode.SymbolKind.Variable
      || kind === vscode.SymbolKind.Constant
      || kind === vscode.SymbolKind.Field
      || kind === vscode.SymbolKind.Property
    );
  }

  private filterReferenceBuckets(
    references: SymbolReferenceBuckets,
    targetNodes: Map<string, GraphNode>,
    symbolId: string,
  ): GraphReferenceBuckets {
    return {
      reads: references.reads.filter((sourceId) => targetNodes.has(sourceId) && sourceId !== symbolId),
      writes: references.writes.filter((sourceId) => targetNodes.has(sourceId) && sourceId !== symbolId),
    };
  }

  private emptyReferenceBuckets(): GraphReferenceBuckets {
    return {
      reads: [],
      writes: [],
    };
  }

  private relationshipCountForNode(node: GraphNode): number {
    return node.outgoingCalls.length
      + node.implementations.length
      + node.references.reads.length
      + node.references.writes.length;
  }

  private logGraphNodeCreation(symbol: IndexedSymbol): void {
    if (!this.isSymbolDebugEnabled()) {
      return;
    }

    const kindLabel = (vscode.SymbolKind as unknown as Record<number, string>)[symbol.symbolKind] ?? symbol.symbolKind.toString();
    this.logger.info(`[VSContext][debug] Creating graph node: ${symbol.symbolName} (${kindLabel})`);
  }

  private isSymbolDebugEnabled(): boolean {
    return vscode.workspace.getConfiguration('vscontext').get<boolean>('debugSymbolDetection', false);
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
