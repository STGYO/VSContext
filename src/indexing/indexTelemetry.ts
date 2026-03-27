import { Logger } from '../utils/logger';

/**
 * Metrics for indexing operations and cache management.
 * Used for telemetry, logging, and UI progress reporting.
 */
export interface IndexingMetrics {
  readonly stage: 'initialization' | 'hydration' | 'reconciliation' | 'full-build' | 'incremental-update';
  readonly startTimeMs: number;
  readonly filesScanAdded: number;
  readonly filesScanSkipped: number;
  readonly filesIndexedAdded: number;
  readonly filesIndexedUpdated: number;
  readonly filesIndexedRemoved: number;
  readonly symbolsAdded: number;
  readonly symbolsRemoved: number;
  readonly edgesAdded: number;
  readonly edgesRemoved: number;
  readonly relationshipsAdded: number;
  readonly relationshipsRemoved: number;
  readonly cacheHitsSemanticRecords: number;
  readonly cacheHitRate?: number;
  readonly elapsedMs?: number;
}

interface MutableIndexingMetrics {
  stage: 'initialization' | 'hydration' | 'reconciliation' | 'full-build' | 'incremental-update';
  startTimeMs: number;
  filesScanAdded: number;
  filesScanSkipped: number;
  filesIndexedAdded: number;
  filesIndexedUpdated: number;
  filesIndexedRemoved: number;
  symbolsAdded: number;
  symbolsRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  relationshipsAdded: number;
  relationshipsRemoved: number;
  cacheHitsSemanticRecords: number;
}

export interface CacheVersionInfo {
  readonly graphCacheVersion: number;
  readonly semanticCacheVersion: number;
  readonly schemaVersion: number;
  readonly builtAtIso?: string;
  readonly cachedFileCount?: number;
  readonly cachedSymbolCount?: number;
  readonly cachedChunkCount?: number;
}

export interface IncrementalDelta {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
  readonly totalChanges: number;
}

/**
 * Telemetry collector for indexing operations.
 * Provides structured metrics for monitoring, logging, and progress reporting.
 */
export class IndexTelemetry {
  private metrics: MutableIndexingMetrics;

  public constructor(
    private readonly logger: Logger,
    stage: 'initialization' | 'hydration' | 'reconciliation' | 'full-build' | 'incremental-update',
  ) {
    this.metrics = {
      stage,
      startTimeMs: Date.now(),
      filesScanAdded: 0,
      filesScanSkipped: 0,
      filesIndexedAdded: 0,
      filesIndexedUpdated: 0,
      filesIndexedRemoved: 0,
      symbolsAdded: 0,
      symbolsRemoved: 0,
      edgesAdded: 0,
      edgesRemoved: 0,
      relationshipsAdded: 0,
      relationshipsRemoved: 0,
      cacheHitsSemanticRecords: 0,
    };
  }

  public recordFileScanAdded(): void {
    this.metrics.filesScanAdded += 1;
  }

  public recordFileScanSkipped(): void {
    this.metrics.filesScanSkipped += 1;
  }

  public recordFilesIndexed(added: number, updated: number, removed: number): void {
    this.metrics.filesIndexedAdded += added;
    this.metrics.filesIndexedUpdated += updated;
    this.metrics.filesIndexedRemoved += removed;
  }

  public recordSymbols(added: number, removed: number): void {
    this.metrics.symbolsAdded += added;
    this.metrics.symbolsRemoved += removed;
  }

  public recordEdges(added: number, removed: number): void {
    this.metrics.edgesAdded += added;
    this.metrics.edgesRemoved -= removed;
  }

  public recordRelationships(added: number, removed: number): void {
    this.metrics.relationshipsAdded += added;
    this.metrics.relationshipsRemoved += removed;
  }

  public recordSemanticCacheHits(count: number): void {
    this.metrics.cacheHitsSemanticRecords += count;
  }

  public finish(): IndexingMetrics {
    const now = Date.now();
    const elapsedMs = now - this.metrics.startTimeMs;
    const totalScanned = this.metrics.filesScanAdded + this.metrics.filesScanSkipped;
    const cacheHitRate = totalScanned > 0 ? this.metrics.cacheHitsSemanticRecords / totalScanned : undefined;

    const completed = {
      ...this.metrics,
      elapsedMs,
      cacheHitRate,
    };

    return completed;
  }

