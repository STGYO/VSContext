import * as assert from 'assert';
import { describe, it, beforeEach } from 'mocha';

// ─── Mock types (mirror src/graph/relationshipResolver.ts without vscode dep) ──

type RelationshipType = 'calls' | 'implements' | 'reads' | 'writes';

interface RelationshipEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: RelationshipType;
}

interface ResolutionResult {
  readonly edges: RelationshipEdge[];
  readonly method: 'lsp' | 'ast' | 'fallback';
  readonly success: boolean;
  readonly errorMessage?: string;
}

interface RelationshipResolutionStats {
  totalAttempted: number;
  lspSuccesses: number;
  astFallbacks: number;
  failures: number;
  byType: Record<RelationshipType, { attempts: number; successes: number }>;
}

// ─── Inline implementation of the stats-tracking logic for unit testing ────────

function makeEmptyStats(): RelationshipResolutionStats {
  return {
    totalAttempted: 0,
    lspSuccesses: 0,
    astFallbacks: 0,
    failures: 0,
    byType: {
      calls:      { attempts: 0, successes: 0 },
      implements: { attempts: 0, successes: 0 },
      reads:      { attempts: 0, successes: 0 },
      writes:     { attempts: 0, successes: 0 },
    },
  };
}

/**
 * Portable write-detection heuristic cloned from RelationshipResolver so it
 * can be exercised in pure Node.js without the vscode module.
 */
function classifyLineText(
  lineText: string,
  startCharacter: number,
): 'reads' | 'writes' {
  const endCharacter = Math.max(startCharacter + 1, startCharacter);
  const before = lineText.slice(0, Math.max(0, startCharacter));
  const after  = lineText.slice(Math.max(0, endCharacter));

  if (/(\+\+|--)\s*$/.test(before.trimEnd()) || /^\s*(\+\+|--)/.test(after)) {
    return 'writes';
  }

  const trimmedAfter = after.trimStart();

  const compoundAssignmentOps = [
    '+=', '-=', '*=', '/=', '%=',
    '&&=', '||=', '??=',
    '<<=', '>>=', '>>>=',
    '&=', '|=', '^=',
    ':=',
  ];

  if (compoundAssignmentOps.some((op) => trimmedAfter.startsWith(op))) {
    return 'writes';
  }

  if (
    trimmedAfter.startsWith('=') &&
    !trimmedAfter.startsWith('==') &&
    !trimmedAfter.startsWith('===') &&
    !trimmedAfter.startsWith('=>')
  ) {
    return 'writes';
  }

  if (/^\s*[,\]\)}]+\s*=/.test(after)) {
    return 'writes';
  }

  return 'reads';
}

/**
 * Minimal stub of recordExternalResolution logic used by SymbolIndexer.
 */
