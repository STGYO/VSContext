import * as path from 'path';
import { existsSync } from 'fs';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';

import { Logger } from '../utils/logger';
import {
  findWorkspaceSourceFiles,
  getWorkspaceScanSettings,
  toWorkspaceRelativePath,
} from '../utils/workspaceScanner';

const SUPPORTED_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Property,
]);

const PRE_SCAN_AST_EXTENSIONS = new Set<string>([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.h',
  '.cpp',
]);

type WorkerSymbolKind = 'function' | 'method' | 'class' | 'variable' | 'constant' | 'field' | 'property';

interface WorkerExtractedSymbol {
  readonly name: string;
  readonly line: number;
  readonly kind: WorkerSymbolKind;
}

interface WorkerBatchResult {
  readonly candidateFilePaths: string[];
  readonly symbolMap: Record<string, WorkerExtractedSymbol[]>;
}

interface ResolvedDocumentSymbol {
  readonly name: string;
  readonly kind: vscode.SymbolKind;
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
}

export interface SymbolReferenceBuckets {
  readonly reads: string[];
  readonly writes: string[];
}

export interface IndexedSymbol {
  readonly id: string;
  readonly symbolName: string;
  readonly symbolKind: vscode.SymbolKind;
  readonly uri: vscode.Uri;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly range: vscode.Range;
}

export interface SerializedIndexedSymbolRange {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface SerializedIndexedSymbol {
  readonly id: string;
  readonly symbolName: string;
  readonly symbolKind: number;
  readonly uriString: string;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly range: SerializedIndexedSymbolRange;
}

export function serializeIndexedSymbol(symbol: IndexedSymbol): SerializedIndexedSymbol {
  return {
    id: symbol.id,
    symbolName: symbol.symbolName,
    symbolKind: symbol.symbolKind,
    uriString: symbol.uri.toString(),
    filePath: symbol.filePath,
    lineNumber: symbol.lineNumber,
    range: {
      startLine: symbol.range.start.line,
      startCharacter: symbol.range.start.character,
      endLine: symbol.range.end.line,
      endCharacter: symbol.range.end.character,
    },
  };
}

export function deserializeIndexedSymbol(snapshot: SerializedIndexedSymbol): IndexedSymbol | undefined {
  if (!snapshot || typeof snapshot !== 'object') {
    return undefined;
  }

  if (typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
    return undefined;
  }

  if (typeof snapshot.symbolName !== 'string' || snapshot.symbolName.length === 0) {
    return undefined;
  }

  if (typeof snapshot.filePath !== 'string' || snapshot.filePath.length === 0) {
    return undefined;
  }

  if (typeof snapshot.uriString !== 'string' || snapshot.uriString.length === 0) {
    return undefined;
  }

  if (typeof snapshot.symbolKind !== 'number' || !Number.isFinite(snapshot.symbolKind)) {
    return undefined;
  }

  if (typeof snapshot.lineNumber !== 'number' || !Number.isFinite(snapshot.lineNumber) || snapshot.lineNumber < 1) {
    return undefined;
  }

  if (!snapshot.range || typeof snapshot.range !== 'object') {
    return undefined;
  }

  const {
    startLine,
    startCharacter,
    endLine,
    endCharacter,
  } = snapshot.range;

  if (
    typeof startLine !== 'number'
    || typeof startCharacter !== 'number'
    || typeof endLine !== 'number'
    || typeof endCharacter !== 'number'
    || !Number.isFinite(startLine)
    || !Number.isFinite(startCharacter)
    || !Number.isFinite(endLine)
    || !Number.isFinite(endCharacter)
    || startLine < 0
    || startCharacter < 0
    || endLine < 0
    || endCharacter < 0
  ) {
    return undefined;
  }

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(snapshot.uriString);
  } catch {
    return undefined;
  }

  const range = new vscode.Range(startLine, startCharacter, endLine, endCharacter);
  const normalizedId = createSymbolNodeId(uri, snapshot.symbolName, startLine);

  if (snapshot.id !== normalizedId) {
    return undefined;
  }

  return {
    id: snapshot.id,
    symbolName: snapshot.symbolName,
    symbolKind: snapshot.symbolKind,
    uri,
    filePath: snapshot.filePath,
    lineNumber: snapshot.lineNumber,
    range,
  };
}

