## **GRAPH ENGINE OVERHAUL - IMPLEMENTATION PLAN**
# Graph Engine Overhaul: Recreate Graph Implementation

**Status**: Planning Phase  
**Target**: Complete graph system recreation with SQLite persistence, enhanced relationship detection, and Sigma.js visualization  
**Duration**: 4–5 weeks (hybrid parallel execution)  
**Start Date**: [TBD]  

---

## Executive Summary

Recreate VSContext's graph engine to replace:
1. **Persistence**: JSON cache → SQLite database (faster queries, smaller footprint, incremental snapshots)
2. **Relationship Detection**: LSP-only + regex → Enhanced system with AST analysis & data flow tracking (better accuracy, incremental updates)
3. **Visualization**: Cytoscape.js → Sigma.js (beginner-to-senior friendly, WebGL rendering, graph-native)

**Execution**: Phase 9A (Persistence) + Phase 9B (Relationships) execute **in parallel** (Weeks 1-2), merge in Week 3, then Phase 9C (Visualization) runs Weeks 3-4. Final integration & testing Week 4-5.

**What stays**: Symbol extraction (`symbolIndexer.ts`), knowledge model schema, chat commands, tree view, export functions, webview communication protocol.

---

## Phase 9A: Database Persistence Layer

### Goals
- Replace JSON file cache with SQLite database
- Enable efficient queries, incremental snapshots, reduced disk footprint
- Migrate old cache on first run (backward compat)
- Foundation for Phase 9B relationship queries

### Deliverables
- `src/graph/graphDatabase.ts` — SQLite abstraction layer (250-350 lines)
- Refactored `src/graph/graphBuilder.ts` — DB-backed instead of in-memory Map
- Schema migration logic — automatic old-cache → SQLite conversion
- Cache cleanup — dangling edge removal, orphaned nodes

### Implementation Details

#### SQLite Schema
```sql
-- Nodes table
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  symbol_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  node_type TEXT,  -- 'class' | 'function' | 'method' | 'variable'
  file_path TEXT NOT NULL,
  line_number INTEGER,
  range_json TEXT,  -- JSON: {start: number, end: number}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Edges table
CREATE TABLE edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,  -- 'calls' | 'implements' | 'reads' | 'writes' | 'imports' | 'covers' | 'documents' | 'related-to'
  metadata_json TEXT,  -- Optional: {confidence: 0.0-1.0, ...}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id, target_id, relationship_type),
  FOREIGN KEY (source_id) REFERENCES nodes(id),
  FOREIGN KEY (target_id) REFERENCES nodes(id)
);

-- File index (denormalized for fast lookups)
CREATE TABLE file_index (
  file_path TEXT PRIMARY KEY,
  node_ids_json TEXT,  -- JSON array of node IDs in this file
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Schema metadata
CREATE TABLE schema_metadata (
  version INTEGER,
  migrated_at DATETIME,
  migrated_from TEXT  -- 'json' | 'previous-sqlite-version'
);

CREATE INDEX idx_nodes_file_path ON nodes(file_path);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_type ON edges(relationship_type);
```

#### `GraphDatabase` Class API
```typescript
class GraphDatabase {
  // Lifecycle
  static async open(dbPath: string): Promise<GraphDatabase>
  async close(): Promise<void>
  
  // Node operations
  async insertNode(node: GraphNode): Promise<void>
  async updateNode(node: GraphNode): Promise<void>
  async deleteNode(nodeId: string): Promise<void>
  async getNode(nodeId: string): Promise<GraphNode | null>
  
  // Edge operations
  async insertEdge(sourceId: string, targetId: string, type: string, metadata?: any): Promise<void>
  async deleteEdge(sourceId: string, targetId: string, type: string): Promise<void>
  async getEdges(nodeId: string, direction: 'in' | 'out' | 'both'): Promise<Array<{source, target, type, metadata}>>
  
  // File-level queries
  async getNodesByFile(filePath: string): Promise<GraphNode[]>
  async deleteNodesByFile(filePath: string): Promise<number>  // returns count deleted
  
  // Bulk operations
  async snapshot(): Promise<WorkspaceGraph>  // reconstruct full graph in memory
  async transaction(fn: () => Promise<void>): Promise<void>  // atomic multi-operation
  
  // Maintenance
  async cleanup(): Promise<{orphaned: number, dangling: number}>  // remove orphaned nodes/edges
  async stats(): Promise<{nodeCount: number, edgeCount: number, sizeBytes: number}>
}
```

