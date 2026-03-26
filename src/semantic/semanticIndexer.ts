import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { Logger } from '../utils/logger';
import { classifyWorkspaceFile, type WorkspaceFileRole } from '../utils/fileRoleClassifier';
import {
  findWorkspaceRepositoryFiles,
  getWorkspaceScanSettings,
  toFileName,
  toWorkspaceRelativePath,
} from '../utils/workspaceScanner';

const SEMANTIC_VECTOR_DIMENSION = 128;
const MAX_CHUNKS_PER_FILE = 8;
const DEFAULT_MAX_RESULTS = 6;
const FILE_CHUNK_LINE_WINDOW = 80;
const FILE_CHUNK_LINE_OVERLAP = 20;
const CORPUS_RECENCY_DECAY = 0.14;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'for',
  'from',
  'if',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'with',
  'use',
  'using',
  'used',
  'via',
  'via',
  'when',
  'where',
  'which',
  'who',
  'why',
]);

export type SemanticRecordKind = 'symbol' | 'chunk' | 'workspace-symbol';

export interface SemanticSearchOptions {
  readonly focusNodeId?: string;
  readonly maxResults?: number;
  readonly cancellationToken?: vscode.CancellationToken;
}

export interface SemanticSearchHit {
  readonly id: string;
  readonly kind: SemanticRecordKind;
  readonly title: string;
  readonly summary: string;
  readonly filePath: string;
  readonly score: number;
  readonly nodeId?: string;
  readonly uriString?: string;
  readonly lineNumber?: number;
  readonly reasons: string[];
}

export interface SemanticSearchResult {
  readonly query: string;
  readonly hits: SemanticSearchHit[];
  readonly nativeCandidateCount: number;
  readonly corpusRecordCount: number;
}

interface SemanticRecord {
  readonly id: string;
  readonly kind: SemanticRecordKind;
  readonly title: string;
  readonly summary: string;
  readonly filePath: string;
  readonly uriString: string;
  readonly lineNumber?: number;
  readonly nodeId?: string;
  readonly tokens: Set<string>;
  readonly vector: number[];
  readonly role: WorkspaceFileRole;
  readonly order: number;
}

interface SemanticIndexSnapshot {
  readonly signature: string;
  readonly records: SemanticRecord[];
}

interface CachedFileSemanticState {
  readonly hash: string;
  readonly records: SemanticRecord[];
  readonly role: WorkspaceFileRole;
  readonly order: number;
}

export class WorkspaceSemanticIndexer {
  private cachedSnapshot: SemanticIndexSnapshot | undefined;
  private cachedFileStates = new Map<string, CachedFileSemanticState>();

  public constructor(private readonly logger: Logger) {}

  public async search(
    graph: WorkspaceGraph,
    query: string,
    options: SemanticSearchOptions = {},
  ): Promise<SemanticSearchResult> {
    const trimmedQuery = query.trim();
    const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
    const snapshot = await this.ensureIndex(graph, options.cancellationToken);

    if (trimmedQuery.length === 0) {
      return {
        query: trimmedQuery,
        hits: [],
        nativeCandidateCount: 0,
        corpusRecordCount: snapshot.records.length,
      };
    }

    const queryTokens = tokenizeText(trimmedQuery);
    const queryVector = embedTokens(queryTokens);
    const focusDistanceMap = options.focusNodeId ? buildGraphDistanceMap(graph, options.focusNodeId, 4) : undefined;

    const corpusHits = rankCorpusRecords(snapshot.records, graph, trimmedQuery, queryTokens, queryVector, focusDistanceMap);
    const nativeHits = await this.queryNativeWorkspaceSymbols(graph, trimmedQuery, queryTokens, focusDistanceMap);

    const merged = mergeSemanticHits([...corpusHits, ...nativeHits], maxResults);

    return {
      query: trimmedQuery,
      hits: merged,
      nativeCandidateCount: nativeHits.length,
      corpusRecordCount: snapshot.records.length,
    };
  }

