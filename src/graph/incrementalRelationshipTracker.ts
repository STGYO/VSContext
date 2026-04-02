import { RelationshipEdge } from './relationshipResolver';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RelationshipDelta {
  readonly toDelete: RelationshipEdge[];
  readonly toInsert: RelationshipEdge[];
  readonly affectedNodeCount: number;
}

// ─── Main class ───────────────────────────────────────────────────────────────

/**
 * Tracks incremental relationship changes between graph update cycles.
 *
 * Typical usage pattern per update batch:
 *
 *   1. tracker.markAffected(changedNodeIds)
 *   2. tracker.snapshotAffectedEdges(currentEdgesByNode)   // before update
 *   3. ... perform graph update / re-resolve relationships ...
 *   4. const delta = tracker.computeDelta(newEdgesByNode)  // after update
 *   5. applyDelta(delta)                                   // mutate the graph
 *   6. tracker.reset()                                     // prepare next batch
 *
 * The tracker is deliberately cheap: it only snapshots and compares edges for
 * nodes that have been explicitly marked as affected, keeping memory usage
 * proportional to the change set rather than the full graph.
 */
export class IncrementalRelationshipTracker {
  /** Node IDs whose relationships may have changed in the current batch. */
  private affectedNodeIds = new Set<string>();

  /**
   * Snapshot of each affected node's outgoing/incoming edges taken *before*
   * the current update so that we can diff them against the new state.
   */
  private previousEdgesByNode = new Map<string, RelationshipEdge[]>();

  // ─── Mutation API ───────────────────────────────────────────────────────────

  /**
   * Mark one or more node IDs as potentially having changed relationships.
   * Can be called multiple times; duplicate IDs are silently ignored.
   *
   * @param nodeIds Array of node IDs to mark as affected.
   */
  public markAffected(nodeIds: string[]): void {
    for (const id of nodeIds) {
      this.affectedNodeIds.add(id);
    }
  }

  /**
   * Snapshot the current edges for every affected node.
   *
   * Must be called **before** the graph update so that the previous state is
   * captured for diffing.  Nodes that have no entry in `currentEdgesByNode`
   * are recorded with an empty edge list (they had no relationships).
   *
   * @param currentEdgesByNode All current edges in the working graph, keyed
   *                           by sourceId (or the relevant node ID).
   */
  public snapshotAffectedEdges(
    currentEdgesByNode: Map<string, RelationshipEdge[]>,
  ): void {
    for (const nodeId of this.affectedNodeIds) {
      const edges = currentEdgesByNode.get(nodeId) ?? [];
      // Store a copy so subsequent mutations to the graph do not corrupt the
      // snapshot.
      this.previousEdgesByNode.set(nodeId, edges.slice());
    }
  }

  // ─── Delta computation ──────────────────────────────────────────────────────

  /**
   * Compute the minimal delta between the previously-snapshotted edges and the
   * newly-resolved edges for every affected node.
   *
   * An edge is considered the same if all three of `sourceId`, `targetId`, and
   * `type` match — no other fields are compared.
   *
   * @param newEdgesByNode  Post-update edges keyed by the same node ID used
   *                        when calling `snapshotAffectedEdges`.
   * @returns A delta describing which edges to remove and which to insert.
   */
  public computeDelta(
    newEdgesByNode: Map<string, RelationshipEdge[]>,
  ): RelationshipDelta {
    const toDelete: RelationshipEdge[] = [];
    const toInsert: RelationshipEdge[] = [];

    for (const nodeId of this.affectedNodeIds) {
      const previousEdges = this.previousEdgesByNode.get(nodeId) ?? [];
      const newEdges      = newEdgesByNode.get(nodeId) ?? [];

      // Edges that existed before but are absent now → delete.
      for (const prev of previousEdges) {
        if (!newEdges.some((e) => this.edgesMatch(e, prev))) {
          toDelete.push(prev);
        }
      }

      // Edges that are new but were absent before → insert.
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

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Clear all state in preparation for the next update batch.
   * Should be called after the delta has been applied to the graph.
   */
  public reset(): void {
    this.affectedNodeIds.clear();
    this.previousEdgesByNode.clear();
  }

  // ─── Inspection ─────────────────────────────────────────────────────────────

  /**
   * Return the number of nodes currently marked as affected.
   * Useful for logging and progress reporting.
   */
  public getAffectedCount(): number {
    return this.affectedNodeIds.size;
  }

  /**
   * Return a copy of the set of affected node IDs.
   * Primarily intended for testing and debugging.
   */
  public getAffectedNodeIds(): ReadonlySet<string> {
    return new Set(this.affectedNodeIds);
  }

  /**
   * Return the snapshotted edges for a specific node, or undefined if no
   * snapshot has been taken for that node in the current batch.
   * Primarily intended for testing and debugging.
   */
  public getSnapshotForNode(nodeId: string): ReadonlyArray<RelationshipEdge> | undefined {
    return this.previousEdgesByNode.get(nodeId);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Two edges are considered equal when their sourceId, targetId, and type
   * are all identical.
   */
  private edgesMatch(a: RelationshipEdge, b: RelationshipEdge): boolean {
    return (
      a.sourceId === b.sourceId &&
      a.targetId === b.targetId &&
      a.type     === b.type
    );
  }
}