export function serializeIndexedSymbolMap(symbols: Map<string, IndexedSymbol>): SerializedIndexedSymbol[] {
  return [...symbols.values()].map((symbol) => serializeIndexedSymbol(symbol));
}

export function deserializeIndexedSymbolMap(snapshots: SerializedIndexedSymbol[]): Map<string, IndexedSymbol> {
  const restored = new Map<string, IndexedSymbol>();

  for (const snapshot of snapshots) {
    const symbol = deserializeIndexedSymbol(snapshot);
    if (!symbol) {
      continue;
    }

    restored.set(symbol.id, symbol);
  }

  return restored;
}

export interface WorkspaceIndexResult {
  readonly indexed: Map<string, IndexedSymbol>;
  readonly scannedFiles: vscode.Uri[];
  readonly scannedFileCount: number;
  readonly indexedSymbolCount: number;
  readonly skippedByExclusions: number;
  readonly skippedByLimit: number;
}

export function createSymbolNodeId(uri: vscode.Uri, symbolName: string, startLineZeroBased: number): string {
  return `${uri.toString()}::${symbolName}::${startLineZeroBased + 1}`;
}

export class SymbolIndexer {
  public constructor(private readonly logger: Logger) {}

  public async indexWorkspaceSymbols(): Promise<WorkspaceIndexResult> {
    const settings = getWorkspaceScanSettings();
    const indexed = new Map<string, IndexedSymbol>();

    try {
      const scanResult = await findWorkspaceSourceFiles(settings.maxIndexedFiles);
      this.logger.info(`[VSContext] Indexed ${scanResult.files.length} files selected for symbol extraction.`);
      this.logger.info(`[VSContext] Skipped dependency directories: ${scanResult.skippedByExclusions} files.`);
      if (scanResult.skippedByLimit > 0) {
        this.logger.warn(`[VSContext] Skipped ${scanResult.skippedByLimit} files due to maxIndexedFiles limit.`);
      }

      const preScanResult = await this.runParallelPreScan(
        scanResult.files,
        settings.workerCount,
        settings.workerBatchSize,
      );
      this.logger.info(`[VSContext] Worker pre-scan found symbol candidates in ${preScanResult.candidateFilePaths.length} files.`);

      await this.forEachWithConcurrency(scanResult.files, settings.workerCount, async (uri) => {
        const fallbackSymbols = preScanResult.symbolMap[uri.fsPath] ?? [];
        const symbols = await this.indexDocumentSymbols(uri, fallbackSymbols);

        for (const symbol of symbols) {
          indexed.set(symbol.id, symbol);
        }
      });

      this.logger.info(`[VSContext] Indexed ${indexed.size} symbols.`);
      return {
        indexed,
        scannedFiles: scanResult.files,
        scannedFileCount: scanResult.files.length,
        indexedSymbolCount: indexed.size,
        skippedByExclusions: scanResult.skippedByExclusions,
        skippedByLimit: scanResult.skippedByLimit,
      };
    } catch (error) {
      this.logger.error('Workspace symbol indexing failed.', error);
      return {
        indexed,
        scannedFiles: [],
        scannedFileCount: 0,
        indexedSymbolCount: 0,
        skippedByExclusions: 0,
        skippedByLimit: 0,
      };
    }
  }

  public async indexDocumentSymbols(uri: vscode.Uri, fallbackSymbols: WorkerExtractedSymbol[] = []): Promise<IndexedSymbol[]> {
    if (!this.shouldIndexUri(uri)) {
      return [];
    }

    const resolved = await this.resolveDocumentSymbols(uri);
    const fromProvider = resolved
      .filter((symbol) => SUPPORTED_SYMBOL_KINDS.has(symbol.kind))
      .filter((symbol) => this.hasMeaningfulName(symbol.name, symbol.kind))
      .map((symbol) => this.toIndexedSymbol(symbol));

    const fromFallback = fallbackSymbols
      .filter((symbol) => this.hasMeaningfulName(symbol.name, this.toSymbolKindFromFallback(symbol.kind)))
      .map((symbol) => this.toIndexedSymbolFromFallback(uri, symbol));

    const merged = new Map<string, IndexedSymbol>();
    for (const symbol of fromProvider) {
      merged.set(symbol.id, symbol);
    }

    for (const symbol of fromFallback) {
      if (!merged.has(symbol.id)) {
        merged.set(symbol.id, symbol);
      }
    }

    const indexed = [...merged.values()];
    this.logAcceptedSymbols(indexed);
    this.logIndexedVariables(indexed);
    return indexed;
  }

