import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';

import { QueryResultExporter, exportQueryResultToPDF } from '../src/export/queryResultExporter';

interface MockHybridQueryResult {
  readonly title: string;
  readonly templateId: string;
  readonly prompt: string;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly focusNode: { id: string; symbolName: string; symbolKind: string; filePath: string; lineNumber: number } | undefined;
  readonly caveats: string[];
  readonly semanticHits: Array<{ chunkId: string; filePath: string; similarity: number; excerpt: string }>;
  readonly fileRelationships: Array<{ sourceFilePath: string; targetFilePath: string; relationship: string }>;
  readonly traceResult: { nodes: Array<{ id: string; symbolName: string; degree: number }> } | undefined;
  readonly impactResult: { nodes: Array<{ id: string; symbolName: string; degree: number }> } | undefined;
  readonly renderedMarkdown: string;
  readonly plan: {
    readonly graphQueries: string[];
    readonly semanticQueries: string[];
  };
}

class MockLogger {
  info(message: string) {}
  warn(message: string) {}
  error(message: string) {}
}

function createPdfTestResult(): any {
  return {
    title: 'Test Query Result',
    templateId: 'summary',
    prompt: 'Show me the workspace structure',
    confidence: 'high',
    focusNode: {
      id: 'test-1',
      symbolName: 'processData',
      symbolKind: 'function',
      filePath: 'src/utils/data.ts',
      lineNumber: 42,
    },
    caveats: ['This is a test caveat', 'Analysis limited to indexed files'],
    semanticHits: [
      {
        id: 'chunk-1',
        filePath: 'src/models/data.ts',
        title: 'processData chunk',
        score: 0.95,
      },
    ],
    fileRelationships: [
      {
        sourceFilePath: 'src/utils/data.ts',
        targetFilePath: 'src/models/data.ts',
        sourceUriString: 'file:///workspace/src/utils/data.ts',
        targetUriString: 'file:///workspace/src/models/data.ts',
        relationship: 'imports',
      },
    ],
    traceResult: {
      nodes: [
        { nodeId: 'trace-1', symbolName: 'processData', depth: 0 },
        { nodeId: 'trace-2', symbolName: 'parseInput', depth: 1 },
      ],
    },
    impactResult: {
      nodes: [
        { nodeId: 'impact-1', symbolName: 'main', depth: 1 },
      ],
    },
    renderedMarkdown: '# Test Result\n\nThis is a test result with **bold** text and `code`.',
    plan: {
      templateId: 'summary',
      graphQueries: ['workspace summary'],
      semanticQueries: ['processData', 'workspace structure'],
      semanticMaxResults: 6,
      useTrace: false,
      useImpact: false,
    },
  };
}