  public logSummary(metrics: IndexingMetrics): void {
    const stageName = metrics.stage.replace('-', ' ').replace(/^./, (c) => c.toUpperCase());
    const duration = metrics.elapsedMs ? ` (${metrics.elapsedMs}ms)` : '';
    const fileOps = `${metrics.filesIndexedAdded} added, ${metrics.filesIndexedUpdated} updated, ${metrics.filesIndexedRemoved} removed`;
    const symbolOps = `${metrics.symbolsAdded} added, ${metrics.symbolsRemoved} removed`;
    const relationshipOps = `${metrics.relationshipsAdded} added, ${metrics.relationshipsRemoved} removed`;
    const cacheRate = metrics.cacheHitRate ? ` (${(metrics.cacheHitRate * 100).toFixed(1)}%)` : '';

    this.logger.info(`[VSContext Telemetry] ${stageName}${duration}`);
    this.logger.info(`  Files: ${fileOps}`);
    this.logger.info(`  Symbols: ${symbolOps}`);
    this.logger.info(`  Relationships: ${relationshipOps}`);
    this.logger.info(`  Semantic cache hits${cacheRate}`);
  }
}

/**
 * Cache version manager for graph and semantic indexes.
 * Ensures safe cache invalidation across versions.
 */
export class CacheVersionManager {
  public static readonly GRAPH_CACHE_VERSION = 4;
  public static readonly SEMANTIC_CACHE_VERSION = 2;
  public static readonly SCHEMA_VERSION = 2;

  public static isCacheValid(stored: CacheVersionInfo): boolean {
    return (
      stored.graphCacheVersion === this.GRAPH_CACHE_VERSION &&
      stored.semanticCacheVersion === this.SEMANTIC_CACHE_VERSION &&
      stored.schemaVersion === this.SCHEMA_VERSION
    );
  }

  public static current(): CacheVersionInfo {
    return {
      graphCacheVersion: this.GRAPH_CACHE_VERSION,
      semanticCacheVersion: this.SEMANTIC_CACHE_VERSION,
      schemaVersion: this.SCHEMA_VERSION,
    };
  }

  public static describeMismatch(stored: CacheVersionInfo): string {
    const mismatches: string[] = [];

    if (stored.graphCacheVersion !== this.GRAPH_CACHE_VERSION) {
      mismatches.push(`graph cache v${stored.graphCacheVersion} → v${this.GRAPH_CACHE_VERSION}`);
    }

    if (stored.semanticCacheVersion !== this.SEMANTIC_CACHE_VERSION) {
      mismatches.push(`semantic cache v${stored.semanticCacheVersion} → v${this.SEMANTIC_CACHE_VERSION}`);
    }

    if (stored.schemaVersion !== this.SCHEMA_VERSION) {
      mismatches.push(`schema v${stored.schemaVersion} → v${this.SCHEMA_VERSION}`);
    }

    return mismatches.length > 0 ? mismatches.join('; ') : 'unknown mismatch';
  }
}

/**
 * Tracks incremental changes for reporting and analytics.
 */
export class IncrementalChangeTracker {
  private added = new Set<string>();
  private modified = new Set<string>();
  private deleted = new Set<string>();

  public recordAdded(filePath: string): void {
    this.added.add(filePath);
    this.modified.delete(filePath);
  }

  public recordModified(filePath: string): void {
    if (!this.added.has(filePath)) {
      this.modified.add(filePath);
    }
  }

  public recordDeleted(filePath: string): void {
    this.added.delete(filePath);
    this.modified.delete(filePath);
    this.deleted.add(filePath);
  }

  public getDelta(): IncrementalDelta {
    return {
      added: [...this.added],
      modified: [...this.modified],
      deleted: [...this.deleted],
      totalChanges: this.added.size + this.modified.size + this.deleted.size,
    };
  }

  public clear(): void {
    this.added.clear();
    this.modified.clear();
    this.deleted.clear();
  }
}