#### Integration Steps (Week 1-2)
1. **Day 1-2**: Design schema, create `graphDatabase.ts` with CRUD operations
2. **Day 3**: Implement migration logic (JSON → SQLite)
3. **Day 4-5**: Refactor `graphBuilder.ts` — replace `currentGraph: Map` with `db: GraphDatabase`
4. **Day 6**: Test incremental upserts/deletes; implement cleanup; add cancellation support
5. **Day 7-8**: Extension initialization — detect & migrate old cache, bootstrap database
6. **Day 9-10**: Full integration testing, performance baseline (incrementals should be 2-3× faster)

### Verification Checklist (Phase 9A)
- [ ] Extension creates `.vsContext/graph.db` on first activation
- [ ] Old JSON cache migrated successfully; old file deleted post-migration
- [ ] Full graph build yields identical node count, edge count, file relationships as before
- [ ] Incremental file save triggers DB incremental update (not full rebuild)
- [ ] Database queries (by file, by node ID, by edge type) return correct results
- [ ] Cleanup removes dangling edges where target node deleted
- [ ] Disk footprint reduced 20-40% compared to JSON
- [ ] Tests pass: all existing graph tests still green

### Critical Files
- **New**: `src/graph/graphDatabase.ts`
- **Modify**: graphBuilder.ts (replace Map with GraphDatabase)
- **Modify**: extension.ts (initialize `GraphDatabase`, handle migration)
- **Modify**: package.json (add `better-sqlite3` or `sqlite3` dependency)

---

## Phase 9B: Relationship Detection & Incremental Tracking

### Goals
- Improve relationship accuracy (reads/writes, cross-language support)
- Implement efficient incremental relationship updates (only affected relationships recomputed)
- Better file-level relationship discovery (imports, covers, documents)
- Telemetry for relationship resolution metrics

### Deliverables
- `src/graph/relationshipResolver.ts` — Unified relationship resolution (180-240 lines)
- `src/graph/incrementalRelationshipTracker.ts` — Delta tracking for relationship changes (120-160 lines)
- Enhanced `symbolPreScanWorker.ts` — Output data flow hints for better classification
- Refactored `symbolIndexer.ts` — Integrate `RelationshipResolver`
- Telemetry enhancements — Track resolution success rate, fallback usage

### Implementation Details

#### `RelationshipResolver` Class
```typescript
class RelationshipResolver {
  constructor(graphDb: GraphDatabase, workspaceScanner: WorkspaceScanner)
  
  // Core relationship resolution
  async resolveCallRelationships(node: GraphNode, document: Document): Promise<RelationshipEdge[]>
    // LSP: vscode.provideOutgoingCalls()
    // Fallback: AST analysis from symbolPreScanWorker
    // Handle cross-language calls via import analysis
  
  async resolveImplementationRelationships(node: GraphNode): Promise<RelationshipEdge[]>
    // LSP: vscode.executeImplementationProvider()
    // Track: interface implementations, abstract method overrides
  
  async resolveVariableReferences(node: GraphNode, document: Document): Promise<Array<{type: 'read'|'write', target: string}>>
    // LSP: vscode.executeReferenceProvider()
    // Enhanced classification:
    //   - Reads: const x = varName, return varName, function args, conditions
    //   - Writes: varName =, varName++, object destructuring assignment
    // AST hints from symbolPreScanWorker for accuracy
  
  async resolveFileRelationships(filePath: string): Promise<FileRelationshipEdge[]>
    // Imports: Static extraction via regex + module resolution
    // Test coverage: Filename patterns, import analysis
    // Documentation: Markdown links, reference comments
    // Templates: File includes, composition patterns
  
  // Error handling & fallback
  private async tryLSPResolution(node: GraphNode, provider: string): Promise<Result>
  private async fallbackToAST(node: GraphNode): Promise<Result>
}
```

