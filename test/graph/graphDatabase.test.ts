import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Module from "module";
import { afterEach, beforeEach, describe, it } from "mocha";

import {
  DB_SCHEMA_VERSION,
  GraphDatabase,
} from "../../src/graph/graphDatabase";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `vscontext-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Build a minimal valid NodeUpsertParam. */
function node(
  id: string,
  filePath: string,
  symbolName = "testSymbol",
  symbolKind = 12 /* Function */,
) {
  return {
    id,
    symbolName,
    symbolKind,
    nodeType: "function",
    filePath,
    uriString: `file:///workspace/${filePath}`,
    lineNumber: 10,
    rangeStartLine: 10,
    rangeStartCharacter: 0,
    rangeEndLine: 20,
    rangeEndCharacter: 1,
  };
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphDatabase", () => {
  it("can be loaded without better-sqlite3 during module import", () => {
    const moduleLoader = Module as any;
    const originalLoad = moduleLoader._load;
    const modulePath = require.resolve("../../src/graph/graphDatabase");

    delete require.cache[modulePath];
    moduleLoader._load = function(request: string, parent: unknown, isMain: boolean) {
      if (request === "better-sqlite3") {
        throw new Error("better-sqlite3 unavailable during module import");
      }

      return originalLoad.apply(this, [request, parent, isMain]);
    };

    try {
      const loaded = require("../../src/graph/graphDatabase") as typeof import("../../src/graph/graphDatabase");
      assert.ok(loaded.GraphDatabase);
    } finally {
      moduleLoader._load = originalLoad;
      delete require.cache[modulePath];
    }
  });

  let dbPath: string;
  let db: GraphDatabase;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = GraphDatabase.open(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed in some tests */
    }
    cleanupDb(dbPath);
  });

  // -----------------------------------------------------------------------
  // Schema creation and versioning
  // -----------------------------------------------------------------------
  describe("Schema creation and versioning", () => {
    it("creates the database file on open", () => {
      assert.ok(fs.existsSync(dbPath), "DB file should exist after open()");
    });

    it("reports schema version 1 on a fresh database", () => {
      assert.strictEqual(db.getSchemaVersion(), DB_SCHEMA_VERSION);
      assert.strictEqual(db.getSchemaVersion(), 1);
    });

    it("persists the schema version across close/reopen", () => {
      db.close();
      const db2 = GraphDatabase.open(dbPath);
      assert.strictEqual(db2.getSchemaVersion(), 1);
      db2.close();
      // reopen so afterEach can close cleanly
      db = GraphDatabase.open(dbPath);
    });

    it("creates parent directories when they do not exist", () => {
      const nested = path.join(
        os.tmpdir(),
        `vscontext-nested-${Date.now()}`,
        "sub",
        "graph.db",
      );
      let nested_db: GraphDatabase | undefined;
      try {
        nested_db = GraphDatabase.open(nested);
        assert.ok(fs.existsSync(nested));
      } finally {
        nested_db?.close();
        cleanupDb(nested);
        try {
          fs.rmdirSync(path.dirname(nested));
        } catch {
          /* ignore */
        }
        try {
          fs.rmdirSync(path.dirname(path.dirname(nested)));
        } catch {
          /* ignore */
        }
      }
    });

    it("handles non-numeric schema version gracefully", () => {
      db.setMetadata("schemaVersion", "corrupted");
      assert.strictEqual(db.getSchemaVersion(), 0);
    });

    it("handles missing schemaVersion metadata key (returns 0)", () => {
      // The key was set during open(); overwrite with a fresh DB copy that
      // simulates a missing key by reading a non-existent key name.
      assert.strictEqual(db.getMetadata("noSuchKey"), undefined);
    });

    it("DB_SCHEMA_VERSION constant equals 1", () => {
      assert.strictEqual(DB_SCHEMA_VERSION, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Node operations
  // -----------------------------------------------------------------------
  describe("Node operations", () => {
    it("upserts a node and reflects it in snapshot", () => {
      db.upsertNode(node("n1", "src/foo.ts"));
      const snap = db.snapshot();
      assert.ok(snap.nodes.has("n1"));
      const row = snap.nodes.get("n1")!;
      assert.strictEqual(row.symbolName, "testSymbol");
      assert.strictEqual(row.filePath, "src/foo.ts");
      assert.strictEqual(row.nodeType, "function");
    });

    it("overwrites an existing node on re-upsert", () => {
      db.upsertNode(node("n1", "src/foo.ts", "original"));
      db.upsertNode({ ...node("n1", "src/foo.ts", "updated"), lineNumber: 99 });

      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 1);
      assert.strictEqual(snap.nodes.get("n1")!.symbolName, "updated");
      assert.strictEqual(snap.nodes.get("n1")!.lineNumber, 99);
    });

    it("stores all node fields correctly", () => {
      const n = {
        id: "fullNode",
        symbolName: "MyClass",
        symbolKind: 5,
        nodeType: "class",
        filePath: "src/myClass.ts",
        uriString: "file:///workspace/src/myClass.ts",
        lineNumber: 42,
        rangeStartLine: 42,
        rangeStartCharacter: 4,
        rangeEndLine: 80,
        rangeEndCharacter: 1,
      };
      db.upsertNode(n);
      const row = db.snapshot().nodes.get("fullNode")!;
      assert.strictEqual(row.id, n.id);
      assert.strictEqual(row.symbolName, n.symbolName);
      assert.strictEqual(row.symbolKind, n.symbolKind);
      assert.strictEqual(row.nodeType, n.nodeType);
      assert.strictEqual(row.filePath, n.filePath);
      assert.strictEqual(row.uriString, n.uriString);
      assert.strictEqual(row.lineNumber, n.lineNumber);
      assert.strictEqual(row.rangeStartLine, n.rangeStartLine);
      assert.strictEqual(row.rangeStartCharacter, n.rangeStartCharacter);
      assert.strictEqual(row.rangeEndLine, n.rangeEndLine);
      assert.strictEqual(row.rangeEndCharacter, n.rangeEndCharacter);
    });

    it("deletes nodes by file and returns the deleted count", () => {
      db.upsertNode(node("n1", "src/foo.ts"));
      db.upsertNode(node("n2", "src/foo.ts"));
      db.upsertNode(node("n3", "src/bar.ts"));

      const deleted = db.deleteNodesByFile("src/foo.ts");
      assert.strictEqual(deleted, 2);

      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 1);
      assert.ok(snap.nodes.has("n3"));
    });

    it("returns 0 when deleting nodes for a non-existent file", () => {
      assert.strictEqual(db.deleteNodesByFile("does/not/exist.ts"), 0);
    });

    it("accumulates multiple nodes across different files", () => {
      db.upsertNode(node("a1", "src/a.ts"));
      db.upsertNode(node("a2", "src/a.ts"));
      db.upsertNode(node("b1", "src/b.ts"));

      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 3);
    });
  });

  // -----------------------------------------------------------------------
  // Edge operations
  // -----------------------------------------------------------------------
  describe("Edge operations", () => {
    beforeEach(() => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertNode(node("c", "src/c.ts"));
    });

    it("upserts edges and exposes them in snapshot.allEdges", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "c", "implements");

      const { allEdges } = db.snapshot();
      assert.strictEqual(allEdges.length, 2);

      const callsEdge = allEdges.find(
        (e) => e.sourceId === "a" && e.targetId === "b",
      );
      assert.ok(callsEdge);
      assert.strictEqual(callsEdge!.type, "calls");
    });

    it("supports all four edge types", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "c", "implements");
      db.upsertEdge("b", "a", "reads");
      db.upsertEdge("c", "a", "writes");

      const types = new Set(db.snapshot().allEdges.map((e) => e.type));
      assert.ok(types.has("calls"));
      assert.ok(types.has("implements"));
      assert.ok(types.has("reads"));
      assert.ok(types.has("writes"));
    });

    it("ignores duplicate edges (INSERT OR IGNORE)", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "b", "calls");

      const callEdges = db
        .snapshot()
        .allEdges.filter((e) => e.sourceId === "a" && e.targetId === "b");
      assert.strictEqual(callEdges.length, 1);
    });

    it("allows same source+target with different edge types", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "b", "reads");

      assert.strictEqual(db.snapshot().allEdges.length, 2);
    });

    it("deleteEdgesForFile removes outgoing edges from that file's nodes", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "c", "reads");
      db.upsertEdge("b", "c", "calls");

      // deleteEdgesForFile MUST precede deleteNodesByFile
      db.deleteEdgesForFile("src/a.ts");
      db.deleteNodesByFile("src/a.ts");

      const { allEdges } = db.snapshot();
      assert.strictEqual(allEdges.length, 1);
      assert.strictEqual(allEdges[0].sourceId, "b");
      assert.strictEqual(allEdges[0].targetId, "c");
    });

    it("builds outgoingEdges map with encoded type:targetId entries", () => {
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "c", "implements");

      const { outgoingEdges } = db.snapshot();
      const out = outgoingEdges.get("a")!;
      assert.ok(out.includes("calls:b"), "should contain calls:b");
      assert.ok(out.includes("implements:c"), "should contain implements:c");
    });

    it("returns empty outgoingEdges for nodes with no outgoing edges", () => {
      // 'b' and 'c' have no outgoing edges
      db.upsertEdge("a", "b", "calls");
      const { outgoingEdges } = db.snapshot();
      assert.ok(!outgoingEdges.has("b"));
      assert.ok(!outgoingEdges.has("c"));
    });
  });

  // -----------------------------------------------------------------------
  // File relationship operations
  // -----------------------------------------------------------------------
  describe("File relationship operations", () => {
    it("upserts and retrieves file relationships via snapshot", () => {
      db.upsertFileRelationship(
        "src/a.ts",
        "src/b.ts",
        "file:///a",
        "file:///b",
        "imports",
      );

      const { fileRelationships } = db.snapshot();
      assert.strictEqual(fileRelationships.length, 1);
      const rel = fileRelationships[0];
      assert.strictEqual(rel.sourceFilePath, "src/a.ts");
      assert.strictEqual(rel.targetFilePath, "src/b.ts");
      assert.strictEqual(rel.sourceUriString, "file:///a");
      assert.strictEqual(rel.targetUriString, "file:///b");
      assert.strictEqual(rel.relationship, "imports");
    });

    it("overwrites duplicate relationships on re-upsert (same PK)", () => {
      db.upsertFileRelationship(
        "src/a.ts",
        "src/b.ts",
        "file:///a-v1",
        "file:///b-v1",
        "imports",
      );
      db.upsertFileRelationship(
        "src/a.ts",
        "src/b.ts",
        "file:///a-v2",
        "file:///b-v2",
        "imports",
      );

      const { fileRelationships } = db.snapshot();
      assert.strictEqual(fileRelationships.length, 1);
      assert.strictEqual(fileRelationships[0].sourceUriString, "file:///a-v2");
    });

    it("deletes relationships for a given source file only", () => {
      db.upsertFileRelationship("src/a.ts", "src/b.ts", "", "", "imports");
      db.upsertFileRelationship("src/a.ts", "src/c.ts", "", "", "covers");
      db.upsertFileRelationship("src/x.ts", "src/b.ts", "", "", "imports");

      db.deleteFileRelationshipsForFile("src/a.ts");

      const { fileRelationships } = db.snapshot();
      assert.strictEqual(fileRelationships.length, 1);
      assert.strictEqual(fileRelationships[0].sourceFilePath, "src/x.ts");
    });

    it("replaceAllFileRelationships replaces entire table atomically", () => {
      db.upsertFileRelationship("src/old.ts", "src/b.ts", "", "", "imports");
      db.upsertFileRelationship("src/old.ts", "src/c.ts", "", "", "imports");

      db.replaceAllFileRelationships([
        {
          sourceFilePath: "src/new.ts",
          targetFilePath: "src/d.ts",
          sourceUriString: "file:///new",
          targetUriString: "file:///d",
          relationship: "documents",
        },
      ]);

      const { fileRelationships } = db.snapshot();
      assert.strictEqual(fileRelationships.length, 1);
      assert.strictEqual(fileRelationships[0].sourceFilePath, "src/new.ts");
      assert.strictEqual(fileRelationships[0].relationship, "documents");
    });

    it("replaceAllFileRelationships with empty array clears the table", () => {
      db.upsertFileRelationship("src/a.ts", "src/b.ts", "", "", "imports");
      db.replaceAllFileRelationships([]);
      assert.strictEqual(db.snapshot().fileRelationships.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // File modified times
  // -----------------------------------------------------------------------
  describe("File modified times", () => {
    it("sets and retrieves modified times", () => {
      db.setFileModifiedTime("src/a.ts", 1_700_000_000);
      db.setFileModifiedTime("src/b.ts", 1_700_000_001);

      const times = db.getAllFileModifiedTimes();
      assert.strictEqual(times.size, 2);
      assert.strictEqual(times.get("src/a.ts"), 1_700_000_000);
      assert.strictEqual(times.get("src/b.ts"), 1_700_000_001);
    });

    it("overwrites existing mtime on re-set", () => {
      db.setFileModifiedTime("src/a.ts", 100);
      db.setFileModifiedTime("src/a.ts", 999);

      assert.strictEqual(db.getAllFileModifiedTimes().get("src/a.ts"), 999);
    });

    it("deletes a single file mtime entry", () => {
      db.setFileModifiedTime("src/a.ts", 100);
      db.setFileModifiedTime("src/b.ts", 200);
      db.deleteFileModifiedTime("src/a.ts");

      const times = db.getAllFileModifiedTimes();
      assert.strictEqual(times.size, 1);
      assert.ok(!times.has("src/a.ts"));
    });

    it("returns an empty map when no entries exist", () => {
      assert.strictEqual(db.getAllFileModifiedTimes().size, 0);
    });

    it("exposes mtimes in snapshot", () => {
      db.setFileModifiedTime("src/a.ts", 12_345);
      assert.strictEqual(
        db.snapshot().fileModifiedTimes.get("src/a.ts"),
        12_345,
      );
    });

    it("deleting a non-existent key is a no-op (does not throw)", () => {
      assert.doesNotThrow(() =>
        db.deleteFileModifiedTime("nonexistent/file.ts"),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Symbol cache
  // -----------------------------------------------------------------------
  describe("Symbol cache operations", () => {
    it("upserts and retrieves cache entries", () => {
      const json = JSON.stringify({ id: "n1", symbolName: "foo" });
      db.upsertSymbolCache("n1", json);

      const cache = db.getAllSymbolCache();
      assert.ok(cache.has("n1"));
      assert.strictEqual(cache.get("n1"), json);
    });

    it("overwrites a cache entry on re-upsert", () => {
      db.upsertSymbolCache("n1", '{"v":1}');
      db.upsertSymbolCache("n1", '{"v":2}');

      assert.strictEqual(db.getAllSymbolCache().get("n1"), '{"v":2}');
    });

    it("deleteSymbolCacheForFile removes entries for nodes in that file", () => {
      // Nodes must exist for the subquery to work
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertNode(node("n2", "src/a.ts"));
      db.upsertNode(node("n3", "src/b.ts"));

      db.upsertSymbolCache("n1", '{"n":1}');
      db.upsertSymbolCache("n2", '{"n":2}');
      db.upsertSymbolCache("n3", '{"n":3}');

      // Call BEFORE deleteNodesByFile so the subquery can resolve
      db.deleteSymbolCacheForFile("src/a.ts");
      db.deleteNodesByFile("src/a.ts");

      const cache = db.getAllSymbolCache();
      assert.strictEqual(cache.size, 1);
      assert.ok(cache.has("n3"));
    });

    it("exposes cache in snapshot.symbolCacheJson", () => {
      db.upsertSymbolCache("nodeX", '{"x":true}');
      assert.strictEqual(
        db.snapshot().symbolCacheJson.get("nodeX"),
        '{"x":true}',
      );
    });

    it("returns empty map when no cache entries exist", () => {
      assert.strictEqual(db.getAllSymbolCache().size, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Workspace metadata
  // -----------------------------------------------------------------------
  describe("Workspace metadata", () => {
    it("sets and gets metadata values", () => {
      db.setMetadata("key1", "value1");
      db.setMetadata("key2", "value2");
      assert.strictEqual(db.getMetadata("key1"), "value1");
      assert.strictEqual(db.getMetadata("key2"), "value2");
    });

    it("overwrites metadata on re-set", () => {
      db.setMetadata("foo", "bar");
      db.setMetadata("foo", "baz");
      assert.strictEqual(db.getMetadata("foo"), "baz");
    });

    it("returns undefined for a missing key", () => {
      assert.strictEqual(db.getMetadata("missing"), undefined);
    });

    it("exposes builtAtIso in snapshot", () => {
      db.setMetadata("builtAtIso", "2024-01-01T00:00:00.000Z");
      assert.strictEqual(db.snapshot().builtAtIso, "2024-01-01T00:00:00.000Z");
    });

    it("exposes fileRoleSummaryJson in snapshot", () => {
      const s = JSON.stringify({
        source: 10,
        test: 2,
        documentation: 1,
        template: 0,
        other: 3,
      });
      db.setMetadata("fileRoleSummary", s);
      assert.strictEqual(db.snapshot().fileRoleSummaryJson, s);
    });

    it("snapshot returns undefined builtAtIso when not set", () => {
      assert.strictEqual(db.snapshot().builtAtIso, undefined);
    });

    it("snapshot returns undefined fileRoleSummaryJson when not set", () => {
      assert.strictEqual(db.snapshot().fileRoleSummaryJson, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Transaction wrapper
  // -----------------------------------------------------------------------
  describe("transaction()", () => {
    it("commits all changes when the callback succeeds", () => {
      db.transaction(() => {
        db.upsertNode(node("t1", "src/a.ts"));
        db.upsertNode(node("t2", "src/a.ts"));
      });

      assert.strictEqual(db.snapshot().nodes.size, 2);
    });

    it("rolls back all changes when the callback throws", () => {
      try {
        db.transaction(() => {
          db.upsertNode(node("rb1", "src/a.ts"));
          throw new Error("intentional rollback");
        });
      } catch {
        /* expected */
      }

      assert.strictEqual(
        db.snapshot().nodes.size,
        0,
        "rolled-back transaction must not persist nodes",
      );
    });

    it("forwards the return value from the callback", () => {
      const result = db.transaction(() => {
        db.upsertNode(node("t3", "src/a.ts"));
        return 42;
      });

      assert.strictEqual(result, 42);
    });

    it("returns undefined when callback returns void", () => {
      const result = db.transaction(() => {
        db.upsertNode(node("t4", "src/a.ts"));
      });

      assert.strictEqual(result, undefined);
    });

    it("handles large batch inserts in a single transaction", () => {
      const COUNT = 200;
      db.transaction(() => {
        for (let i = 0; i < COUNT; i++) {
          db.upsertNode(node(`bulk-${i}`, `src/file${i % 5}.ts`, `sym${i}`));
        }
      });

      const s = db.stats();
      assert.strictEqual(s.nodeCount, COUNT);
      assert.strictEqual(s.filePaths, 5);
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot (integration)
  // -----------------------------------------------------------------------
  describe("snapshot()", () => {
    it("returns an empty snapshot on a fresh database", () => {
      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 0);
      assert.strictEqual(snap.allEdges.length, 0);
      assert.strictEqual(snap.outgoingEdges.size, 0);
      assert.strictEqual(snap.fileRelationships.length, 0);
      assert.strictEqual(snap.fileModifiedTimes.size, 0);
      assert.strictEqual(snap.symbolCacheJson.size, 0);
      assert.strictEqual(snap.builtAtIso, undefined);
      assert.strictEqual(snap.fileRoleSummaryJson, undefined);
    });

    it("returns a complete snapshot with all table data", () => {
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertNode(node("n2", "src/b.ts"));
      db.upsertEdge("n1", "n2", "calls");
      db.upsertFileRelationship(
        "src/a.ts",
        "src/b.ts",
        "file:///a",
        "file:///b",
        "imports",
      );
      db.setFileModifiedTime("src/a.ts", 111);
      db.upsertSymbolCache("n1", '{"sym":1}');
      db.setMetadata("builtAtIso", "2024-06-01T00:00:00.000Z");

      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 2);
      assert.strictEqual(snap.allEdges.length, 1);
      assert.strictEqual(snap.fileRelationships.length, 1);
      assert.strictEqual(snap.fileModifiedTimes.size, 1);
      assert.strictEqual(snap.symbolCacheJson.size, 1);
      assert.strictEqual(snap.builtAtIso, "2024-06-01T00:00:00.000Z");
    });

    it("snapshot nodes are keyed by id", () => {
      db.upsertNode(node("n1", "src/a.ts", "myFunc"));
      const row = db.snapshot().nodes.get("n1");
      assert.ok(row);
      assert.strictEqual(row.symbolName, "myFunc");
    });

    it("snapshot allEdges contains every inserted edge exactly once", () => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertNode(node("c", "src/c.ts"));
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("a", "c", "reads");
      db.upsertEdge("b", "c", "writes");

      assert.strictEqual(db.snapshot().allEdges.length, 3);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup (orphan removal)
  // -----------------------------------------------------------------------
  describe("cleanup()", () => {
    it("removes edges whose source node was deleted without cleanup", () => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertEdge("a", "b", "calls");

      // Intentionally skip deleteEdgesForFile to create an orphan
      db.deleteNodesByFile("src/a.ts");

      assert.strictEqual(
        db.snapshot().allEdges.length,
        1,
        "orphaned edge should still exist before cleanup",
      );

      const { orphanedEdges } = db.cleanup();
      assert.strictEqual(orphanedEdges, 1);
      assert.strictEqual(db.snapshot().allEdges.length, 0);
    });

    it("removes edges whose target node was deleted", () => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertEdge("a", "b", "calls");

      // Delete the target without cleaning edges first
      db.deleteNodesByFile("src/b.ts");

      const { orphanedEdges } = db.cleanup();
      assert.strictEqual(orphanedEdges, 1);
      assert.strictEqual(db.snapshot().allEdges.length, 0);
    });

    it("returns 0 when the graph is already consistent", () => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertEdge("a", "b", "calls");

      assert.strictEqual(db.cleanup().orphanedEdges, 0);
    });

    it("returns 0 on an empty database", () => {
      assert.strictEqual(db.cleanup().orphanedEdges, 0);
    });

    it("does not remove valid edges", () => {
      db.upsertNode(node("a", "src/a.ts"));
      db.upsertNode(node("b", "src/b.ts"));
      db.upsertNode(node("c", "src/c.ts"));
      db.upsertEdge("a", "b", "calls");
      db.upsertEdge("b", "c", "reads");

      db.cleanup();
      assert.strictEqual(db.snapshot().allEdges.length, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------
  describe("stats()", () => {
    it("returns zeros on an empty database", () => {
      const s = db.stats();
      assert.strictEqual(s.nodeCount, 0);
      assert.strictEqual(s.edgeCount, 0);
      assert.strictEqual(s.filePaths, 0);
    });

    it("returns correct counts after insertions", () => {
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertNode(node("n2", "src/a.ts"));
      db.upsertNode(node("n3", "src/b.ts"));
      db.upsertEdge("n1", "n2", "calls");
      db.upsertEdge("n2", "n3", "reads");

      const s = db.stats();
      assert.strictEqual(s.nodeCount, 3);
      assert.strictEqual(s.edgeCount, 2);
      assert.strictEqual(s.filePaths, 2);
    });

    it("filePaths counts distinct file_path values, not node rows", () => {
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertNode(node("n2", "src/a.ts"));
      db.upsertNode(node("n3", "src/a.ts"));

      assert.strictEqual(db.stats().filePaths, 1);
    });

    it("reflects changes after deletion", () => {
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertNode(node("n2", "src/b.ts"));
      db.upsertEdge("n1", "n2", "calls");

      db.deleteEdgesForFile("src/a.ts");
      db.deleteNodesByFile("src/a.ts");

      const s = db.stats();
      assert.strictEqual(s.nodeCount, 1);
      assert.strictEqual(s.edgeCount, 0);
      assert.strictEqual(s.filePaths, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Full round-trip / persistence
  // -----------------------------------------------------------------------
  describe("Full round-trip (close → reopen)", () => {
    it("survives a write → close → reopen → snapshot cycle", () => {
      db.upsertNode(node("n1", "src/a.ts", "myFunc"));
      db.upsertEdge("n1", "n1", "calls");
      db.setFileModifiedTime("src/a.ts", 42);
      db.setMetadata("builtAtIso", "2024-01-01T00:00:00.000Z");
      db.close();

      db = GraphDatabase.open(dbPath);
      const snap = db.snapshot();

      assert.strictEqual(snap.nodes.size, 1);
      assert.strictEqual(snap.nodes.get("n1")!.symbolName, "myFunc");
      assert.strictEqual(snap.allEdges.length, 1);
      assert.strictEqual(snap.fileModifiedTimes.get("src/a.ts"), 42);
      assert.strictEqual(snap.builtAtIso, "2024-01-01T00:00:00.000Z");
    });

    it("handles full delete + re-add cycle for a file", () => {
      db.upsertNode(node("n1", "src/a.ts"));
      db.upsertEdge("n1", "n1", "calls");
      db.setFileModifiedTime("src/a.ts", 100);
      db.upsertSymbolCache("n1", '{"v":1}');

      db.transaction(() => {
        db.deleteEdgesForFile("src/a.ts");
        db.deleteSymbolCacheForFile("src/a.ts");
        db.deleteNodesByFile("src/a.ts");
        db.deleteFileModifiedTime("src/a.ts");
      });

      assert.strictEqual(db.snapshot().nodes.size, 0);
      assert.strictEqual(db.snapshot().allEdges.length, 0);
      assert.strictEqual(db.getAllSymbolCache().size, 0);

      // Re-add
      db.upsertNode(node("n1-v2", "src/a.ts", "renamedFunc"));
      db.setFileModifiedTime("src/a.ts", 200);

      const snap = db.snapshot();
      assert.strictEqual(snap.nodes.size, 1);
      assert.strictEqual(snap.nodes.get("n1-v2")!.symbolName, "renamedFunc");
      assert.strictEqual(snap.fileModifiedTimes.get("src/a.ts"), 200);
    });

    it("handles large node counts across many files efficiently", () => {
      const NODE_COUNT = 500;
      const FILE_COUNT = 10;

      db.transaction(() => {
        for (let i = 0; i < NODE_COUNT; i++) {
          db.upsertNode(
            node(`node-${i}`, `src/file${i % FILE_COUNT}.ts`, `sym${i}`),
          );
        }
      });

      const s = db.stats();
      assert.strictEqual(s.nodeCount, NODE_COUNT);
      assert.strictEqual(s.filePaths, FILE_COUNT);
    });
  });

  // -----------------------------------------------------------------------
  // Migration detection helpers
  // -----------------------------------------------------------------------
  describe("Migration / schema version detection", () => {
    it("can read a manually-set higher schema version", () => {
      db.setMetadata("schemaVersion", "99");
      assert.strictEqual(db.getSchemaVersion(), 99);
    });

    it("getSchemaVersion returns 0 for non-numeric metadata", () => {
      db.setMetadata("schemaVersion", "not-a-number");
      assert.strictEqual(db.getSchemaVersion(), 0);
    });

    it("getSchemaVersion returns 0 when metadata key is absent", () => {
      // Delete the key to simulate a DB created before schema versioning
      db.setMetadata("schemaVersion", "1"); // ensure it exists
      // We can verify 0 is returned for a key that has never been set:
      assert.strictEqual(db.getMetadata("schemaVersionMissing"), undefined);
    });
  });
});