  public formatSearchResult(result: SemanticSearchResult): string {
    const lines: string[] = [];
    lines.push('## Semantic Retrieval');
    lines.push(`- Query: ${result.query}`);
    lines.push(`- Native symbol candidates: ${result.nativeCandidateCount}`);
    lines.push(`- Indexed semantic records: ${result.corpusRecordCount}`);

    lines.push('');
    lines.push('### Top Matches');
    if (result.hits.length === 0) {
      lines.push('- None');
      return lines.join('\n');
    }

    for (const hit of result.hits) {
      const locationParts = [hit.filePath];
      if (typeof hit.lineNumber === 'number') {
        locationParts.push(`line ${hit.lineNumber}`);
      }

      lines.push(`- ${hit.title} [${hit.kind}] (${hit.score.toFixed(2)})`);
      lines.push(`  - ${hit.summary}`);
      lines.push(`  - ${locationParts.join(' | ')}`);
      if (hit.reasons.length > 0) {
        lines.push(`  - Signals: ${hit.reasons.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  private async ensureIndex(graph: WorkspaceGraph, cancellationToken?: vscode.CancellationToken): Promise<SemanticIndexSnapshot> {
    const signature = createGraphSignature(graph);
    if (this.cachedSnapshot && this.cachedSnapshot.signature === signature) {
      return this.cachedSnapshot;
    }

    const settings = getWorkspaceScanSettings();
    const repositoryScan = await findWorkspaceRepositoryFiles(settings.maxIndexedFiles);
    const recordsByFile = new Map<string, SemanticRecord[]>();
    const seenFiles = new Map<string, { uri: vscode.Uri; role: WorkspaceFileRole }>();

    for (const [role, uris] of Object.entries(repositoryScan.filesByRole) as Array<[WorkspaceFileRole, vscode.Uri[]]>) {
      for (const uri of uris) {
        const filePath = toWorkspaceRelativePath(uri);
        if (!seenFiles.has(filePath)) {
          seenFiles.set(filePath, { uri, role });
        }
      }
    }

    const fileEntries = [...seenFiles.entries()].sort((left, right) => left[0].localeCompare(right[0]));
    const concurrency = Math.max(2, Math.min(settings.workerCount, 8));

    await mapWithConcurrency(fileEntries, concurrency, async ([filePath, entry], index) => {
      if (cancellationToken?.isCancellationRequested) {
        return;
      }

      const text = await this.readFileText(entry.uri);
      if (!text || cancellationToken?.isCancellationRequested) {
        return;
      }

      const hash = hashText(text);
      const cached = this.cachedFileStates.get(filePath);
      if (cached && cached.hash === hash && cached.role === entry.role) {
        recordsByFile.set(filePath, cached.records);
        touchCacheEntry(this.cachedFileStates, filePath, cached);
        return;
      }

      const chunks = splitIntoChunks(text, FILE_CHUNK_LINE_WINDOW, FILE_CHUNK_LINE_OVERLAP, MAX_CHUNKS_PER_FILE);
      const fileRecords: SemanticRecord[] = [];
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        if (cancellationToken?.isCancellationRequested) {
          return;
        }

        const chunk = chunks[chunkIndex];
        const title = `${toFileName(entry.uri)} chunk ${chunkIndex + 1}`;
        const summary = buildChunkSummary(filePath, entry.role, chunkIndex + 1, chunks.length, chunk);
        fileRecords.push(buildRecord({
          id: `chunk:${filePath}:${chunkIndex}`,
          kind: 'chunk',
          title,
          summary,
          filePath,
          uri: entry.uri,
          lineNumber: chunk.startLine + 1,
          role: entry.role,
          order: index * 100 + chunkIndex,
          text: `${filePath}\n${entry.role}\n${chunk.text}\n${summary}`,
        }));
      }

      recordsByFile.set(filePath, fileRecords);
      this.cachedFileStates.set(filePath, {
        hash,
        records: fileRecords,
        role: entry.role,
        order: index,
      });
      pruneLRU(this.cachedFileStates, 2048);
    });

    const activeFilePaths = new Set(fileEntries.map(([filePath]) => filePath));
    for (const filePath of [...this.cachedFileStates.keys()]) {
      if (!activeFilePaths.has(filePath)) {
        this.cachedFileStates.delete(filePath);
      }
    }

    const records: SemanticRecord[] = [];
    for (const [filePath] of fileEntries) {
      if (cancellationToken?.isCancellationRequested) {
        break;
      }

      const fileRecords = recordsByFile.get(filePath);
      if (fileRecords) {
        records.push(...fileRecords);
      }
    }

    for (const node of graph.nodes.values()) {
      records.push(buildRecord({
        id: `symbol:${node.id}`,
        kind: 'symbol',
        title: node.symbolName,
        summary: buildSymbolSummary(node, graph),
        filePath: node.filePath,
        uri: vscode.Uri.parse(node.uriString),
        lineNumber: node.lineNumber,
        role: classifyWorkspaceFile(vscode.Uri.parse(node.uriString)),
        order: fileEntries.length * 1000 + node.lineNumber,
        text: buildSymbolText(node, graph),
      }));
    }

      if (cancellationToken?.isCancellationRequested && this.cachedSnapshot) {
        return this.cachedSnapshot;
      }

    this.cachedSnapshot = {
      signature,
      records,
    };

    this.logger.info(`[VSContext] Semantic index built with ${records.length} records.`);
    return this.cachedSnapshot;
  }

  private async queryNativeWorkspaceSymbols(
    graph: WorkspaceGraph,
    query: string,
    queryTokens: string[],
    focusDistanceMap: Map<string, number> | undefined,
  ): Promise<SemanticSearchHit[]> {
    let nativeSymbols: vscode.SymbolInformation[] = [];
    try {
      nativeSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query) ?? [];
    } catch {
      nativeSymbols = [];
    }

    const hits: SemanticSearchHit[] = [];
    for (const symbol of nativeSymbols) {
      if (!(symbol.location instanceof vscode.Location)) {
        continue;
      }

      const filePath = toWorkspaceRelativePath(symbol.location.uri);
      const nodeId = findBestGraphNodeId(graph, symbol.location.uri, symbol.location.range.start.line);
      const title = symbol.name;
      const normalizedTitleTokens = tokenizeText(title);
      const overlap = tokenOverlapScore(queryTokens, normalizedTitleTokens);
      const distanceBoost = nodeId ? getDistanceBoost(focusDistanceMap, nodeId) : 0;

      hits.push({
        id: `native:${symbol.location.uri.toString()}:${symbol.name}:${symbol.location.range.start.line}`,
        kind: 'workspace-symbol',
        title,
        summary: `${symbolKindLabel(symbol.kind)} at ${filePath}`,
        filePath,
        nodeId,
        uriString: symbol.location.uri.toString(),
        lineNumber: symbol.location.range.start.line + 1,
        score: 0.55 + (overlap * 0.25) + distanceBoost,
        reasons: ['native workspace symbol provider', `symbol kind ${symbolKindLabel(symbol.kind)}`],
      });
    }

    return hits;
  }

  private async readFileText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.getText();
    } catch {
      return undefined;
    }
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let pointer = 0;

  const run = async (): Promise<void> => {
    while (pointer < values.length) {
      const currentIndex = pointer;
      pointer += 1;
      const value = values[currentIndex];
      if (value === undefined) {
        continue;
      }

      await work(value, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => run()));
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function touchCacheEntry<T extends CachedFileSemanticState>(
  cache: Map<string, T>,
  key: string,
  value: T,
): void {
  cache.delete(key);
  cache.set(key, value);
}

function pruneLRU<T>(cache: Map<string, T>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }

    cache.delete(oldestKey);
  }
}

function mergeSemanticHits(hits: SemanticSearchHit[], maxResults: number): SemanticSearchHit[] {
  const merged = new Map<string, SemanticSearchHit>();

  for (const hit of hits) {
    const key = hit.nodeId ?? `${hit.filePath}::${hit.title}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, hit);
      continue;
    }

    merged.set(key, {
      ...existing,
      score: Math.max(existing.score, hit.score),
      reasons: [...new Set([...existing.reasons, ...hit.reasons])],
    });
  }

  return [...merged.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.title.localeCompare(right.title);
    })
    .slice(0, maxResults);
}

