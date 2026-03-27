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
import { classifyWorkspaceFile, type WorkspaceFileRole, type WorkspaceFileRoleSummary } from '../utils/fileRoleClassifier';
import { getPrimaryWorkspaceFolder, toWorkspaceRelativePath } from '../utils/workspaceScanner';
import { KNOWLEDGE_MODEL_VERSION, type KnowledgeNodeKind, type KnowledgeRelationshipKind } from './knowledgeModel';
import { CacheVersionManager } from '../indexing/indexTelemetry';

export type GraphNodeType = Extract<KnowledgeNodeKind, 'class' | 'function' | 'method' | 'variable'>;

export type GraphEdgeType = Extract<KnowledgeRelationshipKind, 'calls' | 'implements' | 'reads' | 'writes'>;

export type WorkspaceFileRelationshipType = Extract<KnowledgeRelationshipKind, 'imports' | 'covers' | 'documents' | 'related-to'>;

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly edgeType: GraphEdgeType;
}

export interface GraphReferenceBuckets {
  reads: string[];
  writes: string[];
}

export interface WorkspaceFileRelationship {
  readonly sourceFilePath: string;
  readonly targetFilePath: string;
  readonly sourceUriString: string;
  readonly targetUriString: string;
  readonly relationship: WorkspaceFileRelationshipType;
}

interface FileRelationshipRecord {
  readonly sourceId: string;
  readonly targetId: string;
  readonly edgeType: GraphEdgeType;
  readonly sourceFilePath: string;
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
  readonly fileRelationships: WorkspaceFileRelationship[];
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
  readonly fileRelationships: WorkspaceFileRelationship[];
  readonly nodes: SerializedGraphNode[];
  readonly symbolCache: SerializedIndexedSymbol[];
  readonly fileModifiedTimes: Record<string, number>;
}

const GRAPH_CACHE_VERSION = CacheVersionManager.GRAPH_CACHE_VERSION;
const PERSIST_DEBOUNCE_MS = 800;

export class WorkspaceGraphBuilder {
  private cachedGraph: WorkspaceGraph = {
    nodes: new Map<string, GraphNode>(),
    fileIndex: new Map<string, string[]>(),
    fileRelationships: [],
    builtAt: undefined,
    fileRoleSummary: undefined,
  };