#### `IncrementalRelationshipTracker` Class
```typescript
class IncrementalRelationshipTracker {
  constructor(graphDb: GraphDatabase)
  
  // Track affected relationships
  markAffected(nodeIds: string[]): void  // Flag nodes whose relationships changed
  
  // Compute delta
  async computeDelta(): Promise<{toDelete: RelationshipEdge[], toInsert: RelationshipEdge[]}>
    // Returns edges to remove (old relationships) and add (new relationships)
    // Only affected nodes' relationships are recomputed
  
  reset(): void  // Clear tracking for next batch
}
```

#### Enhanced `symbolPreScanWorker.ts` Output
```typescript
interface EnrichedSymbolHint {
  name: string
  kind: SymbolKind
  // Existing
  range: {start: number, end: number}
  
  // NEW: Data flow hints for better relationship classification
  isAsync: boolean
  hasBody: boolean
  parameterCount: number
  variablesModified: string[]  // Variables this symbol writes
  variablesRead: string[]  // Variables this symbol reads (from outer scope)
  returnType?: string  // Type hint if available
}
```

#### Integration into `symbolIndexer.ts`
```typescript
// Before: Direct LSP calls, regex fallback
for (const node of indexedSymbols) {
  const callRelations = await vscode.provideOutgoingCalls(node);
  // ...
}

// After: Using RelationshipResolver with telemetry
const resolver = new RelationshipResolver(graphDb, scanner);
const telemetry = new IndexTelemetry('relationship-resolution');

for (const node of indexedSymbols) {
  try {
    const callRelations = await resolver.resolveCallRelationships(node, document);
    for (const rel of callRelations) {
      await graphDb.insertEdge(rel.source, rel.target, 'calls');
      telemetry.recordResolution({type: 'calls', success: true});
    }
  } catch (e) {
    telemetry.recordResolution({type: 'calls', success: false, fallback: 'ast'});
    // Fallback handled inside RelationshipResolver
  }
}

logger.log(`[VSContext Telemetry] Relationships: ${telemetry.summary()}`);
  // Output: "Relationships: 145 calls (91% LSP), 89 implements, 234 reads, 67 writes"
```

#### Incremental Update Flow
```typescript
// When file modified:
1. Delete old nodes from DB: await graphDb.deleteNodesByFile(filePath)
2. Index new symbols (existing logic)
3. Use IncrementalRelationshipTracker:
   tracker.markAffected(newNodeIds)
   const delta = await tracker.computeDelta()
   // delta.toDelete: old relationships involving these nodes
   // delta.toInsert: newly resolved relationships
4. Apply delta to DB:
   for (const edge of delta.toDelete) {
     await graphDb.deleteEdge(edge.source, edge.target, edge.type)
   }
   for (const edge of delta.toInsert) {
     await graphDb.insertEdge(edge.source, edge.target, edge.type)
   }
```

#### Integration Steps (Week 1-2, parallel with 9A)
1. **Day 1-2**: Design `RelationshipResolver` API; implement call relationship resolution (LSP + AST fallback)
2. **Day 3**: Implement implementation relationships; start variable reference tracking
3. **Day 4**: Complete variable classification (reads vs. writes using AST hints)
4. **Day 5**: Create `IncrementalRelationshipTracker`; implement delta computation
5. **Day 6**: Enhance `symbolPreScanWorker.ts` — output data flow hints
6. **Day 7**: Integrate resolver into `symbolIndexer.ts`
7. **Day 8-9**: Add telemetry; test relationship accuracy on sample codebase
8. **Day 10**: Full integration with Phase 9A database

### Verification Checklist (Phase 9B)
- [ ] Call relationships detected accurately (LSP provider agrees with manual inspection)
- [ ] Implementation relationships found (interfaces, abstract methods, class inheritance)
- [ ] Variable reads/writes classified correctly (sample symbols manually verified)
- [ ] Cross-language relationships detected where LSP available (e.g., Python→JS imports)
- [ ] Telemetry shows resolution success rate (e.g., 91% LSP calls, 9% AST fallback)
- [ ] Incremental updates 2-3× faster than full rebuild (benchmark on 100-file codebase)
- [ ] New relationships increase graph density (verify edge count increase is meaningful)
- [ ] Tests pass: existing tests updated for improved relationship data