function rankCorpusRecords(
  records: SemanticRecord[],
  graph: WorkspaceGraph,
  query: string,
  queryTokens: string[],
  queryVector: number[],
  focusDistanceMap: Map<string, number> | undefined,
): SemanticSearchHit[] {
  const queryLower = query.toLowerCase();
  const hits: SemanticSearchHit[] = [];

  for (const record of records) {
    const vectorScore = cosineSimilarity(queryVector, record.vector);
    const tokenScore = tokenOverlapScore(queryTokens, record.tokens);
    const phraseBoost = record.title.toLowerCase().includes(queryLower) || record.summary.toLowerCase().includes(queryLower)
      ? 0.12
      : 0;
    const recencyBoost = 1 / (1 + (record.order * CORPUS_RECENCY_DECAY));
    const distanceBoost = record.nodeId ? getDistanceBoost(focusDistanceMap, record.nodeId) : 0;

    const score = (vectorScore * 0.62)
      + (tokenScore * 0.25)
      + phraseBoost
      + (recencyBoost * 0.05)
      + distanceBoost;

    if (score <= 0.05) {
      continue;
    }

    hits.push({
      id: record.id,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      filePath: record.filePath,
      score,
      nodeId: record.nodeId,
      uriString: record.uriString,
      lineNumber: record.lineNumber,
      reasons: buildSemanticReasons(vectorScore, tokenScore, distanceBoost, phraseBoost, record.role),
    });
  }

  return hits;
}