  private dirty = true;
  private initialIndexCompleted = false;
  private buildPromise: Promise<WorkspaceGraph> | undefined;
  private symbolCache = new Map<string, IndexedSymbol>();
  private fileModifiedTimes = new Map<string, number>();
  private fileRelationshipIndex = new Map<string, FileRelationshipRecord[]>();
  private supplementaryFileRelationshipIndex = new Map<string, WorkspaceFileRelationship[]>();
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
      fileRelationships: this.deserializeWorkspaceFileRelationships(snapshot.fileRelationships),
      builtAt: isBuiltAtValid ? builtAt : undefined,
      fileRoleSummary: snapshot.fileRoleSummary,
    };
    this.symbolCache = restoredSymbolCache;
    this.fileModifiedTimes = this.deserializeFileModifiedTimes(snapshot.fileModifiedTimes);
    this.rebuildFileRelationshipIndex(nodeMap);
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
    const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
    for (const nodeId of existingIds) {
      const node = this.cachedGraph.nodes.get(nodeId);
      if (!node) {
        continue;
      }

      this.removeIncomingRelationshipsForNode(node);
    }

    this.clearRelationshipsForFile(filePath);
    this.removeFileSymbols(filePath);
    this.supplementaryFileRelationshipIndex.delete(filePath);

    const symbols = await this.indexer.indexDocumentSymbols(uri);
    for (const symbol of symbols) {
      this.symbolCache.set(symbol.id, symbol);
      this.cachedGraph.nodes.set(symbol.id, this.toGraphNode(symbol));
    }

    await this.populateNodeRelationshipsForSymbols(symbols);
    const role = classifyWorkspaceFile(uri);
    const relationships = await this.extractSupplementaryFileRelationships(
      uri,
      role,
      this.collectKnownFilePaths(),
      this.collectKnownFileUriLookup(),
    );
    if (relationships.length > 0) {
      this.supplementaryFileRelationshipIndex.set(filePath, relationships);
    }

    this.rebuildFileIndex();
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      fileRelationships: this.flattenSupplementaryFileRelationships(),
      builtAt: new Date(),
      fileRoleSummary: this.cachedGraph.fileRoleSummary,
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
    this.clearRelationshipsForFile(filePath);
    this.supplementaryFileRelationshipIndex.delete(filePath);

    const existingIds = this.cachedGraph.fileIndex.get(filePath) ?? [];
    for (const nodeId of existingIds) {
      const node = this.cachedGraph.nodes.get(nodeId);
      if (!node) {
        continue;
      }

      this.removeIncomingRelationshipsForNode(node);
    }

    this.removeFileSymbols(filePath);
    this.fileModifiedTimes.delete(filePath);
    this.rebuildFileIndex();
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      fileRelationships: this.flattenSupplementaryFileRelationships(),
      builtAt: new Date(),
      fileRoleSummary: this.cachedGraph.fileRoleSummary,
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
      this.fileRelationshipIndex = new Map<string, FileRelationshipRecord[]>();
      this.supplementaryFileRelationshipIndex = new Map<string, WorkspaceFileRelationship[]>();
      const indexResult = await this.indexer.indexWorkspaceSymbols();
      const indexedSymbols = indexResult.indexed;
      this.symbolCache = new Map<string, IndexedSymbol>(indexedSymbols);
      const nodeMap = this.createNodeMap(indexedSymbols);

      await this.populateNodeRelationshipsForSymbols([...indexedSymbols.values()], nodeMap);
      await this.rebuildSupplementaryFileRelationships(indexResult.filesByRole);

      const fileIndex = this.createFileIndex(nodeMap);
      const edgeCount = [...nodeMap.values()].reduce((count, node) => count + this.relationshipCountForNode(node), 0);

      this.cachedGraph = {
        nodes: nodeMap,
        fileIndex,
        fileRelationships: this.flattenSupplementaryFileRelationships(),
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
        fileRelationships: [],
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
    const recordsByFile = new Map<string, FileRelationshipRecord[]>();
    let processed = 0;
    for (const symbol of symbols) {
      const node = targetNodes.get(symbol.id);
      if (!node) {
        continue;
      }

      const filePath = symbol.filePath;
      const fileRecords = recordsByFile.get(filePath) ?? [];

      if (this.isCallableSymbol(symbol.symbolKind)) {
        const outgoing = await this.indexer.resolveOutgoingCalls(symbol, this.symbolCache);
        for (const targetId of outgoing.filter((targetNodeId) => targetNodes.has(targetNodeId) && targetNodeId !== symbol.id)) {
          const targetNode = targetNodes.get(targetId);
          if (!targetNode) {
            continue;
          }

          this.linkRelationship(node, targetNode, 'calls', fileRecords);
        }
      }

      const implementations = await this.indexer.resolveImplementations(symbol, this.symbolCache);
      for (const targetId of implementations.filter((targetNodeId) => targetNodes.has(targetNodeId) && targetNodeId !== symbol.id)) {
        const targetNode = targetNodes.get(targetId);
        if (!targetNode) {
          continue;
        }

        this.linkRelationship(node, targetNode, 'implements', fileRecords);
      }

      if (this.isVariableLikeSymbol(symbol.symbolKind)) {
        const variableReferences = await this.indexer.resolveVariableReferences(symbol, this.symbolCache);
        const filteredReferences = this.filterReferenceBuckets(variableReferences, targetNodes, symbol.id);

        for (const sourceNodeId of filteredReferences.reads) {
          const sourceNode = targetNodes.get(sourceNodeId);
          if (!sourceNode) {
            continue;
          }

          this.linkRelationship(sourceNode, node, 'reads', fileRecords);
        }

        for (const sourceNodeId of filteredReferences.writes) {
          const sourceNode = targetNodes.get(sourceNodeId);
          if (!sourceNode) {
            continue;
          }

          this.linkRelationship(sourceNode, node, 'writes', fileRecords);
        }
      }

      recordsByFile.set(filePath, fileRecords);

      processed += 1;
      if (processed % 25 === 0) {
        await this.yieldToEventLoop();
      }
    }

    for (const [filePath, records] of recordsByFile) {
      this.fileRelationshipIndex.set(filePath, records);
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
      fileRelationships: this.cachedGraph.fileRelationships,
      builtAt: this.cachedGraph.builtAt,
      fileRoleSummary: this.cachedGraph.fileRoleSummary,
    };
  }

  private rebuildFileRelationshipIndex(nodeMap: Map<string, GraphNode> = this.cachedGraph.nodes): void {
    const index = new Map<string, FileRelationshipRecord[]>();

    for (const node of nodeMap.values()) {
      for (const targetId of node.outgoingCalls) {
        this.appendFileRelationshipRecord(index, node.filePath, {
          sourceId: node.id,
          targetId,
          edgeType: 'calls',
          sourceFilePath: node.filePath,
        });
      }

      for (const targetId of node.implementations) {
        this.appendFileRelationshipRecord(index, node.filePath, {
          sourceId: node.id,
          targetId,
          edgeType: 'implements',
          sourceFilePath: node.filePath,
        });
      }

      for (const targetId of node.references.reads) {
        this.appendFileRelationshipRecord(index, node.filePath, {
          sourceId: node.id,
          targetId,
          edgeType: 'reads',
          sourceFilePath: node.filePath,
        });
      }

      for (const targetId of node.references.writes) {
        this.appendFileRelationshipRecord(index, node.filePath, {
          sourceId: node.id,
          targetId,
          edgeType: 'writes',
          sourceFilePath: node.filePath,
        });
      }
    }

    this.fileRelationshipIndex = index;
  }

  private linkRelationship(
    sourceNode: GraphNode,
    targetNode: GraphNode,
    edgeType: GraphEdgeType,
    records: FileRelationshipRecord[],
  ): void {
    if (sourceNode.id === targetNode.id) {
      return;
    }

    switch (edgeType) {
      case 'calls':
        this.addUniqueValue(sourceNode.outgoingCalls, targetNode.id);
        this.addUniqueValue(targetNode.incomingCalls, sourceNode.id);
        break;
      case 'implements':
        this.addUniqueValue(sourceNode.implementations, targetNode.id);
        this.addUniqueValue(targetNode.incomingImplementations, sourceNode.id);
        break;
      case 'reads':
        this.addUniqueValue(sourceNode.references.reads, targetNode.id);
        this.addUniqueValue(targetNode.incomingReferences.reads, sourceNode.id);
        break;
      case 'writes':
        this.addUniqueValue(sourceNode.references.writes, targetNode.id);
        this.addUniqueValue(targetNode.incomingReferences.writes, sourceNode.id);
        break;
      default:
        break;
    }

    records.push({
      sourceId: sourceNode.id,
      targetId: targetNode.id,
      edgeType,
      sourceFilePath: sourceNode.filePath,
    });
  }

  private clearRelationshipsForFile(filePath: string): void {
    const records = this.fileRelationshipIndex.get(filePath) ?? [];
    for (const record of records) {
      this.removeRelationshipRecord(record);
    }

    this.fileRelationshipIndex.delete(filePath);
  }

  private removeIncomingRelationshipsForNode(node: GraphNode): void {
    for (const sourceId of [...node.incomingCalls]) {
      this.removeRelationshipByDetails(sourceId, node.id, 'calls');
    }

    for (const sourceId of [...node.incomingImplementations]) {
      this.removeRelationshipByDetails(sourceId, node.id, 'implements');
    }

    for (const sourceId of [...node.incomingReferences.reads]) {
      this.removeRelationshipByDetails(sourceId, node.id, 'reads');
    }

    for (const sourceId of [...node.incomingReferences.writes]) {
      this.removeRelationshipByDetails(sourceId, node.id, 'writes');
    }
  }

  private removeRelationshipByDetails(sourceId: string, targetId: string, edgeType: GraphEdgeType): void {
    const sourceNode = this.cachedGraph.nodes.get(sourceId);
    const targetNode = this.cachedGraph.nodes.get(targetId);
    if (!sourceNode || !targetNode) {
      return;
    }

    this.removeRelationshipRecord({
      sourceId,
      targetId,
      edgeType,
      sourceFilePath: sourceNode.filePath,
    });
  }

  private removeRelationshipRecord(record: FileRelationshipRecord): void {
    const sourceNode = this.cachedGraph.nodes.get(record.sourceId);
    const targetNode = this.cachedGraph.nodes.get(record.targetId);
    if (!sourceNode || !targetNode) {
      this.removeRelationshipRecordFromIndex(record);
      return;
    }

    switch (record.edgeType) {
      case 'calls':
        this.removeValueFromArray(sourceNode.outgoingCalls, record.targetId);
        this.removeValueFromArray(targetNode.incomingCalls, record.sourceId);
        break;
      case 'implements':
        this.removeValueFromArray(sourceNode.implementations, record.targetId);
        this.removeValueFromArray(targetNode.incomingImplementations, record.sourceId);
        break;
      case 'reads':
        this.removeValueFromArray(sourceNode.references.reads, record.targetId);
        this.removeValueFromArray(targetNode.incomingReferences.reads, record.sourceId);
        break;
      case 'writes':
        this.removeValueFromArray(sourceNode.references.writes, record.targetId);
        this.removeValueFromArray(targetNode.incomingReferences.writes, record.sourceId);
        break;
      default:
        break;
    }

    this.removeRelationshipRecordFromIndex(record);
  }

  private removeRelationshipRecordFromIndex(record: FileRelationshipRecord): void {
    const records = this.fileRelationshipIndex.get(record.sourceFilePath);
    if (!records || records.length === 0) {
      return;
    }

    const filtered = records.filter((entry) => !this.sameRelationshipRecord(entry, record));
    if (filtered.length === 0) {
      this.fileRelationshipIndex.delete(record.sourceFilePath);
      return;
    }

    this.fileRelationshipIndex.set(record.sourceFilePath, filtered);
  }

  private sameRelationshipRecord(left: FileRelationshipRecord, right: FileRelationshipRecord): boolean {
    return left.sourceId === right.sourceId
      && left.targetId === right.targetId
      && left.edgeType === right.edgeType;
  }

  private addUniqueValue(target: string[], value: string): void {
    if (!target.includes(value)) {
      target.push(value);
    }
  }

  private removeValueFromArray(target: string[], value: string): void {
    const index = target.indexOf(value);
    if (index >= 0) {
      target.splice(index, 1);
    }
  }

  private appendFileRelationshipRecord(
    index: Map<string, FileRelationshipRecord[]>,
    filePath: string,
    record: FileRelationshipRecord,
  ): void {
    const records = index.get(filePath) ?? [];
    if (!records.some((entry) => this.sameRelationshipRecord(entry, record))) {
      records.push(record);
    }

    index.set(filePath, records);
  }

  private async rebuildSupplementaryFileRelationships(filesByRole: Record<WorkspaceFileRole, vscode.Uri[]>): Promise<void> {
    const knownFilePaths = this.collectKnownFilePaths(filesByRole);
    const knownFileUris = this.collectKnownFileUriLookup(filesByRole);
    const next = new Map<string, WorkspaceFileRelationship[]>();

    for (const [role, uris] of Object.entries(filesByRole) as Array<[WorkspaceFileRole, vscode.Uri[]]>) {
      for (const uri of uris) {
        const filePath = toWorkspaceRelativePath(uri);
        const relationships = await this.extractSupplementaryFileRelationships(uri, role, knownFilePaths, knownFileUris);
        if (relationships.length > 0) {
          next.set(filePath, relationships);
        }
      }
    }

    this.supplementaryFileRelationshipIndex = next;
    this.cachedGraph = {
      nodes: this.cachedGraph.nodes,
      fileIndex: this.cachedGraph.fileIndex,
      fileRelationships: this.flattenSupplementaryFileRelationships(),
      builtAt: this.cachedGraph.builtAt,
      fileRoleSummary: this.cachedGraph.fileRoleSummary,
    };
  }

  private async extractSupplementaryFileRelationships(
    uri: vscode.Uri,
    role: WorkspaceFileRole,
    knownFilePaths: Set<string>,
    knownFileUris: Map<string, string>,
  ): Promise<WorkspaceFileRelationship[]> {
    const text = await this.readWorkspaceFileText(uri);
    if (!text) {
      return [];
    }

    const sourceFilePath = toWorkspaceRelativePath(uri);
    const knownFileLookup = this.createKnownFilePathLookup(knownFilePaths);
    const sourceUriString = uri.toString();
    const relationships: WorkspaceFileRelationship[] = [];
    const seen = new Set<string>();

    const addRelationship = (targetFilePath: string, relationship: WorkspaceFileRelationshipType): void => {
      if (!targetFilePath || targetFilePath === sourceFilePath) {
        return;
      }

      const key = `${sourceFilePath}->${targetFilePath}:${relationship}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      relationships.push({
        sourceFilePath,
        targetFilePath,
        sourceUriString,
        targetUriString: knownFileUris.get(targetFilePath) ?? '',
        relationship,
      });
    };

    for (const specifier of this.extractImportSpecifiers(text)) {
      const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
      if (targetFilePath) {
        addRelationship(targetFilePath, 'imports');
      }
    }

    if (role === 'test') {
      for (const targetFilePath of this.inferTestCoverageTargets(sourceFilePath, knownFileLookup)) {
        addRelationship(targetFilePath, 'covers');
      }
    }

    if (role === 'documentation') {
      for (const specifier of this.extractMarkdownLinkTargets(text)) {
        const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
        if (targetFilePath) {
          addRelationship(targetFilePath, 'documents');
        }
      }
    }

    if (role === 'template') {
      for (const specifier of this.extractTemplateLinkTargets(text)) {
        const targetFilePath = this.resolveWorkspaceTargetPath(sourceFilePath, specifier, knownFileLookup);
        if (targetFilePath) {
          addRelationship(targetFilePath, 'related-to');
        }
      }
    }

    return relationships;
  }

  private extractImportSpecifiers(text: string): string[] {
    const specifiers = new Set<string>();
    const patterns: RegExp[] = [
      /\bimport\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g,
      /\bfrom\s+["']([^"']+)["']\s+import\b/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
      /#include\s+["<]([^">]+)[">]/g,
      /@(?:use|import)\s+["']([^"']+)["']/g,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]?.trim();
        if (specifier && this.isLikelyLocalSpecifier(specifier)) {
          specifiers.add(specifier);
        }
      }
    }

    return [...specifiers];
  }

  private extractMarkdownLinkTargets(text: string): string[] {
    const targets = new Set<string>();
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = this.normalizeRelationshipTarget(match[1]);
      if (target && this.isLikelyLocalSpecifier(target)) {
        targets.add(target);
      }
    }

    return [...targets];
  }

  private extractTemplateLinkTargets(text: string): string[] {
    const targets = new Set<string>();
    const patterns: RegExp[] = [
      /\b(?:include|extends|partial)\s+["']([^"']+)["']/g,
      /\bsrc\s*=\s*["']([^"']+)["']/g,
      /\bhref\s*=\s*["']([^"']+)["']/g,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const target = this.normalizeRelationshipTarget(match[1]);
        if (target && this.isLikelyLocalSpecifier(target)) {
          targets.add(target);
        }
      }
    }

    return [...targets];
  }

  private inferTestCoverageTargets(sourceFilePath: string, knownFileLookup: Map<string, string>): string[] {
    const normalizedSourceBase = this.stripTestSuffix(path.posix.basename(sourceFilePath));
    if (!normalizedSourceBase) {
      return [];
    }

    const sourceDir = path.posix.dirname(sourceFilePath);
    const candidates = new Set<string>();
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cs', '.php', '.phtml', '.rb', '.kt', '.kts', '.swift'];

    for (const extension of extensions) {
      candidates.add(path.posix.normalize(path.posix.join(sourceDir, `${normalizedSourceBase}${extension}`)));
      candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSourceBase, `index${extension}`)));
    }

    const matches = new Set<string>();
    for (const candidate of candidates) {
      const resolved = this.findKnownFilePath(candidate, knownFileLookup);
      if (resolved && resolved !== sourceFilePath) {
        matches.add(resolved);
      }
    }

    return [...matches];
  }

  private resolveWorkspaceTargetPath(sourceFilePath: string, specifier: string, knownFileLookup: Map<string, string>): string | undefined {
    const normalizedSpecifier = this.normalizeRelationshipTarget(specifier);
    if (!normalizedSpecifier || /^(?:[a-z]+:|#|mailto:|data:|https?:)/i.test(normalizedSpecifier)) {
      return undefined;
    }

    const sourceDir = path.posix.dirname(sourceFilePath);
    const candidates = new Set<string>();

    if (normalizedSpecifier.startsWith('.') || normalizedSpecifier.startsWith('/')) {
      candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSpecifier)));
    } else {
      candidates.add(path.posix.normalize(path.posix.join(sourceDir, normalizedSpecifier)));
      candidates.add(path.posix.normalize(normalizedSpecifier));
    }

    for (const candidate of [...candidates]) {
      const resolved = this.findKnownFilePath(candidate, knownFileLookup);
      if (resolved) {
        return resolved;
      }

      for (const expandedCandidate of this.expandRelationshipPathCandidates(candidate)) {
        const expandedResolved = this.findKnownFilePath(expandedCandidate, knownFileLookup);
        if (expandedResolved) {
          return expandedResolved;
        }
      }
    }

    return undefined;
  }

  private expandRelationshipPathCandidates(basePath: string): string[] {
    const extensionCandidates = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cs', '.php', '.phtml', '.rb', '.kt', '.kts', '.swift', '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.html', '.htm'];
    const candidates = new Set<string>();
    const normalizedBase = path.posix.normalize(basePath);

    if (path.posix.extname(normalizedBase)) {
      candidates.add(normalizedBase);
    } else {
      for (const extension of extensionCandidates) {
        candidates.add(`${normalizedBase}${extension}`);
        candidates.add(path.posix.join(normalizedBase, `index${extension}`));
      }
    }

    return [...candidates];
  }

  private normalizeRelationshipTarget(value: string): string {
    return value.trim().replace(/[?#].*$/, '').replace(/\\/g, '/');
  }

  private stripTestSuffix(fileName: string): string {
    const withoutExtension = fileName.replace(/\.[^.]+$/, '');
    const withoutSuffix = withoutExtension.replace(/(?:\.|-|_)?(?:test|spec)$/i, '');
    return withoutSuffix.length > 0 ? withoutSuffix : withoutExtension;
  }

  private isLikelyLocalSpecifier(specifier: string): boolean {
    return specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('/');
  }

  private collectKnownFilePaths(filesByRole?: Record<WorkspaceFileRole, vscode.Uri[]>): Set<string> {
    const filePaths = new Set<string>();

    for (const filePath of this.cachedGraph.fileIndex.keys()) {
      filePaths.add(filePath);
    }

    for (const relationship of this.flattenSupplementaryFileRelationships()) {
      filePaths.add(relationship.sourceFilePath);
      filePaths.add(relationship.targetFilePath);
    }

    if (filesByRole) {
      for (const uris of Object.values(filesByRole)) {
        for (const uri of uris) {
          filePaths.add(toWorkspaceRelativePath(uri));
        }
      }
    }

    return filePaths;
  }

  private collectKnownFileUriLookup(filesByRole?: Record<WorkspaceFileRole, vscode.Uri[]>): Map<string, string> {
    const lookup = new Map<string, string>();

    for (const node of this.cachedGraph.nodes.values()) {
      lookup.set(node.filePath, node.uriString);
    }

    for (const relationship of this.flattenSupplementaryFileRelationships()) {
      if (relationship.sourceUriString) {
        lookup.set(relationship.sourceFilePath, relationship.sourceUriString);
      }

      if (relationship.targetUriString) {
        lookup.set(relationship.targetFilePath, relationship.targetUriString);
      }
    }

    if (filesByRole) {
      for (const uris of Object.values(filesByRole)) {
        for (const uri of uris) {
          lookup.set(toWorkspaceRelativePath(uri), uri.toString());
        }
      }
    }

    return lookup;
  }

  private createKnownFilePathLookup(filePaths: Set<string>): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const filePath of filePaths) {
      lookup.set(filePath.toLowerCase(), filePath);
    }

    return lookup;
  }

  private findKnownFilePath(candidate: string, knownFileLookup: Map<string, string>): string | undefined {
    const exactMatch = knownFileLookup.get(candidate.toLowerCase());
    if (exactMatch) {
      return exactMatch;
    }

    const normalizedCandidate = candidate.replace(/\\/g, '/');
    for (const [key, filePath] of knownFileLookup) {
      if (key.endsWith(`/${normalizedCandidate.toLowerCase()}`) || key === normalizedCandidate.toLowerCase()) {
        return filePath;
      }
    }

    return undefined;
  }

  private flattenSupplementaryFileRelationships(): WorkspaceFileRelationship[] {
    const relationships: WorkspaceFileRelationship[] = [];
    for (const entries of this.supplementaryFileRelationshipIndex.values()) {
      relationships.push(...entries);
    }

    return relationships.sort((left, right) => {
      if (left.sourceFilePath !== right.sourceFilePath) {
        return left.sourceFilePath.localeCompare(right.sourceFilePath);
      }

      if (left.relationship !== right.relationship) {
        return left.relationship.localeCompare(right.relationship);
      }

      return left.targetFilePath.localeCompare(right.targetFilePath);
    });
  }

  private async readWorkspaceFileText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(content).toString('utf8');
    } catch {
      return undefined;
    }
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
      fileRelationships: this.flattenSupplementaryFileRelationships(),
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
    const fileRelationships = Array.isArray(candidate.fileRelationships)
      ? this.deserializeWorkspaceFileRelationships(candidate.fileRelationships)
      : [];

    return {
      version: candidate.version,
      knowledgeModelVersion: candidate.knowledgeModelVersion,
      workspaceFolderUri: safeWorkspaceUri,
      savedAtIso: safeSavedAtIso,
      builtAtIso: safeBuiltAtIso,
      fileRoleSummary,
      fileRelationships,
      nodes: candidate.nodes as SerializedGraphNode[],
      symbolCache: candidate.symbolCache as SerializedIndexedSymbol[],
      fileModifiedTimes: candidate.fileModifiedTimes as Record<string, number>,
    };
  }

  private deserializeWorkspaceFileRelationships(value: unknown): WorkspaceFileRelationship[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const relationships: WorkspaceFileRelationship[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const candidate = entry as Partial<WorkspaceFileRelationship>;
      if (
        typeof candidate.sourceFilePath !== 'string'
        || typeof candidate.targetFilePath !== 'string'
        || typeof candidate.sourceUriString !== 'string'
        || typeof candidate.targetUriString !== 'string'
        || typeof candidate.relationship !== 'string'
      ) {
        continue;
      }

      relationships.push({
        sourceFilePath: candidate.sourceFilePath,
        targetFilePath: candidate.targetFilePath,
        sourceUriString: candidate.sourceUriString,
        targetUriString: candidate.targetUriString,
        relationship: candidate.relationship as WorkspaceFileRelationshipType,
      });
    }

    return relationships;
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

    if (
      kind === vscode.SymbolKind.Interface
      || kind === vscode.SymbolKind.Enum
      || kind === vscode.SymbolKind.Namespace
      || kind === vscode.SymbolKind.Module
      || kind === vscode.SymbolKind.TypeParameter
    ) {
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