### Critical Files
- **New**: `src/graph/relationshipResolver.ts`
- **New**: `src/graph/incrementalRelationshipTracker.ts`
- **Modify**: symbolIndexer.ts (integrate resolver)
- **Modify**: symbolPreScanWorker.ts (add hints)
- **Modify**: graphBuilder.ts (use tracker for incremental updates)
- **Modify**: indexTelemetry.ts (add relationship metrics)

---

## Phase 9A ↔ 9B Merge Point (Week 3)

### Coordination
1. Both phases complete independently (weeks 1-2)
2. Merge branches; resolve conflicts in `graphBuilder.ts`, `symbolIndexer.ts`
3. Test together:
   - Full graph build with database + relationship detection
   - Verify DB holds all relationships from enhanced resolver
   - Byte-for-byte comparison: old graph vs. new graph (same symbols, relationships)
   - Performance: incremental updates should be noticeably faster

### Verification (Merged System)
- [ ] Extension activates without errors
- [ ] Graph builds successfully with database + enhanced relationships
- [ ] Identical node/edge count as pre-refactor (or more relationships, which is expected)
- [ ] Incremental file save: <500ms update time (vs. 1-2s before)
- [ ] Large workspace (1000+ files): performant indexing, no UI freeze

### Output
**Phase 9A + 9B ready for Phase 9C integration** ✓

---

## Phase 9C: Webview Visualization with Sigma.js

### Why Sigma.js?
| Criterion | Sigma.js | D3.js | Three.js |
|-----------|----------|-------|----------|
| Learning curve | ★★☆☆☆ Beginner-friendly | ★★★★★ Steep | ★★★★☆ Steep |
| Graph-specific | ✓ Native graph library | General visualization | 3D only |
| API familiarity | Like Cytoscape (easy fork-lift) | Different paradigm | Low-level graphics |
| Performance | ✓ WebGL, 10K+ nodes | Canvas-based | ✓ Very fast |
| Bundle size | ~80KB | ~150KB | ~180KB |
| Ecosystem | Active, focused | Large, general | Large, 3D-focused |
| Beginner→Senior | ✓✓✓ Easy ramp | ✓ Powerful complexity | ✓ Overkill |

**Sigma.js selected**: Graph-native, Cytoscape-like API (familiar), easy learning curve for all skill levels, WebGL performance, perfect for mixed teams.

### Goals
- Replace Cytoscape.js with Sigma.js
- Maintain feature parity (layout, filters, zoom, search, click-to-edit)
- Improve rendering on large graphs (5000+ nodes, 30+ FPS)
- Add alternative layout modes (hierarchical, force-directed, radial)

### Deliverables
- `webview/sigmaRenderer.ts` — Sigma.js rendering abstraction (250-350 lines)
- Refactored graph.js — Sigma.js implementation (700-900 lines)
- Updated graph.html — Remove Cytoscape, add Sigma.js
- Performance optimizations — LOD rendering, edge clustering, layout memoization
- All UI controls working — filters, zoom, search, layout toggle

### Implementation Details

#### `SigmaRenderer` Class
```typescript
interface GraphRenderer {
  initialize(container: HTMLElement, options?: RenderOptions): Promise<void>
  setData(nodes: CodeGraphNode[], edges: CodeGraphEdge[]): Promise<void>
  setLayout(type: 'dagre' | 'force-directed' | 'radial' | 'circular'): Promise<void>
  applyFilters(filters: GraphFilters): void
  setZoom(level: number): void
  pan(x: number, y: number): void
  search(query: string): void
  onNodeClick(callback: (node) => void): void
  onNodeHover(callback: (node) => void): void
  dispose(): void
}

class SigmaGraphRenderer implements GraphRenderer {
  private sigma: Sigma
  private graph: Graph  // Graphology graph
  private layout: ForceAtlas2Layout | DagreLayout
  
  async initialize(container, options) {
    // Create Sigma instance with WebGL renderer
    // Attach to container
    // Register layout engines: ForceAtlas2, Dagre
    // Attach event listeners
  }
  
  async setData(nodes, edges) {
    // Clear existing graph
    // Add nodes to graphology graph (with positions from layout)
    // Add edges (with styling by relationship type)
    // Refresh Sigma rendering
  }
  
  async setLayout(type) {
    // Stop current layout
    // Initialize new layout (run layout algorithm)
    // Animate node positions to new layout
  }
  
  applyFilters(filters) {
    // Toggle node/edge visibility based on filters
    // Refresh renderer (no layout recompute needed)
  }
  
  // ... other methods
}
```