  public async resolveOutgoingCalls(
    symbol: IndexedSymbol,
    allSymbols: Map<string, IndexedSymbol>,
  ): Promise<string[]> {
    if (!this.isCallableSymbol(symbol.symbolKind)) {
      return [];
    }

    const outgoingIds = new Set<string>();

    try {
      const roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        symbol.uri,
        symbol.range.start,
      );

      for (const root of roots ?? []) {
        const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls',
          root,
        );

        for (const outgoingCall of outgoingCalls ?? []) {
          const nodeId = this.findMatchingSymbolId(outgoingCall.to, allSymbols);
          if (nodeId && nodeId !== symbol.id) {
            outgoingIds.add(nodeId);
          }
        }
      }
    } catch {
      return [];
    }

    return [...outgoingIds];
  }

  public async resolveImplementations(
    symbol: IndexedSymbol,
    allSymbols: Map<string, IndexedSymbol>,
  ): Promise<string[]> {
    if (this.isVariableLikeSymbol(symbol.symbolKind)) {
      return [];
    }

    const implementationIds = new Set<string>();

    try {
      const implementations = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeImplementationProvider',
        symbol.uri,
        symbol.range.start,
      );

      for (const entry of implementations ?? []) {
        const location = this.toLocation(entry);
        if (!location) {
          continue;
        }

        const nodeId = this.findMatchingSymbolIdFromLocation(location, allSymbols);
        if (nodeId && nodeId !== symbol.id) {
          implementationIds.add(nodeId);
        }
      }
    } catch {
      return [];
    }

    return [...implementationIds];
  }

  public async resolveVariableReferences(
    symbol: IndexedSymbol,
    allSymbols: Map<string, IndexedSymbol>,
  ): Promise<SymbolReferenceBuckets> {
    if (!this.isVariableLikeSymbol(symbol.symbolKind)) {
      return { reads: [], writes: [] };
    }

    const reads = new Set<string>();
    const writes = new Set<string>();
    const documentCache = new Map<string, vscode.TextDocument>();

    try {
      const references = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeReferenceProvider',
        symbol.uri,
        symbol.range.start,
      );

      for (const entry of references ?? []) {
        const location = this.toLocation(entry);
        if (!location || this.isLikelyDeclarationReference(symbol, location)) {
          continue;
        }

        const sourceSymbolId = this.findContainingSymbolId(location, allSymbols, symbol.id);
        if (!sourceSymbolId || sourceSymbolId === symbol.id) {
          continue;
        }

        const accessType = await this.classifyReferenceAccess(symbol.symbolName, location, documentCache);
        if (accessType === 'writes') {
          writes.add(sourceSymbolId);
        } else {
          reads.add(sourceSymbolId);
        }
      }
    } catch {
      return { reads: [], writes: [] };
    }

    return {
      reads: [...reads],
      writes: [...writes],
    };
  }

  private async runParallelPreScan(
    files: vscode.Uri[],
    workerCount: number,
    workerBatchSize: number,
  ): Promise<WorkerBatchResult> {
    const preScannableUris = files.filter((uri) => PRE_SCAN_AST_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase()));
    const filePaths = preScannableUris.map((uri) => uri.fsPath);
    const workerScriptPath = path.join(__dirname, 'symbolPreScanWorker.js');
    const emptyResult: WorkerBatchResult = { candidateFilePaths: [], symbolMap: {} };

    if (!existsSync(workerScriptPath) || filePaths.length === 0) {
      return {
        candidateFilePaths: filePaths,
        symbolMap: {},
      };
    }

    const batches: string[][] = [];
    for (let index = 0; index < filePaths.length; index += workerBatchSize) {
      batches.push(filePaths.slice(index, index + workerBatchSize));
    }

    const maxWorkers = Math.max(1, Math.min(workerCount, batches.length));
    const aggregate: WorkerBatchResult = { candidateFilePaths: [], symbolMap: {} };
    let batchIndex = 0;

    const runWorkerLoop = async (): Promise<void> => {
      while (batchIndex < batches.length) {
        const currentBatch = batches[batchIndex];
        batchIndex += 1;

        const result = await this.runWorkerBatch(workerScriptPath, currentBatch);
        for (const filePath of result.candidateFilePaths) {
          aggregate.candidateFilePaths.push(filePath);
        }

        for (const [filePath, symbols] of Object.entries(result.symbolMap)) {
          aggregate.symbolMap[filePath] = symbols;
        }

        await this.yieldToEventLoop();
      }
    };

    try {
      await Promise.all(Array.from({ length: maxWorkers }, () => runWorkerLoop()));
      return aggregate;
    } catch {
      return emptyResult;
    }
  }

  private async runWorkerBatch(workerScriptPath: string, filePaths: string[]): Promise<WorkerBatchResult> {
    return new Promise<WorkerBatchResult>((resolve) => {
      const worker = new Worker(workerScriptPath, {
        workerData: {
          filePaths,
        },
      });

      const fallback: WorkerBatchResult = {
        candidateFilePaths: filePaths,
        symbolMap: {},
      };

      worker.once('message', (message: WorkerBatchResult) => {
        worker.terminate().catch(() => undefined);
        resolve(message);
      });

      worker.once('error', () => {
        worker.terminate().catch(() => undefined);
        resolve(fallback);
      });

      worker.once('exit', (code) => {
        if (code !== 0) {
          resolve(fallback);
        }
      });
    });
  }

  private async resolveDocumentSymbols(uri: vscode.Uri): Promise<ResolvedDocumentSymbol[]> {
    try {
      const resolved = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );

      if (!resolved || resolved.length === 0) {
        if (this.isSymbolDebugEnabled()) {
          this.logger.info(`[VSContext][debug] Raw symbols: none (${toWorkspaceRelativePath(uri)})`);
        }

        return [];
      }

      if (resolved[0] instanceof vscode.DocumentSymbol) {
        const flattened = this.flattenDocumentSymbols(uri, resolved as vscode.DocumentSymbol[]);
        this.logRawResolvedSymbols(uri, flattened);
        return flattened;
      }

      const asSymbolInfo = (resolved as vscode.SymbolInformation[])
        .filter((entry) => entry.location instanceof vscode.Location)
        .map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          uri: entry.location.uri,
          range: entry.location.range,
        }));

      this.logRawResolvedSymbols(uri, asSymbolInfo);
      return asSymbolInfo;
    } catch {
      return [];
    }
  }

  private toIndexedSymbol(symbol: ResolvedDocumentSymbol): IndexedSymbol {
    return {
      id: createSymbolNodeId(symbol.uri, symbol.name, symbol.range.start.line),
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      uri: symbol.uri,
      filePath: toWorkspaceRelativePath(symbol.uri),
      lineNumber: symbol.range.start.line + 1,
      range: symbol.range,
    };
  }

  private toIndexedSymbolFromFallback(uri: vscode.Uri, symbol: WorkerExtractedSymbol): IndexedSymbol {
    const kind = this.toSymbolKindFromFallback(symbol.kind);
    const startLine = Math.max(0, symbol.line - 1);
    const range = new vscode.Range(startLine, 0, startLine, 1);

    return {
      id: createSymbolNodeId(uri, symbol.name, startLine),
      symbolName: symbol.name,
      symbolKind: kind,
      uri,
      filePath: toWorkspaceRelativePath(uri),
      lineNumber: startLine + 1,
      range,
    };
  }

  private toSymbolKindFromFallback(kind: WorkerSymbolKind): vscode.SymbolKind {
    switch (kind) {
      case 'class':
        return vscode.SymbolKind.Class;
      case 'method':
        return vscode.SymbolKind.Method;
      case 'variable':
        return vscode.SymbolKind.Variable;
      case 'constant':
        return vscode.SymbolKind.Constant;
      case 'field':
        return vscode.SymbolKind.Field;
      case 'property':
        return vscode.SymbolKind.Property;
      case 'function':
      default:
        return vscode.SymbolKind.Function;
    }
  }

  private flattenDocumentSymbols(uri: vscode.Uri, symbols: vscode.DocumentSymbol[]): ResolvedDocumentSymbol[] {
    const flattened: ResolvedDocumentSymbol[] = [];
    const collectSymbols = (entries: vscode.DocumentSymbol[]): void => {
      for (const current of entries) {
        flattened.push({
          name: current.name,
          kind: current.kind,
          range: current.range,
          uri,
        });

        if (current.children && current.children.length > 0) {
          collectSymbols(current.children);
        }
      }
    };

    collectSymbols(symbols);

    return flattened;
  }

  private async forEachWithConcurrency<T>(
    values: readonly T[],
    concurrency: number,
    work: (value: T) => Promise<void>,
  ): Promise<void> {
    let pointer = 0;

    const run = async (): Promise<void> => {
      while (pointer < values.length) {
        const current = values[pointer];
        pointer += 1;
        await work(current);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => run()));
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

  private hasMeaningfulName(name: string, kind: vscode.SymbolKind): boolean {
    const normalized = name.trim();
    if (normalized.length === 0) {
      return false;
    }

    if (!this.isVariableLikeSymbol(kind)) {
      return true;
    }

    return !/^<.*>$/.test(normalized) && normalized.toLowerCase() !== 'anonymous';
  }

  private shouldIndexUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) {
      return false;
    }

    return !this.isExcludedPath(relativePath);
  }

  private isExcludedPath(relativePath: string): boolean {
    const segments = relativePath.split('/').map((segment) => segment.toLowerCase());
    return segments.includes('node_modules') || segments.includes('dist') || segments.includes('build');
  }

  private logIndexedVariables(symbols: IndexedSymbol[]): void {
    for (const symbol of symbols) {
      if (!this.isVariableLikeSymbol(symbol.symbolKind)) {
        continue;
      }

      this.logger.info(`[VSContext] Indexed variable: ${symbol.symbolName} (${symbol.filePath})`);
    }
  }

  private logRawResolvedSymbols(uri: vscode.Uri, symbols: ResolvedDocumentSymbol[]): void {
    if (!this.isSymbolDebugEnabled()) {
      return;
    }

    this.logger.info(`[VSContext][debug] Raw symbols: ${symbols.length.toString()} (${toWorkspaceRelativePath(uri)})`);
    for (const symbol of symbols) {
      this.logger.info(`[VSContext][debug] Raw symbol: ${symbol.name} (${this.symbolKindLabel(symbol.kind)})`);
    }
  }

  private logAcceptedSymbols(symbols: IndexedSymbol[]): void {
    if (!this.isSymbolDebugEnabled()) {
      return;
    }

    for (const symbol of symbols) {
      this.logger.info(`[VSContext][debug] Indexed symbol: ${symbol.symbolName} (${this.symbolKindLabel(symbol.symbolKind)})`);
    }
  }

  private symbolKindLabel(kind: vscode.SymbolKind): string {
    const label = (vscode.SymbolKind as unknown as Record<number, string>)[kind];
    return typeof label === 'string' ? label : kind.toString();
  }

  private isSymbolDebugEnabled(): boolean {
    return vscode.workspace.getConfiguration('vscontext').get<boolean>('debugSymbolDetection', false);
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  private findMatchingSymbolId(
    callItem: vscode.CallHierarchyItem,
    allSymbols: Map<string, IndexedSymbol>,
  ): string | undefined {
    const strictMatchId = createSymbolNodeId(callItem.uri, callItem.name, callItem.selectionRange.start.line);
    if (allSymbols.has(strictMatchId)) {
      return strictMatchId;
    }

    const normalizedTargetName = this.normalizeName(callItem.name);
    for (const candidate of allSymbols.values()) {
      if (candidate.uri.toString() !== callItem.uri.toString()) {
        continue;
      }

      if (this.normalizeName(candidate.symbolName) !== normalizedTargetName) {
        continue;
      }

      const lineDistance = Math.abs(candidate.lineNumber - (callItem.selectionRange.start.line + 1));
      if (lineDistance <= 2) {
        return candidate.id;
      }
    }

    return undefined;
  }

  private toLocation(candidate: vscode.Location | vscode.LocationLink): vscode.Location | undefined {
    if (candidate instanceof vscode.Location) {
      return candidate;
    }

    if (!candidate || typeof candidate !== 'object') {
      return undefined;
    }

    const locationLink = candidate as vscode.LocationLink;
    if (!(locationLink.targetUri instanceof vscode.Uri) || !(locationLink.targetSelectionRange instanceof vscode.Range)) {
      return undefined;
    }

    return new vscode.Location(locationLink.targetUri, locationLink.targetSelectionRange);
  }

  private findMatchingSymbolIdFromLocation(
    location: vscode.Location,
    allSymbols: Map<string, IndexedSymbol>,
  ): string | undefined {
    const candidates = [...allSymbols.values()]
      .filter((symbol) => symbol.uri.toString() === location.uri.toString());

    if (candidates.length === 0) {
      return undefined;
    }

    let bestCandidate: IndexedSymbol | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const containsPosition = candidate.range.contains(location.range.start);
      const lineDistance = Math.abs(candidate.range.start.line - location.range.start.line);
      const characterDistance = Math.abs(candidate.range.start.character - location.range.start.character);
      const rangeSpan = ((candidate.range.end.line - candidate.range.start.line) * 1000)
        + (candidate.range.end.character - candidate.range.start.character);

      const basePenalty = containsPosition ? 0 : 100_000;
      const score = basePenalty + (lineDistance * 100) + characterDistance + Math.max(0, rangeSpan);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) {
      return undefined;
    }

    if (bestScore >= 100_000 && Math.abs(bestCandidate.range.start.line - location.range.start.line) > 3) {
      return undefined;
    }

    return bestCandidate.id;
  }

  private findContainingSymbolId(
    location: vscode.Location,
    allSymbols: Map<string, IndexedSymbol>,
    excludedSymbolId: string,
  ): string | undefined {
    const containingCandidates = [...allSymbols.values()]
      .filter((symbol) => symbol.id !== excludedSymbolId)
      .filter((symbol) => symbol.uri.toString() === location.uri.toString())
      .filter((symbol) => symbol.range.contains(location.range.start));

    if (containingCandidates.length === 0) {
      return undefined;
    }

    const sorted = containingCandidates.sort((left, right) => {
      const leftSpan = ((left.range.end.line - left.range.start.line) * 1000)
        + (left.range.end.character - left.range.start.character);
      const rightSpan = ((right.range.end.line - right.range.start.line) * 1000)
        + (right.range.end.character - right.range.start.character);

      if (leftSpan !== rightSpan) {
        return leftSpan - rightSpan;
      }

      return left.lineNumber - right.lineNumber;
    });

    return sorted[0]?.id;
  }

  private isLikelyDeclarationReference(symbol: IndexedSymbol, location: vscode.Location): boolean {
    if (symbol.uri.toString() !== location.uri.toString()) {
      return false;
    }

    return (
      symbol.range.start.line === location.range.start.line
      && Math.abs(symbol.range.start.character - location.range.start.character) <= 2
    );
  }

  private async classifyReferenceAccess(
    symbolName: string,
    location: vscode.Location,
    documentCache: Map<string, vscode.TextDocument>,
  ): Promise<'reads' | 'writes'> {
    const cacheKey = location.uri.toString();
    let document = documentCache.get(cacheKey);

    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(location.uri);
        documentCache.set(cacheKey, document);
      } catch {
        return 'reads';
      }
    }

    const lineNumber = location.range.start.line;
    if (lineNumber < 0 || lineNumber >= document.lineCount) {
      return 'reads';
    }

    const lineText = document.lineAt(lineNumber).text;
    const startCharacter = location.range.start.character;
    const endCharacter = location.range.end.character > startCharacter
      ? location.range.end.character
      : startCharacter + symbolName.length;

    const before = lineText.slice(0, Math.max(0, startCharacter));
    const after = lineText.slice(Math.max(0, endCharacter));

    if (/(\+\+|--)\s*$/.test(before.trimEnd()) || /^\s*(\+\+|--)/.test(after)) {
      return 'writes';
    }

    const trimmedAfter = after.trimStart();
    const assignmentOperators = [
      '+=',
      '-=',
      '*=',
      '/=',
      '%=',
      '&&=',
      '||=',
      '??=',
      '<<=',
      '>>=',
      '>>>=',
      '&=',
      '|=',
      '^=',
      ':=',
    ];

    if (assignmentOperators.some((operator) => trimmedAfter.startsWith(operator))) {
      return 'writes';
    }

    if (
      trimmedAfter.startsWith('=')
      && !trimmedAfter.startsWith('==')
      && !trimmedAfter.startsWith('===')
      && !trimmedAfter.startsWith('=>')
    ) {
      return 'writes';
    }

    if (/^\s*[,\]\)}]*\s*=/.test(after)) {
      return 'writes';
    }

    return 'reads';
  }

  private normalizeName(name: string): string {
    return name.trim().replace(/\(\)$/, '');
  }
}