function buildSemanticReasons(
  vectorScore: number,
  tokenScore: number,
  distanceBoost: number,
  phraseBoost: number,
  role: WorkspaceFileRole,
): string[] {
  const reasons: string[] = [];
  reasons.push(`${role} file`);

  if (vectorScore >= 0.35) {
    reasons.push('semantic similarity');
  }

  if (tokenScore >= 0.25) {
    reasons.push('token overlap');
  }

  if (distanceBoost > 0) {
    reasons.push('graph proximity');
  }

  if (phraseBoost > 0) {
    reasons.push('phrase match');
  }

  return reasons;
}

function buildRecord(input: {
  readonly id: string;
  readonly kind: SemanticRecordKind;
  readonly title: string;
  readonly summary: string;
  readonly text: string;
  readonly filePath: string;
  readonly uri: vscode.Uri;
  readonly lineNumber?: number;
  readonly role: WorkspaceFileRole;
  readonly order: number;
  readonly nodeId?: string;
}): SemanticRecord {
  const tokens = new Set(tokenizeText(input.text));
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    filePath: input.filePath,
    uriString: input.uri.toString(),
    lineNumber: input.lineNumber,
    nodeId: input.nodeId,
    tokens,
    vector: embedTokens([...tokens]),
    role: input.role,
    order: input.order,
  };
}

function buildChunkSummary(filePath: string, role: WorkspaceFileRole, chunkNumber: number, chunkCount: number, chunk: { text: string }): string {
  const preview = chunk.text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 4).join(' | ');
  return `${role} file chunk ${chunkNumber}/${chunkCount} from ${filePath}${preview ? `: ${preview}` : ''}`;
}

function buildSymbolSummary(node: GraphNode, graph: WorkspaceGraph): string {
  const relatedNames = [...new Set([
    ...node.outgoingCalls,
    ...node.implementations,
    ...node.references.reads,
    ...node.references.writes,
  ])]
    .map((nodeId) => graph.nodes.get(nodeId)?.symbolName)
    .filter((value): value is string => typeof value === 'string')
    .slice(0, 6);

  const relationshipSummary = [
    `calls ${node.outgoingCalls.length}`,
    `implements ${node.implementations.length}`,
    `reads ${node.references.reads.length}`,
    `writes ${node.references.writes.length}`,
  ].join(', ');

  return `Symbol ${node.symbolName} (${node.nodeType}) in ${node.filePath}:${node.lineNumber}. ${relationshipSummary}.${relatedNames.length > 0 ? ` Related: ${relatedNames.join(', ')}.` : ''}`;
}

function buildSymbolText(node: GraphNode, graph: WorkspaceGraph): string {
  const nearbyNames = [...new Set([
    ...node.outgoingCalls,
    ...node.implementations,
    ...node.references.reads,
    ...node.references.writes,
  ])]
    .map((nodeId) => graph.nodes.get(nodeId)?.symbolName)
    .filter((value): value is string => typeof value === 'string');

  return [
    node.symbolName,
    node.nodeType,
    node.filePath,
    `line ${node.lineNumber}`,
    `calls ${node.outgoingCalls.length}`,
    `implements ${node.implementations.length}`,
    `reads ${node.references.reads.length}`,
    `writes ${node.references.writes.length}`,
    nearbyNames.join(' '),
  ].join(' ');
}

function splitIntoChunks(
  text: string,
  maxLines: number,
  overlap: number,
  maxChunks: number,
): Array<{ text: string; startLine: number }> {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }

  const chunks: Array<{ text: string; startLine: number }> = [];
  const step = Math.max(1, maxLines - overlap);
  for (let start = 0; start < lines.length && chunks.length < maxChunks; start += step) {
    const end = Math.min(lines.length, start + maxLines);
    const slice = lines.slice(start, end).join('\n').trim();
    if (slice.length === 0) {
      continue;
    }

    chunks.push({
      text: slice,
      startLine: start,
    });
  }

  return chunks;
}