function recordExternalResolution(
  stats: RelationshipResolutionStats,
  type: RelationshipType,
  method: 'lsp' | 'fallback',
  success: boolean,
): void {
  stats.totalAttempted += 1;
  stats.byType[type].attempts += 1;

  if (success) {
    if (method === 'lsp') {
      stats.lspSuccesses += 1;
    } else {
      stats.astFallbacks += 1;
    }
    stats.byType[type].successes += 1;
  } else {
    stats.failures += 1;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RelationshipResolver', () => {

  describe('RelationshipEdge type shape', () => {
    it('should accept a valid calls edge', () => {
      const edge: RelationshipEdge = {
        sourceId: 'nodeA',
        targetId: 'nodeB',
        type: 'calls',
      };
      assert.strictEqual(edge.sourceId, 'nodeA');
      assert.strictEqual(edge.targetId, 'nodeB');
      assert.strictEqual(edge.type, 'calls');
    });

    it('should accept all four RelationshipType values', () => {
      const types: RelationshipType[] = ['calls', 'implements', 'reads', 'writes'];
      for (const t of types) {
        const edge: RelationshipEdge = { sourceId: 'a', targetId: 'b', type: t };
        assert.strictEqual(edge.type, t);
      }
    });

    it('edges with same sourceId/targetId/type are considered equal by value', () => {
      const e1: RelationshipEdge = { sourceId: 'x', targetId: 'y', type: 'calls' };
      const e2: RelationshipEdge = { sourceId: 'x', targetId: 'y', type: 'calls' };
      assert.ok(e1.sourceId === e2.sourceId && e1.targetId === e2.targetId && e1.type === e2.type);
    });

    it('edges with different types are not equal', () => {
      const e1: RelationshipEdge = { sourceId: 'x', targetId: 'y', type: 'reads' };
      const e2: RelationshipEdge = { sourceId: 'x', targetId: 'y', type: 'writes' };
      assert.notStrictEqual(e1.type, e2.type);
    });
  });

  describe('ResolutionResult type shape', () => {
    it('should represent a successful LSP result', () => {
      const result: ResolutionResult = {
        edges: [{ sourceId: 'a', targetId: 'b', type: 'calls' }],
        method: 'lsp',
        success: true,
      };
      assert.ok(result.success);
      assert.strictEqual(result.method, 'lsp');
      assert.strictEqual(result.edges.length, 1);
      assert.strictEqual(result.errorMessage, undefined);
    });

    it('should represent a failed result with an error message', () => {
      const result: ResolutionResult = {
        edges: [],
        method: 'fallback',
        success: false,
        errorMessage: 'LSP provider timed out',
      };
      assert.ok(!result.success);
      assert.strictEqual(result.method, 'fallback');
      assert.strictEqual(result.edges.length, 0);
      assert.strictEqual(result.errorMessage, 'LSP provider timed out');
    });

    it('should represent a result with no edges but success=true (provider responded empty)', () => {
      const result: ResolutionResult = {
        edges: [],
        method: 'lsp',
        success: true,
      };
      assert.ok(result.success);
      assert.strictEqual(result.edges.length, 0);
    });

    it('should support method="ast" for AST-based fallback results', () => {
      const result: ResolutionResult = {
        edges: [],
        method: 'ast',
        success: true,
      };
      assert.strictEqual(result.method, 'ast');
    });
  });

  describe('Stats tracking', () => {
    let stats: RelationshipResolutionStats;

    beforeEach(() => {
      stats = makeEmptyStats();
    });

    it('starts with all counters at zero', () => {
      assert.strictEqual(stats.totalAttempted, 0);
      assert.strictEqual(stats.lspSuccesses, 0);
      assert.strictEqual(stats.astFallbacks, 0);
      assert.strictEqual(stats.failures, 0);
      for (const t of ['calls', 'implements', 'reads', 'writes'] as RelationshipType[]) {
        assert.strictEqual(stats.byType[t].attempts, 0);
        assert.strictEqual(stats.byType[t].successes, 0);
      }
    });

    it('records an LSP success correctly', () => {
      recordExternalResolution(stats, 'calls', 'lsp', true);
      assert.strictEqual(stats.totalAttempted, 1);
      assert.strictEqual(stats.lspSuccesses, 1);
      assert.strictEqual(stats.astFallbacks, 0);
      assert.strictEqual(stats.failures, 0);
      assert.strictEqual(stats.byType.calls.attempts, 1);
      assert.strictEqual(stats.byType.calls.successes, 1);
    });

    it('records a fallback success correctly', () => {
      recordExternalResolution(stats, 'implements', 'fallback', true);
      assert.strictEqual(stats.totalAttempted, 1);
      assert.strictEqual(stats.lspSuccesses, 0);
      assert.strictEqual(stats.astFallbacks, 1);
      assert.strictEqual(stats.failures, 0);
      assert.strictEqual(stats.byType.implements.attempts, 1);
      assert.strictEqual(stats.byType.implements.successes, 1);
    });

    it('records a failure correctly (no successes incremented)', () => {
      recordExternalResolution(stats, 'reads', 'lsp', false);
      assert.strictEqual(stats.totalAttempted, 1);
      assert.strictEqual(stats.lspSuccesses, 0);
      assert.strictEqual(stats.astFallbacks, 0);
      assert.strictEqual(stats.failures, 1);
      assert.strictEqual(stats.byType.reads.attempts, 1);
      assert.strictEqual(stats.byType.reads.successes, 0);
    });

    it('accumulates multiple resolutions across different types', () => {
      recordExternalResolution(stats, 'calls',      'lsp',      true);
      recordExternalResolution(stats, 'calls',      'lsp',      true);
      recordExternalResolution(stats, 'implements', 'lsp',      false);
      recordExternalResolution(stats, 'reads',      'fallback', true);
      recordExternalResolution(stats, 'writes',     'lsp',      false);

      assert.strictEqual(stats.totalAttempted, 5);
      assert.strictEqual(stats.lspSuccesses, 2);
      assert.strictEqual(stats.astFallbacks, 1);
      assert.strictEqual(stats.failures, 2);

      assert.strictEqual(stats.byType.calls.attempts,      2);
      assert.strictEqual(stats.byType.calls.successes,     2);
      assert.strictEqual(stats.byType.implements.attempts, 1);
      assert.strictEqual(stats.byType.implements.successes,0);
      assert.strictEqual(stats.byType.reads.attempts,      1);
      assert.strictEqual(stats.byType.reads.successes,     1);
      assert.strictEqual(stats.byType.writes.attempts,     1);
      assert.strictEqual(stats.byType.writes.successes,    0);
    });

    it('computes a correct LSP success rate from cumulative stats', () => {
      recordExternalResolution(stats, 'calls', 'lsp', true);
      recordExternalResolution(stats, 'calls', 'lsp', true);
      recordExternalResolution(stats, 'calls', 'lsp', false);
      recordExternalResolution(stats, 'calls', 'fallback', true);

      const total = stats.lspSuccesses + stats.astFallbacks + stats.failures;
      const rate  = total > 0 ? stats.lspSuccesses / total : undefined;

      assert.strictEqual(total, 4);
      // 2 lsp successes out of 4 total → 0.5
      assert.strictEqual(rate, 0.5);
    });

    it('getStats equivalent: deep-cloning stats prevents aliasing', () => {
      recordExternalResolution(stats, 'calls', 'lsp', true);

      // Simulate getStats by cloning
      const snapshot: RelationshipResolutionStats = {
        totalAttempted: stats.totalAttempted,
        lspSuccesses:   stats.lspSuccesses,
        astFallbacks:   stats.astFallbacks,
        failures:       stats.failures,
        byType: {
          calls:      { ...stats.byType.calls },
          implements: { ...stats.byType.implements },
          reads:      { ...stats.byType.reads },
          writes:     { ...stats.byType.writes },
        },
      };

      // Mutate original after snapshot
      recordExternalResolution(stats, 'calls', 'lsp', true);

      // Snapshot should be unaffected
      assert.strictEqual(snapshot.totalAttempted, 1);
      assert.strictEqual(snapshot.lspSuccesses,   1);
      assert.strictEqual(stats.totalAttempted,    2); // original updated
    });

    it('resetStats clears all counters', () => {
      recordExternalResolution(stats, 'calls', 'lsp', true);
      recordExternalResolution(stats, 'reads', 'fallback', false);

      // Reset by re-assigning (simulating resetStats())
      stats = makeEmptyStats();

      assert.strictEqual(stats.totalAttempted, 0);
      assert.strictEqual(stats.lspSuccesses,   0);
      assert.strictEqual(stats.astFallbacks,   0);
      assert.strictEqual(stats.failures,       0);
    });
  });

  describe('Write classification (classifyLineText)', () => {

    describe('plain assignment', () => {
      it('detects simple assignment: x = 5', () => {
        assert.strictEqual(classifyLineText('x = 5;', 0), 'writes');
      });

      it('detects assignment mid-line: let a = foo()', () => {
        // 'a' starts at character 4
        assert.strictEqual(classifyLineText('let a = foo()', 4), 'writes');
      });

      it('does NOT classify comparison as write: x == 5', () => {
        assert.strictEqual(classifyLineText('x == 5', 0), 'reads');
      });

      it('does NOT classify strict equality as write: x === 5', () => {
        assert.strictEqual(classifyLineText('x === 5', 0), 'reads');
      });

      it('does NOT classify arrow function as write: x => x + 1', () => {
        assert.strictEqual(classifyLineText('x => x + 1', 0), 'reads');
      });
    });

    describe('compound assignment operators', () => {
      const compoundOps = ['+=', '-=', '*=', '/=', '%=', '&&=', '||=', '??=',
                           '<<=', '>>=', '>>>=', '&=', '|=', '^=', ':='];

      for (const op of compoundOps) {
        it(`detects compound assignment: x ${op} y`, () => {
          // symbol 'x' is at character 0
          assert.strictEqual(classifyLineText(`x ${op} y`, 0), 'writes');
        });
      }
    });

    describe('increment / decrement', () => {
      it('detects postfix increment: x++', () => {
        // 'x' at character 0; after is '++'
        assert.strictEqual(classifyLineText('x++', 0), 'writes');
      });

      it('detects postfix decrement: x--', () => {
        assert.strictEqual(classifyLineText('x--', 0), 'writes');
      });

      it('detects prefix increment: ++x — symbol at char 2', () => {
        assert.strictEqual(classifyLineText('++x', 2), 'writes');
      });

      it('detects prefix decrement: --x — symbol at char 2', () => {
        assert.strictEqual(classifyLineText('--x', 2), 'writes');
      });
    });

    describe('destructuring assignment', () => {
      it('detects destructuring: [a, b] = arr — symbol inside brackets', () => {
        // The reference to 'b' is at character 4; after is '] = arr'
        assert.strictEqual(classifyLineText('[a, b] = arr', 4), 'writes');
      });
    });

    describe('read-only access', () => {
      it('function call argument is a read: foo(x)', () => {
        // 'x' at character 4
        assert.strictEqual(classifyLineText('foo(x)', 4), 'reads');
      });

      it('return statement is a read: return x', () => {
        assert.strictEqual(classifyLineText('return x', 7), 'reads');
      });

      it('property access is a read: obj.x', () => {
        assert.strictEqual(classifyLineText('const y = obj.x', 14), 'reads');
      });

      it('conditional expression is a read: x ? a : b', () => {
        assert.strictEqual(classifyLineText('x ? a : b', 0), 'reads');
      });

      it('array element read: arr[x]', () => {
        assert.strictEqual(classifyLineText('arr[x]', 4), 'reads');
      });

      it('template literal is a read: `${x}`', () => {
        assert.strictEqual(classifyLineText('`${x}`', 3), 'reads');
      });
    });

    describe('edge cases', () => {
      it('handles empty lineText gracefully by returning reads', () => {
        assert.strictEqual(classifyLineText('', 0), 'reads');
      });

      it('handles character at end of line', () => {
        const line = 'x';
        assert.strictEqual(classifyLineText(line, 0), 'reads');
      });

      it('whitespace around assignment still detected', () => {
        assert.strictEqual(classifyLineText('  x  =  42  ', 2), 'writes');
      });

      it('nested assignment in destructuring: ({a}) = obj', () => {
        // 'a' at character 2; after is '}) = obj'
        assert.strictEqual(classifyLineText('({a}) = obj', 2), 'writes');
      });
    });
  });

  describe('Edge collection helpers', () => {

    it('deduplicates edges by sourceId/targetId/type', () => {
      const edges: RelationshipEdge[] = [
        { sourceId: 'A', targetId: 'B', type: 'calls' },
        { sourceId: 'A', targetId: 'B', type: 'calls' },
        { sourceId: 'A', targetId: 'C', type: 'calls' },
      ];

      const seen = new Set<string>();
      const deduped: RelationshipEdge[] = [];
      for (const e of edges) {
        const key = `${e.sourceId}:${e.targetId}:${e.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(e);
        }
      }

      assert.strictEqual(deduped.length, 2);
    });

    it('filters out self-referencing edges (sourceId === targetId)', () => {
      const edges: RelationshipEdge[] = [
        { sourceId: 'A', targetId: 'B', type: 'calls' },
        { sourceId: 'A', targetId: 'A', type: 'calls' },
      ];

      const filtered = edges.filter((e) => e.sourceId !== e.targetId);
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0]?.targetId, 'B');
    });

    it('groups edges by type correctly', () => {
      const edges: RelationshipEdge[] = [
        { sourceId: 'A', targetId: 'B', type: 'calls' },
        { sourceId: 'C', targetId: 'D', type: 'reads' },
        { sourceId: 'E', targetId: 'F', type: 'calls' },
        { sourceId: 'G', targetId: 'H', type: 'implements' },
      ];

      const byType: Record<RelationshipType, RelationshipEdge[]> = {
        calls: [], implements: [], reads: [], writes: [],
      };
      for (const e of edges) {
        byType[e.type].push(e);
      }

      assert.strictEqual(byType.calls.length,      2);
      assert.strictEqual(byType.reads.length,      1);
      assert.strictEqual(byType.implements.length, 1);
      assert.strictEqual(byType.writes.length,     0);
    });
  });

  describe('symbolMap lookup (call relationships)', () => {

    it('maps call target name to nodeId via symbolMap', () => {
      const symbolMap = new Map<string, string>([
        ['processData',    'nodeId::processData::42'],
        ['validateInput',  'nodeId::validateInput::10'],
        ['handleRequest',  'nodeId::handleRequest::77'],
      ]);

      const callerNodeId = 'nodeId::handleRequest::77';
      const callTargetName = 'processData';
      const targetId = symbolMap.get(callTargetName);

      assert.ok(targetId !== undefined);

      const edges: RelationshipEdge[] = [];
      if (targetId && targetId !== callerNodeId) {
        edges.push({ sourceId: callerNodeId, targetId, type: 'calls' });
      }

      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0]?.sourceId, callerNodeId);
      assert.strictEqual(edges[0]?.targetId, 'nodeId::processData::42');
    });

    it('skips self-calls (callee === caller)', () => {
      const symbolMap = new Map<string, string>([
        ['recursiveFunc', 'nodeId::recursiveFunc::5'],
      ]);

      const callerNodeId = 'nodeId::recursiveFunc::5';
      const targetId = symbolMap.get('recursiveFunc');
      const edges: RelationshipEdge[] = [];

      if (targetId && targetId !== callerNodeId) {
        edges.push({ sourceId: callerNodeId, targetId, type: 'calls' });
      }

      // Self-call should be filtered out
      assert.strictEqual(edges.length, 0);
    });

    it('skips unknown symbols not present in symbolMap', () => {
      const symbolMap = new Map<string, string>([
        ['knownFn', 'nodeId::knownFn::1'],
      ]);

      const targetId = symbolMap.get('unknownExternalFn');
      assert.strictEqual(targetId, undefined);
    });
  });

  describe('LSP success rate calculation', () => {

    it('returns undefined success rate when no resolutions attempted', () => {
      const stats = makeEmptyStats();
      const total = stats.lspSuccesses + stats.astFallbacks + stats.failures;
      const rate = total > 0 ? stats.lspSuccesses / total : undefined;
      assert.strictEqual(rate, undefined);
    });

    it('returns 1.0 when all resolutions succeeded via LSP', () => {
      const stats = makeEmptyStats();
      recordExternalResolution(stats, 'calls', 'lsp', true);
      recordExternalResolution(stats, 'calls', 'lsp', true);
      recordExternalResolution(stats, 'calls', 'lsp', true);

      const total = stats.lspSuccesses + stats.astFallbacks + stats.failures;
      const rate  = total > 0 ? stats.lspSuccesses / total : undefined;
      assert.strictEqual(rate, 1.0);
    });

    it('returns 0 when all resolutions failed', () => {
      const stats = makeEmptyStats();
      recordExternalResolution(stats, 'calls', 'lsp', false);
      recordExternalResolution(stats, 'reads', 'lsp', false);

      const total = stats.lspSuccesses + stats.astFallbacks + stats.failures;
      const rate  = total > 0 ? stats.lspSuccesses / total : undefined;
      assert.strictEqual(rate, 0);
    });

    it('correctly calculates a mixed rate: 3 lsp / 4 total = 0.75', () => {
      const stats = makeEmptyStats();
      recordExternalResolution(stats, 'calls', 'lsp',      true);
      recordExternalResolution(stats, 'calls', 'lsp',      true);
      recordExternalResolution(stats, 'calls', 'lsp',      true);
      recordExternalResolution(stats, 'calls', 'fallback', false);

      const total = stats.lspSuccesses + stats.astFallbacks + stats.failures;
      const rate  = total > 0 ? stats.lspSuccesses / total : undefined;

      assert.strictEqual(total, 4);
      assert.ok(rate !== undefined);
      assert.strictEqual(Math.round((rate as number) * 100), 75);
    });
  });
});