#### UI Controls (Port from Cytoscape)
| Control | Implementation |
|---------|---|
| **Layout Mode** | Dropdown: Hierarchical (default), Force-Directed, Radial, Circular |
| **Direction** | Selector (TB, LR, RL, BT) for hierarchical layout |
| **Filters** | Checkboxes: Hide Structural Edges, Hide Variables, Hide [Edge Type] |
| **Zoom** | Slider 0.1–5×, Fit-to-View button, Mouse wheel scroll |
| **Search** | Input field with 150ms debounce, highlight matches |
| **Legend** | Display: node colors (by kind), edge colors (by type), edge thickness |

#### Key Features
1. **Hierarchical Layout (Dagre)** — Default mind-map style
   - Uses `graphology-layout-dagre` plugin
   - Direction: TopBottom, LeftRight, etc.
   - Smooth animation between layout changes

2. **Force-Directed Layout** — Alternative clustering view
   - Uses `graphology-layout-forceatlas2`
   - Interactive dragging of nodes
   - Repulsion/attraction tuning for balance

3. **Radial Layout** — For showing connectivity from central node
   - Concentric rings = distance from start node
   - Good for focus-based analysis

4. **Performance Optimization**
   - **Level-of-Detail (LOD)**: Hide labels at zoom <0.5×; hide low-priority edges
   - **Edge Clustering**: At large graph size, aggregate parallel edges (show count)
   - **Memoization**: Cache layout results; only recompute on layout change
   - **Debouncing**: Zoom/pan events throttled (50ms)
   - **Chunked Loading**: Already supported by `graphWebviewProvider`; load-more button for 10K+ node graphs

5. **Interactions**
   - Click node → Open in editor
   - Hover node → Show tooltip (symbol name, kind, file)
   - Double-click → Focus node (highlight + 2-hop neighborhood)
   - Right-click → Context menu (open, copy path, etc.)
   - Drag node → Re-layout if using force-directed

#### Integration Steps (Weeks 3-4, after Phase 9A/9B merge)
1. **Day 1-2**: Install Sigma.js, create `sigmaRenderer.ts`; implement basic render
2. **Day 3**: Integrate layout engines (Dagre, ForceAtlas2); implement layout toggle
3. **Day 4**: Implement all UI controls (filters, zoom, search)
4. **Day 5**: Implement interactions (click, hover, double-click, context menu)
5. **Day 6**: Performance optimizations (LOD, debouncing, memoization)
6. **Day 7**: Test on large graph (5000+ nodes); benchmark FPS and layout time
7. **Day 8**: Cross-browser testing (Chrome, Edge, Firefox); polish UI
8. **Day 9-10**: Integration with Phase 9A+9B; full end-to-end testing

### Verification Checklist (Phase 9C)
- [ ] Webview renders Sigma.js graph (same nodes/edges as Cytoscape before)
- [ ] Layout modes work (hierarchical default, force-directed, radial)
- [ ] Layout direction selector works (TB, LR, RL, BT)
- [ ] All filters work: structural edges, variables, edge type toggles
- [ ] Zoom/pan smooth and responsive (30+ FPS on 5000 nodes)
- [ ] Search finds nodes; highlights match on graph
- [ ] Click node opens editor at correct position
- [ ] Hover shows tooltip; double-click highlights neighborhood
- [ ] Right-click context menu appears with useful actions
- [ ] Bundle size acceptable (<100KB gzipped for Sigma + dependencies)
- [ ] Cross-browser compatible (tested on 3+ browsers)
- [ ] Performance: Hierarchical layout <500ms, Force-Directed <2s