function tokenizeText(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./\\]/g, ' ')
    .toLowerCase();

  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const expanded: string[] = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token) || token.length < 2) {
      continue;
    }

    expanded.push(token);
  }

  return expanded;
}

function embedTokens(tokens: readonly string[]): number[] {
  const vector = new Array<number>(SEMANTIC_VECTOR_DIMENSION).fill(0);
  for (const token of tokens) {
    const index = tokenHash(token) % SEMANTIC_VECTOR_DIMENSION;
    vector[index] += 1;
  }

  return normalizeVector(vector);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function normalizeVector(vector: number[]): number[] {
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }

  if (magnitude === 0) {
    return vector;
  }

  const divisor = Math.sqrt(magnitude);
  return vector.map((value) => value / divisor);
}

function tokenHash(token: string): number {
  const digest = crypto.createHash('sha256').update(token).digest();
  return digest.readUInt32BE(0);
}

function tokenOverlapScore(queryTokens: readonly string[] | Set<string>, candidateTokens: readonly string[] | Set<string>): number {
  const querySet = queryTokens instanceof Set ? queryTokens : new Set(queryTokens);
  const candidateSet = candidateTokens instanceof Set ? candidateTokens : new Set(candidateTokens);

  if (querySet.size === 0 || candidateSet.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of querySet) {
    if (candidateSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.sqrt(querySet.size * candidateSet.size);
}

function createGraphSignature(graph: WorkspaceGraph): string {
  const hash = crypto.createHash('sha256');
  hash.update(String(graph.builtAt?.toISOString() ?? 'unknown'));
  hash.update(`|nodes:${graph.nodes.size}`);
  hash.update(`|files:${graph.fileIndex.size}`);

  if (graph.fileRoleSummary) {
    hash.update(`|roles:${graph.fileRoleSummary.source}:${graph.fileRoleSummary.test}:${graph.fileRoleSummary.documentation}:${graph.fileRoleSummary.template}:${graph.fileRoleSummary.other}`);
  }

  return hash.digest('hex');
}

function findBestGraphNodeId(graph: WorkspaceGraph, uri: vscode.Uri, startLine: number): string | undefined {
  const filePath = toWorkspaceRelativePath(uri);
  const fileNodeIds = graph.fileIndex.get(filePath) ?? [];
  if (fileNodeIds.length === 0) {
    return undefined;
  }

  let bestNodeId: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const nodeId of fileNodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) {
      continue;
    }

    const distance = Math.abs(node.rangeStartLine - startLine);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNodeId = nodeId;
    }
  }

  return bestNodeId;
}

function buildGraphDistanceMap(graph: WorkspaceGraph, startNodeId: string, maxDepth: number): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (distances.has(current.nodeId)) {
      continue;
    }

    distances.set(current.nodeId, current.depth);
    if (current.depth >= maxDepth) {
      continue;
    }

    const node = graph.nodes.get(current.nodeId);
    if (!node) {
      continue;
    }

    for (const neighborId of getNeighborIds(node)) {
      if (!distances.has(neighborId)) {
        queue.push({ nodeId: neighborId, depth: current.depth + 1 });
      }
    }
  }

  return distances;
}

function getNeighborIds(node: GraphNode): string[] {
  return [...new Set([
    ...node.outgoingCalls,
    ...node.implementations,
    ...node.references.reads,
    ...node.references.writes,
    ...node.incomingCalls,
    ...node.incomingImplementations,
    ...node.incomingReferences.reads,
    ...node.incomingReferences.writes,
  ])];
}

function getDistanceBoost(distanceMap: Map<string, number> | undefined, nodeId: string): number {
  if (!distanceMap) {
    return 0;
  }

  const distance = distanceMap.get(nodeId);
  if (distance === undefined) {
    return 0;
  }

  return 1 / (distance + 1);
}

function symbolKindLabel(kind: vscode.SymbolKind): string {
  const label = (vscode.SymbolKind as unknown as Record<number, string>)[kind];
  return typeof label === 'string' ? label : `SymbolKind(${kind.toString()})`;
}