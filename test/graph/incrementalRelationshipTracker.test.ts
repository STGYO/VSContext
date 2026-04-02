import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';

// ─── Mock types (mirror src/graph/incrementalRelationshipTracker.ts) ──────────

type RelationshipType = 'calls' | 'implements' | 'reads' | 'writes';

interface RelationshipEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: RelationshipType;
}

interface RelationshipDelta {
  readonly toDelete: RelationshipEdge[];
  readonly toInsert: RelationshipEdge[];
  readonly affectedNodeCount: number;
}

// ─── Inline implementation matching IncrementalRelationshipTracker logic ───────

/**
 * Pure TypeScript re-implementation of IncrementalRelationshipTracker that
 * mirrors the production class without any vscode dependency.  All tests
 * exercise this implementation, validating the algorithm itself.
 */
class MockIncrementalRelationshipTracker {
  private affectedNodeIds = new Set<string>();
  private previousEdgesByNode = new Map<string, RelationshipEdge[]>();

  public markAffected(nodeIds: string[]): void {
    for (const id of nodeIds) {
      this.affectedNodeIds.add(id);
    }
  }

  public snapshotAffectedEdges(
    currentEdgesByNode: Map<string, RelationshipEdge[]>,
  ): void {
    for (const nodeId of this.affectedNodeIds) {
      const edges = currentEdgesByNode.get(nodeId) ?? [];
      this.previousEdgesByNode.set(nodeId, edges.slice());
    }
  }

  public computeDelta(
    newEdgesByNode: Map<string, RelationshipEdge[]>,
  ): RelationshipDelta {
    const toDelete: RelationshipEdge[] = [];
    const toInsert: RelationshipEdge[] = [];

    for (const nodeId of this.affectedNodeIds) {
      const previousEdges = this.previousEdgesByNode.get(nodeId) ?? [];
      const newEdges      = newEdgesByNode.get(nodeId) ?? [];

      for (const prev of previousEdges) {
        if (!newEdges.some((e) => this.edgesMatch(e, prev))) {
          toDelete.push(prev);
        }
      }

      for (const next of newEdges) {
        if (!previousEdges.some((e) => this.edgesMatch(e, next))) {
          toInsert.push(next);
        }
      }
    }

    return {
      toDelete,
      toInsert,
      affectedNodeCount: this.affectedNodeIds.size,
    };
  }

  public reset(): void {
    this.affectedNodeIds.clear();
    this.previousEdgesByNode.clear();
  }

  public getAffectedCount(): number {
    return this.affectedNodeIds.size;
  }

  public getAffectedNodeIds(): ReadonlySet<string> {
    return new Set(this.affectedNodeIds);
  }

  public getSnapshotForNode(nodeId: string): ReadonlyArray<RelationshipEdge> | undefined {
    return this.previousEdgesByNode.get(nodeId);
  }

