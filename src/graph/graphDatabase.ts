import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Schema version – bump when the DDL changes in a breaking way
// ---------------------------------------------------------------------------
export const DB_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    id                    TEXT    PRIMARY KEY,
    symbol_name           TEXT    NOT NULL,
    symbol_kind           INTEGER NOT NULL,
    node_type             TEXT    NOT NULL,
    file_path             TEXT    NOT NULL,
    uri_string            TEXT    NOT NULL,
    line_number           INTEGER NOT NULL,
    range_start_line      INTEGER NOT NULL,
    range_start_character INTEGER NOT NULL,
    range_end_line        INTEGER NOT NULL,
    range_end_character   INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS edges (
    source_id         TEXT NOT NULL,
    target_id         TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id, relationship_type)
  );

  CREATE TABLE IF NOT EXISTS file_relationships (
    source_file_path  TEXT NOT NULL,
    target_file_path  TEXT NOT NULL,
    source_uri_string TEXT NOT NULL,
    target_uri_string TEXT NOT NULL,
    relationship      TEXT NOT NULL,
    PRIMARY KEY (source_file_path, target_file_path, relationship)
  );

  CREATE TABLE IF NOT EXISTS file_modified_times (
    file_path TEXT PRIMARY KEY,
    mtime     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS symbol_cache (
    node_id         TEXT PRIMARY KEY,
    serialized_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_file    ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(target_id);
`;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Flat row shape returned from the nodes table (camelCase). */
export interface GraphNodeDbRow {
  id: string;
  symbolName: string;
  symbolKind: number;
  nodeType: string;
  filePath: string;
  uriString: string;
  lineNumber: number;
  rangeStartLine: number;
  rangeStartCharacter: number;
  rangeEndLine: number;
  rangeEndCharacter: number;
}

/** Full DB snapshot used to reconstruct the in-memory graph on startup. */
export interface GraphDatabaseSnapshot {
  /** All persisted nodes keyed by id. */
  nodes: Map<string, GraphNodeDbRow>;
  /**
   * Per-source-node outgoing edge list, encoded as "type:targetId" strings so
   * the caller can split on ":" once to recover both parts.
   */
  outgoingEdges: Map<string, string[]>;
  /** Flat edge list – easier to iterate when rebuilding node arrays. */
  allEdges: Array<{ sourceId: string; targetId: string; type: string }>;
  fileModifiedTimes: Map<string, number>;
  /** Raw JSON strings keyed by node id – caller deserialises. */
  symbolCacheJson: Map<string, string>;
  fileRelationships: Array<{
    sourceFilePath: string;
    targetFilePath: string;
    sourceUriString: string;
    targetUriString: string;
    relationship: string;
  }>;
  builtAtIso?: string;
  fileRoleSummaryJson?: string;
}

/** Parameter shape for upsertNode (matches GraphNode sans relationship arrays). */
export interface NodeUpsertParam {
  id: string;
  symbolName: string;
  symbolKind: number;
  nodeType: string;
  filePath: string;
  uriString: string;
  lineNumber: number;
  rangeStartLine: number;
  rangeStartCharacter: number;
  rangeEndLine: number;
  rangeEndCharacter: number;
}

// ---------------------------------------------------------------------------
// Internal raw row shapes (snake_case from SQLite)
// ---------------------------------------------------------------------------
interface RawNodeRow {
  id: string;
  symbol_name: string;
  symbol_kind: number;
  node_type: string;
  file_path: string;
  uri_string: string;
  line_number: number;
  range_start_line: number;
  range_start_character: number;
  range_end_line: number;
  range_end_character: number;
}

interface RawEdgeRow {
  source_id: string;
  target_id: string;
  relationship_type: string;
}

interface RawFileRelRow {
  source_file_path: string;
  target_file_path: string;
  source_uri_string: string;
  target_uri_string: string;
  relationship: string;
}

interface RawMtimeRow {
  file_path: string;
  mtime: number;
}

interface RawCacheRow {
  node_id: string;
  serialized_json: string;
}

interface RawMetaRow {
  value: string;
}

interface RawCountRow {
  count: number;
}

// ---------------------------------------------------------------------------
// GraphDatabase
// ---------------------------------------------------------------------------

/**
 * Synchronous SQLite wrapper (via better-sqlite3) that persists the VSContext
 * workspace graph.  All public methods are synchronous except where the caller
 * supplies a callback wrapped in `transaction()`.
 */
export class GraphDatabase {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open (or create) the database at `dbPath`, run DDL, and return a ready
   * `GraphDatabase` instance.
   */
  static open(dbPath: string): GraphDatabase {
    // Ensure the parent directory exists so Database() doesn't throw.
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const raw = new Database(dbPath);

    // Performance pragmas – safe for our single-writer use-case.
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');

    const instance = new GraphDatabase(raw);
    instance.initSchema();

    // Bootstrap schema-version metadata on a brand-new database.
    if (instance.getSchemaVersion() === 0) {
      instance.setMetadata('schemaVersion', String(DB_SCHEMA_VERSION));
    }

    return instance;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  /** Insert or replace a single node row. */
  upsertNode(node: NodeUpsertParam): void {
    this.db
      .prepare<unknown[]>(`
        INSERT OR REPLACE INTO nodes
          (id, symbol_name, symbol_kind, node_type, file_path, uri_string,
           line_number, range_start_line, range_start_character,
           range_end_line, range_end_character, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `)
      .run(
        node.id,
        node.symbolName,
        node.symbolKind,
        node.nodeType,
        node.filePath,
        node.uriString,
        node.lineNumber,
        node.rangeStartLine,
        node.rangeStartCharacter,
        node.rangeEndLine,
        node.rangeEndCharacter,
      );
  }

  /**
   * Delete every node belonging to `filePath`.
   * Returns the number of rows deleted.
   *
   * **Important:** call `deleteEdgesForFile()` *before* this method so the
   * edge-deletion subquery can still resolve node ids.
   */
  deleteNodesByFile(filePath: string): number {
    return this.db
      .prepare<[string]>('DELETE FROM nodes WHERE file_path = ?')
      .run(filePath).changes;
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  /** Insert an edge (source → target with a relationship type), ignoring
   *  duplicates. */
  upsertEdge(
    sourceId: string,
    targetId: string,
    type: 'calls' | 'implements' | 'reads' | 'writes',
  ): void {
    this.db
      .prepare<[string, string, string]>(`
        INSERT OR IGNORE INTO edges (source_id, target_id, relationship_type)
        VALUES (?, ?, ?)
      `)
      .run(sourceId, targetId, type);
  }

  /**
   * Delete all edges whose source node lives in `filePath`.
   *
   * **Must be called before `deleteNodesByFile()`** so that the subquery
   * `SELECT id FROM nodes WHERE file_path = ?` still returns results.
   */
  deleteEdgesForFile(filePath: string): void {
    this.db
      .prepare<[string]>(`
        DELETE FROM edges
        WHERE source_id IN (SELECT id FROM nodes WHERE file_path = ?)
      `)
      .run(filePath);
  }

  // -------------------------------------------------------------------------
  // File relationships
  // -------------------------------------------------------------------------

  /** Upsert a single file-level relationship. */
  upsertFileRelationship(
    sourceFilePath: string,
    targetFilePath: string,
    sourceUri: string,
    targetUri: string,
    relationship: string,
  ): void {
    this.db
      .prepare<[string, string, string, string, string]>(`
        INSERT OR REPLACE INTO file_relationships
          (source_file_path, target_file_path, source_uri_string,
           target_uri_string, relationship)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sourceFilePath, targetFilePath, sourceUri, targetUri, relationship);
  }

  /** Delete all file relationships where `source_file_path` matches. */
  deleteFileRelationshipsForFile(filePath: string): void {
    this.db
      .prepare<[string]>('DELETE FROM file_relationships WHERE source_file_path = ?')
      .run(filePath);
  }

  /**
   * Atomically replace the entire file_relationships table with a new set.
   * Runs inside its own transaction.
   */
  replaceAllFileRelationships(
    relationships: Array<{
      sourceFilePath: string;
      targetFilePath: string;
      sourceUriString: string;
      targetUriString: string;
      relationship: string;
    }>,
  ): void {
    const deleteAll = this.db.prepare('DELETE FROM file_relationships');
    const insert = this.db.prepare<[string, string, string, string, string]>(`
      INSERT OR REPLACE INTO file_relationships
        (source_file_path, target_file_path, source_uri_string,
         target_uri_string, relationship)
      VALUES (?, ?, ?, ?, ?)
    `);

    const run = this.db.transaction(() => {
      deleteAll.run();
      for (const rel of relationships) {
        insert.run(
          rel.sourceFilePath,
          rel.targetFilePath,
          rel.sourceUriString,
          rel.targetUriString,
          rel.relationship,
        );
      }
    });

    run();
  }

  // -------------------------------------------------------------------------
  // File modified times
  // -------------------------------------------------------------------------

  setFileModifiedTime(filePath: string, mtime: number): void {
    this.db
      .prepare<[string, number]>(`
        INSERT OR REPLACE INTO file_modified_times (file_path, mtime)
        VALUES (?, ?)
      `)
      .run(filePath, mtime);
  }

  deleteFileModifiedTime(filePath: string): void {
    this.db
      .prepare<[string]>('DELETE FROM file_modified_times WHERE file_path = ?')
      .run(filePath);
  }

  getAllFileModifiedTimes(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT file_path, mtime FROM file_modified_times')
      .all() as RawMtimeRow[];

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.file_path, row.mtime);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Symbol cache
  // -------------------------------------------------------------------------

  upsertSymbolCache(nodeId: string, serializedJson: string): void {
    this.db
      .prepare<[string, string]>(`
        INSERT OR REPLACE INTO symbol_cache (node_id, serialized_json)
        VALUES (?, ?)
      `)
      .run(nodeId, serializedJson);
  }

  /**
   * Delete symbol-cache entries for all nodes that belong to `filePath`.
   *
   * **Must be called before `deleteNodesByFile()`** so the subquery resolves.
   *
   * The parameter is named `nodeIdPrefix` in the public API to signal that
   * callers may also use it as a node-id prefix filter; internally we join
   * against the nodes table to be precise.
   */
  deleteSymbolCacheForFile(nodeIdPrefix: string): void {
    this.db
      .prepare<[string]>(`
        DELETE FROM symbol_cache
        WHERE node_id IN (SELECT id FROM nodes WHERE file_path = ?)
      `)
      .run(nodeIdPrefix);
  }

  getAllSymbolCache(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT node_id, serialized_json FROM symbol_cache')
      .all() as RawCacheRow[];

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.node_id, row.serialized_json);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Workspace metadata
  // -------------------------------------------------------------------------

  setMetadata(key: string, value: string): void {
    this.db
      .prepare<[string, string]>(`
        INSERT OR REPLACE INTO workspace_metadata (key, value)
        VALUES (?, ?)
      `)
      .run(key, value);
  }

  getMetadata(key: string): string | undefined {
    const row = this.db
      .prepare<[string]>('SELECT value FROM workspace_metadata WHERE key = ?')
      .get(key) as RawMetaRow | undefined;
    return row?.value;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Read the entire database into memory and return a `GraphDatabaseSnapshot`.
   * The caller uses this to reconstruct the in-memory `WorkspaceGraph`.
   */
  snapshot(): GraphDatabaseSnapshot {
    // --- Nodes ---
    const rawNodes = this.db
      .prepare('SELECT * FROM nodes')
      .all() as RawNodeRow[];

    const nodes = new Map<string, GraphNodeDbRow>();
    for (const r of rawNodes) {
      nodes.set(r.id, {
        id: r.id,
        symbolName: r.symbol_name,
        symbolKind: r.symbol_kind,
        nodeType: r.node_type,
        filePath: r.file_path,
        uriString: r.uri_string,
        lineNumber: r.line_number,
        rangeStartLine: r.range_start_line,
        rangeStartCharacter: r.range_start_character,
        rangeEndLine: r.range_end_line,
        rangeEndCharacter: r.range_end_character,
      });
    }

    // --- Edges ---
    const rawEdges = this.db
      .prepare('SELECT source_id, target_id, relationship_type FROM edges')
      .all() as RawEdgeRow[];

    const allEdges: Array<{ sourceId: string; targetId: string; type: string }> = [];
    const outgoingEdges = new Map<string, string[]>();

    for (const r of rawEdges) {
      allEdges.push({
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.relationship_type,
      });

      // Encode as "type:targetId" so the caller can split on ":" once.
      const encoded = `${r.relationship_type}:${r.target_id}`;
      const existing = outgoingEdges.get(r.source_id);
      if (existing) {
        existing.push(encoded);
      } else {
        outgoingEdges.set(r.source_id, [encoded]);
      }
    }

    // --- File modified times ---
    const fileModifiedTimes = this.getAllFileModifiedTimes();

    // --- Symbol cache ---
    const symbolCacheJson = this.getAllSymbolCache();

    // --- File relationships ---
    const rawRels = this.db
      .prepare('SELECT * FROM file_relationships')
      .all() as RawFileRelRow[];

    const fileRelationships = rawRels.map((r) => ({
      sourceFilePath: r.source_file_path,
      targetFilePath: r.target_file_path,
      sourceUriString: r.source_uri_string,
      targetUriString: r.target_uri_string,
      relationship: r.relationship,
    }));

    // --- Metadata ---
    const builtAtIso = this.getMetadata('builtAtIso');
    const fileRoleSummaryJson = this.getMetadata('fileRoleSummary');

    return {
      nodes,
      outgoingEdges,
      allEdges,
      fileModifiedTimes,
      symbolCacheJson,
      fileRelationships,
      builtAtIso,
      fileRoleSummaryJson,
    };
  }

  // -------------------------------------------------------------------------
  // Transaction helper
  // -------------------------------------------------------------------------

  /**
   * Execute `fn` inside a SQLite transaction.  If `fn` throws the transaction
   * is rolled back; otherwise it is committed.  The return value of `fn` is
   * forwarded to the caller.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)() as T;
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Remove edges whose source or target node no longer exists.
   * Returns the number of orphaned edge rows deleted.
   */
  cleanup(): { orphanedEdges: number } {
    const result = this.db
      .prepare(`
        DELETE FROM edges
        WHERE source_id NOT IN (SELECT id FROM nodes)
           OR target_id NOT IN (SELECT id FROM nodes)
      `)
      .run();

    return { orphanedEdges: result.changes };
  }

  /** Return high-level row counts for diagnostics / logging. */
  stats(): { nodeCount: number; edgeCount: number; filePaths: number } {
    const nodeCount = (
      this.db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as RawCountRow
    ).count;

    const edgeCount = (
      this.db.prepare('SELECT COUNT(*) AS count FROM edges').get() as RawCountRow
    ).count;

    const filePaths = (
      this.db
        .prepare('SELECT COUNT(DISTINCT file_path) AS count FROM nodes')
        .get() as RawCountRow
    ).count;

    return { nodeCount, edgeCount, filePaths };
  }

  // -------------------------------------------------------------------------
  // Schema version
  // -------------------------------------------------------------------------

  /**
   * Return the persisted schema version, or 0 if the metadata row does not
   * exist yet (i.e. this is a brand-new database).
   */
  getSchemaVersion(): number {
    const value = this.getMetadata('schemaVersion');
    if (!value) {
      return 0;
    }
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