### Critical Files
- **New**: `webview/sigmaRenderer.ts` (Sigma.js implementation)
- **New**: `webview/sigmaRenderer.interface.ts` (renderer abstraction)
- **Modify**: graph.html (remove Cytoscape, add Sigma.js)
- **Modify**: graph.js (replace Cytoscape with Sigma.js calls)
- **Modify**: graphWebviewProvider.ts (minimal changes; payload format stable)
- **Modify**: package.json (remove Cytoscape, add Sigma.js dependencies)

---

## Timeline & Milestones

### **Week 1: Parallel Start (9A + 9B)**
- **Mon-Tue (Days 1-2)**: Design phase (schema, APIs, architecture)
- **Wed-Thu (Days 3-4)**: 9A database CRUD; 9B relationship resolver foundations
- **Fri-Sat (Days 5-6)**: 9A migration logic; 9B variable tracking
- **Sun (Day 7)**: Integration test 9A with existing graphBuilder

### **Week 2: Parallel Continuation (9A + 9B)**
- **Mon-Tue (Days 8-9)**: 9A incremental updates; 9B incremental tracker
- **Wed-Thu (Days 10-11)**: 9A extension init + migration; 9B symbol indexer integration
- **Fri-Sat (Days 12-13)**: Full integration testing, baseline perf measurements
- **Sun (Day 14)**: Code review, merge prep

### **Week 3: Merge & Baseline (9A ↔ 9B)**
- **Mon-Tue (Days 15-16)**: Merge branches, resolve conflicts
- **Wed-Thu (Days 17-18)**: Integration testing, backward compat verification
- **Fri (Day 19)**: **Checkpoint 1**: 9A + 9B ready for 9C
- **Sat-Sun (Days 20-21)**: Performance baseline, docs, spec for 9C

### **Week 3-4: Phase 9C**
- **Mon-Tue (Days 22-23)**: Sigma.js setup, basic renderer
- **Wed-Thu (Days 24-25)**: Layout engines, UI controls
- **Fri (Day 26)**: Interactions, LOD optimizations
- **Sat (Day 27)**: Large-graph testing, perf profiling
- **Sun (Day 28)**: Cross-browser testing, polish

### **Week 5: Final Integration & Release**
- **Mon-Tue (Days 29-30)**: Full end-to-end testing (file → DB → viz)
- **Wed-Thu (Days 31-32)**: Documentation, tests, final polish
- **Fri (Day 33)**: **Checkpoint 2**: All three phases integrated & verified
- **Sat-Sun (Days 34-35)**: Buffer for final adjustments, release prep

**Total**: 35 days / 5 weeks = 4–5 work weeks

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **Database migration fails** | Fallback: Keep JSON cache; log detailed error; manual retry button. Extensive pre-flight validation. |
| **Relationship resolution false positives** | Gradual rollout: Compare old ↔ new on test codebase; add config toggle to disable new tracking; monitor edge count inflation. |
| **Sigma.js performance insufficient** | Design renderer abstraction; can swap to vis.js or custom WebGL if needed. Performance testing early (Day 26). |
| **Schema mismatch in DB** | Version DB schema; auto-migration on version change; validation on read. |
| **Tests break due to improved relationships** | Update baseline results; add new tests for improved detection; maintain regression tests. |
| **Large workspace (10K+ files) slow indexing** | Deploy Phase 9B incremental tracker; profile and optimize hot paths; consider Phase 10 async pipeline if needed. |

---

## Verification & Testing Strategy

### Unit Tests (Phase 8 framework)
- `src/graph/graphDatabase.test.ts`: CRUD, schema, migration, queries
- `src/graph/relationshipResolver.test.ts`: Relationship accuracy, LSP vs. AST fallback
- `src/graph/incrementalRelationshipTracker.test.ts`: Delta computation, edge cases
- `webview/sigmaRenderer.test.ts`: Initialization, layout, filter application

### Integration Tests
- Full graph build: file → DB → visualization (end-to-end)
- Cache migration: old JSON → sqlite verified
- Incremental updates: DB reflects file changes
- Large workspaces: 1000+ files, 10K+ symbols (no UI freeze)

### Manual Testing Checklist
- [ ] Open extension in test workspace → graph renders
- [ ] Verify graph topology (same nodes/edges as before)
- [ ] Test all UI controls (layout, filters, zoom, search)
- [ ] Performance profiling: DevTools on 5K node graph (FPS, memory)
- [ ] Large workspace simulation: measure incremental update time
- [ ] Cross-browser: Chrome, Edge, Firefox all functional