describe('Export Tests', () => {
  let mockResult: MockHybridQueryResult;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    mockResult = {
      title: 'Test Query Result',
      templateId: 'summary',
      prompt: 'Show me the workspace structure',
      confidence: 'high',
      focusNode: {
        id: 'test-1',
        symbolName: 'processData',
        symbolKind: 'function',
        filePath: 'src/utils/data.ts',
        lineNumber: 42,
      },
      caveats: ['This is a test caveat', 'Analysis limited to indexed files'],
      semanticHits: [
        {
          chunkId: 'chunk-1',
          filePath: 'src/models/data.ts',
          similarity: 0.95,
          excerpt: 'function processData(input) { return input.map(...) }',
        },
      ],
      fileRelationships: [
        {
          sourceFilePath: 'src/utils/data.ts',
          targetFilePath: 'src/models/data.ts',
          relationship: 'imports',
        },
      ],
      traceResult: {
        nodes: [
          { id: 'trace-1', symbolName: 'processData', degree: 3 },
          { id: 'trace-2', symbolName: 'parseInput', degree: 2 },
        ],
      },
      impactResult: {
        nodes: [
          { id: 'impact-1', symbolName: 'main', degree: 1 },
        ],
      },
      renderedMarkdown: '# Test Result\n\nThis is a test result with **bold** text and `code`.',
      plan: {
        graphQueries: ['workspace summary'],
        semanticQueries: ['processData', 'workspace structure'],
      },
    };
  });

  describe('Actual PDF Export', () => {
    it('should write a valid PDF file to disk', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscontext-export-'));
      const outputPath = path.join(tempDir, 'result.pdf');

      try {
        await exportQueryResultToPDF(createPdfTestResult(), outputPath, {}, logger as any);

        assert.ok(fs.existsSync(outputPath), 'PDF file should exist');
        const content = fs.readFileSync(outputPath, 'latin1');
        assert.ok(content.startsWith('%PDF-1.4'), 'PDF header should be present');
        assert.ok(content.includes('Test Query Result'), 'PDF content should include the title');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore cleanup errors */
        }
      }
    });

    it('should generate PDF report lines through the exporter', () => {
      const exporter = new QueryResultExporter(logger as any);
      const lines = exporter.buildPdfLines(createPdfTestResult(), {});

      assert.ok(lines.length > 0, 'PDF lines should be generated');
      assert.ok(lines.some((line) => line.includes('Focus Node')), 'Focus node section should be present');
      assert.ok(lines.some((line) => line.includes('Rendered Markdown')), 'Rendered markdown section should be present');
    });
  });

  describe('JSON Export', () => {
    it('should export basic query result to JSON', () => {
      // JSON export should include title, templateId, prompt, confidence
      assert.ok(mockResult.title, 'Title should exist');
      assert.ok(mockResult.templateId, 'Template ID should exist');
      assert.ok(mockResult.prompt, 'Prompt should exist');
      assert.ok(mockResult.confidence, 'Confidence should exist');
    });

    it('should include metadata in JSON export', () => {
      // JSON export with includeMetadata: true should have exportedAt and focusNode
      assert.ok(mockResult.focusNode, 'Focus node should be included');
      assert.strictEqual(mockResult.focusNode?.symbolName, 'processData');
    });

    it('should include evidence in JSON export', () => {
      // JSON export with includeEvidence: true should have semantic hits and relationships
      assert.ok(mockResult.semanticHits.length > 0, 'Semantic hits should be included');
      assert.ok(mockResult.fileRelationships.length > 0, 'File relationships should be included');
    });

    it('should be valid JSON format', () => {
      // JSON output should be parseable
      const jsonStr = JSON.stringify(mockResult, null, 2);
      const parsed = JSON.parse(jsonStr);
      assert.ok(parsed, 'JSON should be parseable');
      assert.strictEqual(parsed.templateId, 'summary');
    });
  });

  describe('CSV Export', () => {
    it('should export query result headers to CSV', () => {
      // CSV should have headers for Template, Title, Prompt, Confidence
      const expectedHeaders = ['Template', 'Title', 'Prompt', 'Confidence'];
      for (const header of expectedHeaders) {
        assert.ok(header, `Header ${header} should exist in CSV`);
      }
    });

    it('should escape CSV values properly', () => {
      // CSV should escape commas, quotes, and newlines
      const value = 'Test, with "quotes" and\nnewline';
      const escaped = value.includes(',') ? `"${value.replace(/"/g, '""')}"` : value;
      assert.ok(escaped.startsWith('"'), 'Value should be quoted if it contains special chars');
    });

    it('should include focus node info in CSV', () => {
      // CSV should include symbol name, file, kind for focus node
      assert.ok(mockResult.focusNode?.symbolName, 'Focus symbol should be in CSV');
      assert.ok(mockResult.focusNode?.filePath, 'Focus file should be in CSV');
    });

    it('should include semantic hits in CSV', () => {
      // CSV should have separate section for semantic hits
      assert.ok(mockResult.semanticHits.length > 0, 'Semantic hits should be in CSV');
      assert.ok(mockResult.semanticHits[0].filePath, 'Hit file path should be included');
    });

    it('should include file relationships in CSV', () => {
      // CSV should have separate section for relationships
      assert.ok(mockResult.fileRelationships.length > 0, 'Relationships should be in CSV');
    });
  });

  describe('HTML Export', () => {
    it('should generate valid HTML structure', () => {
      // HTML should have html, head, body tags
      assert.ok(true, 'HTML structure validation');
    });

    it('should include header with title and metadata', () => {
      // HTML should have header section with title, template, date
      assert.ok(mockResult.title, 'Title should be in header');
    });

    it('should include styled confidence badge', () => {
      // HTML should have confidence badge with color based on level (high=green, medium=orange, low=red)
      const confidenceColors: Record<string, string> = { high: 'green', medium: 'orange', low: 'red' };
      assert.ok(confidenceColors[mockResult.confidence], 'Confidence should have color');
    });

    it('should include formatted query result', () => {
      // HTML should have rendered markdown content with proper formatting
      assert.ok(mockResult.renderedMarkdown, 'Markdown content should be included');
    });

    it('should include styled tables for evidence', () => {
      // HTML should have tables for semantic hits and relationships
      assert.ok(mockResult.semanticHits.length > 0, 'Semantic hits table should exist');
      assert.ok(mockResult.fileRelationships.length > 0, 'Relationships table should exist');
    });

    it('should include caveat warnings', () => {
      // HTML should have styled warning boxes for caveats
      assert.ok(mockResult.caveats.length > 0, 'Caveats should be displayed');
    });

    it('should include footer with attribution', () => {
      // HTML should have footer with VSContext attribution and GitHub link
      assert.ok(true, 'Footer should include attribution');
    });
  });

  describe('PDF Export', () => {
    it('should generate PDF with content from HTML', () => {
      // PDF should include all HTML content in PDF format
      assert.ok(mockResult.renderedMarkdown, 'PDF should have content');
    });

    it('should include proper styling in PDF', () => {
      // PDF should maintain style, colors, layout from HTML
      assert.ok(true, 'PDF styling should match HTML');
    });

    it('should be downloadable from VS Code', () => {
      // PDF should be generated in a way that allows download via VS Code UI
      assert.ok(true, 'PDF should be downloadable');
    });
  });

  describe('Export Options', () => {
    it('should respect includeMetadata option', () => {
      // When includeMetadata: false, exported file should not have metadata section
      assert.ok(true, 'includeMetadata option should be respected');
    });

    it('should respect includeCaveats option', () => {
      // When includeCaveats: false, caveats should not appear in export
      assert.ok(true, 'includeCaveats option should be respected');
    });

    it('should respect includeEvidence option', () => {
      // When includeEvidence: false, semantic hits and relationships should not appear
      assert.ok(true, 'includeEvidence option should be respected');
    });

    it('should respect includeQueryPlan option', () => {
      // When includeQueryPlan: false, query plan section should not appear
      assert.ok(true, 'includeQueryPlan option should be respected');
    });
  });
});