  private edgesMatch(a: RelationshipEdge, b: RelationshipEdge): boolean {
    return a.sourceId === b.sourceId && a.targetId === b.targetId && a.type === b.type;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function edge(
  sourceId: string,
  targetId: string,
  type: RelationshipType = 'calls',
): RelationshipEdge {
  return { sourceId, targetId, type };
}

function edgesMap(
  entries: Array<[string, RelationshipEdge[]]>,
): Map<string, RelationshipEdge[]> {
  return new Map(entries);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IncrementalRelationshipTracker', () => {
  let tracker: MockIncrementalRelationshipTracker;

  beforeEach(() => {
    tracker = new MockIncrementalRelationshipTracker();
  });

  // ── markAffected ─────────────────────────────────────────────────────────────

  describe('markAffected', () => {
    it('starts with no affected nodes', () => {
      assert.strictEqual(tracker.getAffectedCount(), 0);
    });

    it('adds a single node ID', () => {
      tracker.markAffected(['nodeA']);
      assert.strictEqual(tracker.getAffectedCount(), 1);
      assert.ok(tracker.getAffectedNodeIds().has('nodeA'));
    });

    it('adds multiple node IDs at once', () => {
      tracker.markAffected(['A', 'B', 'C']);
      assert.strictEqual(tracker.getAffectedCount(), 3);
    });

    it('deduplicates repeated node IDs across calls', () => {
      tracker.markAffected(['X', 'Y']);
      tracker.markAffected(['Y', 'Z']);
      assert.strictEqual(tracker.getAffectedCount(), 3); // X, Y, Z
    });

    it('deduplicates repeated node IDs within a single call', () => {
      tracker.markAffected(['A', 'A', 'A']);
      assert.strictEqual(tracker.getAffectedCount(), 1);
    });

    it('handles an empty array without error', () => {
      tracker.markAffected([]);
      assert.strictEqual(tracker.getAffectedCount(), 0);
    });

    it('accumulates affected nodes over multiple calls', () => {
      tracker.markAffected(['node1']);
      tracker.markAffected(['node2']);
      tracker.markAffected(['node3']);
      assert.strictEqual(tracker.getAffectedCount(), 3);
    });
  });

  // ── snapshotAffectedEdges ─────────────────────────────────────────────────────

  describe('snapshotAffectedEdges', () => {
    it('snapshots edges for an affected node', () => {
      tracker.markAffected(['A']);

      const current = edgesMap([
        ['A', [edge('A', 'B'), edge('A', 'C')]],
      ]);
      tracker.snapshotAffectedEdges(current);

      const snap = tracker.getSnapshotForNode('A');
      assert.ok(snap !== undefined);
      assert.strictEqual(snap.length, 2);
    });

    it('records an empty array when an affected node has no edges', () => {
      tracker.markAffected(['lonely']);
      tracker.snapshotAffectedEdges(new Map());

      const snap = tracker.getSnapshotForNode('lonely');
      assert.ok(snap !== undefined);
      assert.strictEqual(snap.length, 0);
    });

    it('only snapshots affected nodes, not all nodes in the map', () => {
      tracker.markAffected(['A']);

      const current = edgesMap([
        ['A', [edge('A', 'B')]],
        ['X', [edge('X', 'Y')]],   // X is not marked affected
      ]);
      tracker.snapshotAffectedEdges(current);

      assert.ok(tracker.getSnapshotForNode('A') !== undefined);
      assert.strictEqual(tracker.getSnapshotForNode('X'), undefined);
    });

    it('makes a defensive copy of the edge array (mutations do not affect snapshot)', () => {
      tracker.markAffected(['A']);

      const liveEdges: RelationshipEdge[] = [edge('A', 'B')];
      const current = edgesMap([['A', liveEdges]]);
      tracker.snapshotAffectedEdges(current);

      // Mutate the live array after snapshot
      liveEdges.push(edge('A', 'C'));

      const snap = tracker.getSnapshotForNode('A');
      assert.ok(snap !== undefined);
      assert.strictEqual(snap.length, 1, 'Snapshot should not reflect post-snapshot mutation');
    });

    it('snapshots multiple affected nodes independently', () => {
      tracker.markAffected(['A', 'B', 'C']);

      const current = edgesMap([
        ['A', [edge('A', 'X')]],
        ['B', [edge('B', 'Y'), edge('B', 'Z')]],
        // C deliberately absent → empty snapshot
      ]);
      tracker.snapshotAffectedEdges(current);

      assert.strictEqual(tracker.getSnapshotForNode('A')?.length, 1);
      assert.strictEqual(tracker.getSnapshotForNode('B')?.length, 2);
      assert.strictEqual(tracker.getSnapshotForNode('C')?.length, 0);
    });
  });

  // ── computeDelta ─────────────────────────────────────────────────────────────

  describe('computeDelta', () => {
    it('returns empty delta when there are no affected nodes', () => {
      const delta = tracker.computeDelta(new Map());
      assert.strictEqual(delta.toDelete.length, 0);
      assert.strictEqual(delta.toInsert.length, 0);
      assert.strictEqual(delta.affectedNodeCount, 0);
    });

    it('inserts all edges when previous state was empty', () => {
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(new Map()); // no prior edges

      const newEdges = edgesMap([['A', [edge('A', 'B'), edge('A', 'C')]]]);
      const delta = tracker.computeDelta(newEdges);

      assert.strictEqual(delta.toInsert.length, 2);
      assert.strictEqual(delta.toDelete.length, 0);
    });

    it('deletes all edges when new state is empty', () => {
      tracker.markAffected(['A']);
      const prior = edgesMap([['A', [edge('A', 'B'), edge('A', 'C')]]]);
      tracker.snapshotAffectedEdges(prior);

      const delta = tracker.computeDelta(new Map()); // no new edges

      assert.strictEqual(delta.toDelete.length, 2);
      assert.strictEqual(delta.toInsert.length, 0);
    });

    it('produces no delta when edges are unchanged', () => {
      tracker.markAffected(['A']);
      const edges = [edge('A', 'B'), edge('A', 'C')];
      const state = edgesMap([['A', edges]]);

      tracker.snapshotAffectedEdges(state);
      const delta = tracker.computeDelta(state); // identical state

      assert.strictEqual(delta.toDelete.length, 0);
      assert.strictEqual(delta.toInsert.length, 0);
    });

    it('detects a single added edge', () => {
      tracker.markAffected(['A']);
      const before = edgesMap([['A', [edge('A', 'B')]]]);
      tracker.snapshotAffectedEdges(before);

      const after = edgesMap([['A', [edge('A', 'B'), edge('A', 'C')]]]);
      const delta = tracker.computeDelta(after);

      assert.strictEqual(delta.toInsert.length, 1);
      assert.strictEqual(delta.toInsert[0]?.targetId, 'C');
      assert.strictEqual(delta.toDelete.length, 0);
    });

    it('detects a single removed edge', () => {
      tracker.markAffected(['A']);
      const before = edgesMap([['A', [edge('A', 'B'), edge('A', 'C')]]]);
      tracker.snapshotAffectedEdges(before);

      const after = edgesMap([['A', [edge('A', 'B')]]]);
      const delta = tracker.computeDelta(after);

      assert.strictEqual(delta.toDelete.length, 1);
      assert.strictEqual(delta.toDelete[0]?.targetId, 'C');
      assert.strictEqual(delta.toInsert.length, 0);
    });

    it('detects simultaneous add and remove', () => {
      tracker.markAffected(['A']);
      const before = edgesMap([['A', [edge('A', 'OLD')]]]);
      tracker.snapshotAffectedEdges(before);

      const after = edgesMap([['A', [edge('A', 'NEW')]]]);
      const delta = tracker.computeDelta(after);

      assert.strictEqual(delta.toDelete.length, 1);
      assert.strictEqual(delta.toDelete[0]?.targetId, 'OLD');
      assert.strictEqual(delta.toInsert.length, 1);
      assert.strictEqual(delta.toInsert[0]?.targetId, 'NEW');
    });

    it('differentiates edges by type — same sourceId/targetId, different type', () => {
      tracker.markAffected(['A']);
      const before = edgesMap([['A', [edge('A', 'B', 'calls')]]]);
      tracker.snapshotAffectedEdges(before);

      // Replace 'calls' with 'implements' for the same pair
      const after = edgesMap([['A', [edge('A', 'B', 'implements')]]]);
      const delta = tracker.computeDelta(after);

      // The 'calls' edge should be deleted and 'implements' inserted
      assert.strictEqual(delta.toDelete.length, 1);
      assert.strictEqual(delta.toDelete[0]?.type, 'calls');
      assert.strictEqual(delta.toInsert.length, 1);
      assert.strictEqual(delta.toInsert[0]?.type, 'implements');
    });

    it('handles multiple affected nodes independently', () => {
      tracker.markAffected(['A', 'B']);

      const before = edgesMap([
        ['A', [edge('A', 'X')]],
        ['B', [edge('B', 'Y')]],
      ]);
      tracker.snapshotAffectedEdges(before);

      const after = edgesMap([
        ['A', [edge('A', 'X'), edge('A', 'Z')]],  // added Z
        ['B', []],                                  // removed Y
      ]);
      const delta = tracker.computeDelta(after);

      // A gained one edge
      const aInserts = delta.toInsert.filter((e) => e.sourceId === 'A');
      assert.strictEqual(aInserts.length, 1);
      assert.strictEqual(aInserts[0]?.targetId, 'Z');

      // B lost one edge
      const bDeletes = delta.toDelete.filter((e) => e.sourceId === 'B');
      assert.strictEqual(bDeletes.length, 1);
      assert.strictEqual(bDeletes[0]?.targetId, 'Y');

      assert.strictEqual(delta.affectedNodeCount, 2);
    });

    it('reports affectedNodeCount correctly', () => {
      tracker.markAffected(['N1', 'N2', 'N3']);
      tracker.snapshotAffectedEdges(new Map());
      const delta = tracker.computeDelta(new Map());

      assert.strictEqual(delta.affectedNodeCount, 3);
    });

    it('handles many edges efficiently (no duplicates in output)', () => {
      tracker.markAffected(['hub']);

      // hub had edges to 100 targets
      const oldEdges = Array.from({ length: 100 }, (_, i) =>
        edge('hub', `target${i}`),
      );
      // hub now has edges to targets 50–149 (50 old + 50 new)
      const newEdges = Array.from({ length: 100 }, (_, i) =>
        edge('hub', `target${i + 50}`),
      );

      tracker.snapshotAffectedEdges(edgesMap([['hub', oldEdges]]));
      const delta = tracker.computeDelta(edgesMap([['hub', newEdges]]));

      // targets 0–49 should be deleted (were in old, not in new)
      assert.strictEqual(delta.toDelete.length, 50);
      // targets 100–149 should be inserted (in new, not in old)
      assert.strictEqual(delta.toInsert.length, 50);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears affectedNodeIds after reset', () => {
      tracker.markAffected(['A', 'B', 'C']);
      tracker.reset();
      assert.strictEqual(tracker.getAffectedCount(), 0);
    });

    it('clears previousEdgesByNode after reset', () => {
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(edgesMap([['A', [edge('A', 'B')]]]));
      tracker.reset();

      assert.strictEqual(tracker.getSnapshotForNode('A'), undefined);
    });

    it('allows fresh markAffected after reset', () => {
      tracker.markAffected(['old1', 'old2']);
      tracker.reset();
      tracker.markAffected(['new1']);

      assert.strictEqual(tracker.getAffectedCount(), 1);
      assert.ok(tracker.getAffectedNodeIds().has('new1'));
      assert.ok(!tracker.getAffectedNodeIds().has('old1'));
    });

    it('computes correct delta after reset + re-use', () => {
      // First batch
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(edgesMap([['A', [edge('A', 'X')]]]));
      tracker.computeDelta(edgesMap([['A', [edge('A', 'Y')]]]));
      tracker.reset();

      // Second batch — A now starts fresh with no prior snapshot
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(new Map()); // A has no edges in new round
      const delta = tracker.computeDelta(edgesMap([['A', [edge('A', 'Z')]]]));

      assert.strictEqual(delta.toInsert.length, 1);
      assert.strictEqual(delta.toInsert[0]?.targetId, 'Z');
      assert.strictEqual(delta.toDelete.length, 0);
    });

    it('reset is idempotent — calling twice is safe', () => {
      tracker.markAffected(['A', 'B']);
      tracker.reset();
      tracker.reset(); // second reset on already-clean state

      assert.strictEqual(tracker.getAffectedCount(), 0);
    });
  });

  // ── Full lifecycle ────────────────────────────────────────────────────────────

  describe('full lifecycle', () => {
    it('correctly tracks a two-batch incremental update sequence', () => {
      // ── Batch 1: initial graph has A→B, A→C ──────────────────────────────
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(new Map()); // nothing existed before

      const batch1New = edgesMap([['A', [edge('A', 'B'), edge('A', 'C')]]]);
      const delta1 = tracker.computeDelta(batch1New);

      assert.strictEqual(delta1.toInsert.length, 2);
      assert.strictEqual(delta1.toDelete.length, 0);
      tracker.reset();

      // ── Batch 2: A loses B, gains D ──────────────────────────────────────
      tracker.markAffected(['A']);
      tracker.snapshotAffectedEdges(batch1New); // snapshot current = batch1 output

      const batch2New = edgesMap([['A', [edge('A', 'C'), edge('A', 'D')]]]);
      const delta2 = tracker.computeDelta(batch2New);

      assert.strictEqual(delta2.toDelete.length, 1); // B removed
      assert.strictEqual(delta2.toDelete[0]?.targetId, 'B');
      assert.strictEqual(delta2.toInsert.length, 1); // D added
      assert.strictEqual(delta2.toInsert[0]?.targetId, 'D');
      tracker.reset();
    });

    it('handles a node becoming isolated (all edges removed)', () => {
      tracker.markAffected(['hub']);

      const initial = edgesMap([
        ['hub', [edge('hub', 'X'), edge('hub', 'Y'), edge('hub', 'Z')]],
      ]);
      tracker.snapshotAffectedEdges(initial);

      const delta = tracker.computeDelta(new Map()); // hub loses all edges
      assert.strictEqual(delta.toDelete.length, 3);
      assert.strictEqual(delta.toInsert.length, 0);
    });

    it('handles a node going from isolated to connected', () => {
      tracker.markAffected(['leaf']);
      tracker.snapshotAffectedEdges(new Map()); // leaf has no edges

      const delta = tracker.computeDelta(
        edgesMap([['leaf', [edge('leaf', 'root', 'calls')]]]),
      );
      assert.strictEqual(delta.toInsert.length, 1);
      assert.strictEqual(delta.toDelete.length, 0);
    });

    it('tracks read/write reference changes separately', () => {
      tracker.markAffected(['counter']);
      const before = edgesMap([
        ['counter', [
          edge('fnA', 'counter', 'reads'),
          edge('fnB', 'counter', 'reads'),
        ]],
      ]);
      tracker.snapshotAffectedEdges(before);

      // fnB now writes to counter; fnC newly reads it
      const after = edgesMap([
        ['counter', [
          edge('fnA', 'counter', 'reads'),
          edge('fnB', 'counter', 'writes'),  // changed from reads→writes
          edge('fnC', 'counter', 'reads'),   // new reader
        ]],
      ]);
      const delta = tracker.computeDelta(after);

      // Old 'reads' from fnB deleted; new 'writes' from fnB + 'reads' from fnC inserted
      assert.strictEqual(delta.toDelete.length, 1);
      assert.strictEqual(delta.toDelete[0]?.sourceId, 'fnB');
      assert.strictEqual(delta.toDelete[0]?.type, 'reads');

      assert.strictEqual(delta.toInsert.length, 2);
      const fnBInsert = delta.toInsert.find((e) => e.sourceId === 'fnB');
      assert.ok(fnBInsert !== undefined);
      assert.strictEqual(fnBInsert.type, 'writes');
    });
  });
});