### Performance Baselines
- **Before**: Cytoscape render time, incremental update time, disk footprint
- **After**: Sigma.js render time (should be ≤), incremental update time (should be 2-3× faster), disk footprint (should be 20-40% smaller)

---

## Backward Compatibility & Fallback

### JSON Cache Migration
- Extension detects old cache on first run
- Automatic migration: JSON → SQLite (logged)
- Old JSON file deleted post-successful migration
- Fallback: If migration fails, keep JSON cache functional (degraded mode)

### API Stability
- All public interfaces unchanged (`WorkspaceGraph`, `CodeGraphNode`, `CodeGraphEdge`)
- Chat commands, tree view, export functions work without modification
- Chat participant receives same graph data

### Configuration
- `vsContext.cacheFormat`: "sqlite" (default) or "json" (legacy)
- `vsContext.databasePath`: Custom DB location if needed
- `vsContext.relationshipQuality`: "enhanced" (default) or "legacy" (LSP-only)
- `vsContext.visualizationLib`: "sigma" (default); future: "vis" if needed

---

## Success Criteria (Final)

1. ✓ Graph engine fully recreated with 3-phase execution
2. ✓ SQLite persistence: DB created, old cache migrated, queries correct
3. ✓ Relationship detection: Improved accuracy, incremental updates 2-3× faster
4. ✓ Visualization: Sigma.js rendered, all controls work, 30+ FPS on 5K nodes
5. ✓ No breaking changes: Existing features work, tests pass
6. ✓ Documentation: Implementation plan executed as specified
7. ✓ Performance: Measurable improvements in incremental update time & disk footprint

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| [TBD] | Use SQLite for persistence | Simple, widely supported, no external service dependency |
| [TBD] | Use Sigma.js over D3.js | Graph-native, beginner-friendly, similar API to Cytoscape, lower learning curve |
| [TBD] | Hybrid parallel execution (9A+9B parallel, 9C after) | Balance speed (4-5 weeks) with safety (testable merge points) |
| [TBD] | Keep symbolIndexer.ts & knowledgeModel.ts unchanged | Both components work well; focus refactoring on persistence, relationships, visualization |

---

## Appendix: File Structure After Completion

```
src/graph/
  ├── graphDatabase.ts          [NEW] SQLite abstraction
  ├── relationshipResolver.ts   [NEW] Relationship resolution
  ├── incrementalRelationshipTracker.ts [NEW] Delta tracking
  ├── graphBuilder.ts           [REFACTORED] Use DB + resolver
  ├── symbolIndexer.ts          [REFACTORED] Integrate resolver
  ├── symbolPreScanWorker.ts    [ENHANCED] Add data flow hints
  ├── knowledgeModel.ts         [UNCHANGED]
  
src/indexing/
  ├── indexTelemetry.ts         [ENHANCED] Add relationship metrics

webview/
  ├── sigmaRenderer.ts          [NEW] Sigma.js renderer
  ├── sigmaRenderer.interface.ts [NEW] Renderer abstraction
  ├── graph.html                [UPDATED] Remove Cytoscape, add Sigma.js
  ├── graph.js                  [REWRITTEN] Sigma.js implementation
  ├── graph.css                 [UNCHANGED]

src/views/
  ├── graphWebviewProvider.ts   [MINIMAL CHANGES] Payload format stable

test/
  ├── graphDatabase.test.ts     [NEW]
  ├── relationshipResolver.test.ts [NEW]
  ├── incrementalRelationshipTracker.test.ts [NEW]
  ├── sigmaRenderer.test.ts     [NEW]
```

---

## Reference: Sigma.js Docs & Learning Resources
- [Sigma.js Official Docs](https://www.sigmajs.org/)
- Graphology+Sigma integration examples
- Relationship resolver pattern inspiration: TypeScript compiler's type resolver, VS Code LSP
- Database: `better-sqlite3` for synchronous SQLite (fits extension's threading model)

---

**Plan Created**: [TBD]  
**Plan Status**: Ready for Implementation  
**Approval**: [User signed off on Phase 9A+9B parallel, Phase 9C after merge]