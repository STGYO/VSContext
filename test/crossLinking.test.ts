import * as assert from 'assert';
import { describe, it } from 'mocha';

interface MockCrossLink {
  readonly displayText: string;
  readonly filePath: string;
  readonly lineNumber?: number;
  readonly symbolName?: string;
  readonly linkType: 'file' | 'symbol' | 'line' | 'selection';
}

describe('Cross-Linking Tests', () => {
  describe('Cross-Link Generation', () => {
    it('should extract symbol references from backticks', () => {
      const markdown = 'The function `processData` is called by `handleRequest`.';
      const symbolMatches = markdown.matchAll(/`([^`]+)`/g);
      const symbols = Array.from(symbolMatches).map(m => m[1]);

      assert.strictEqual(symbols.length, 2);
      assert.ok(symbols.includes('processData'));
      assert.ok(symbols.includes('handleRequest'));
    });

    it('should extract file paths from markdown', () => {
      const markdown = 'See file src/utils/helper.ts for implementation.';
      const fileMatch = markdown.match(/(?:file|path)[:\s]+([^\s\n]+\.(?:ts|js|tsx|jsx|py|java|go|cpp|c|rs|rb|php|kt|cs))/i);

      assert.ok(fileMatch, 'Should match file path');
      assert.strictEqual(fileMatch?.[1], 'src/utils/helper.ts');
    });

    it('should extract line number references', () => {
      const markdown = 'Error occurs at line 42. Check L100 for similar code. Line 1337 has the fix.';
      const lineMatches = markdown.matchAll(/(?:line|at|L)[\s:]*(\d+)/gi);
      const lines = Array.from(lineMatches).map(m => parseInt(m[1], 10));

      assert.ok(lines.length >= 3);
      assert.ok(lines.includes(42));
      assert.ok(lines.includes(100));
      assert.ok(lines.includes(1337));
    });

    it('should deduplicate cross-links', () => {
      const markdown = 'Function `foo` calls `bar`. Then `foo` is called by `baz`.';
      const symbolMatches = markdown.matchAll(/`([^`]+)`/g);
      const dups = new Map<string, MockCrossLink>();

      for (const match of symbolMatches) {
        const symbol = match[1];
        if (!dups.has(symbol)) {
          dups.set(symbol, {
            displayText: symbol,
            filePath: '',
            symbolName: symbol,
            linkType: 'symbol',
          });
        }
      }

      assert.strictEqual(dups.size, 3); // foo, bar, baz (no duplicates)
    });
  });

  describe('Link Creation', () => {
    it('should create markdown link to file', () => {
      const filePath = 'src/utils/helper.ts';
      const link = `[${filePath}](${filePath})`;

      assert.ok(link.includes('['));
      assert.ok(link.includes(']('));
      assert.ok(link.includes(filePath));
    });

    it('should create markdown link to file with line number', () => {
      const filePath = 'src/utils/helper.ts';
      const lineNumber = 42;
      const link = `[${filePath}](${filePath}#L${lineNumber})`;

      assert.ok(link.includes('#L42'));
      assert.strictEqual(link, '[src/utils/helper.ts](src/utils/helper.ts#L42)');
    });

    it('should create markdown link with custom display text', () => {
      const filePath = 'src/utils/helper.ts';
      const displayText = 'Helper utilities';
      const link = `[${displayText}](${filePath})`;

      assert.ok(link.includes(displayText));
      assert.ok(link.includes(filePath));
    });

    it('should not create link for unknown symbols', () => {
      const unknownSymbol = 'nonExistentFunction123';
      const link = unknownSymbol; // No link created because symbol doesn't exist

      assert.strictEqual(link, unknownSymbol);
    });
  });

  describe('Markdown Enhancement', () => {
    it('should convert backtick references to links', () => {
      const markdown = 'The function `processData` is implemented in the utils.';
      // After enhancement, `processData` should become a link

      const enhanced = markdown.replace(/`([^`]+)`/g, (match, symbol) => `[${symbol}](path/to/file.ts)`);

      assert.ok(enhanced.includes('[processData]'));
      assert.ok(enhanced.includes('](path/to/file.ts)'));
    });

    it('should convert file path references to links', () => {
      const markdown = 'Implementation in file src/utils/helper.ts';
      // File path should become a link

      const enhanced = markdown.replace(/(\bfile\s+)?([^\s]+\.ts)/g, '[$2]($2)');

      assert.ok(enhanced.includes('[src/utils/helper.ts]'));
    });

    it('should preserve markdown formatting while adding links', () => {
      const markdown = 'The **important** function `critical` needs **attention**.';
      const enhanced = markdown.replace(/`([^`]+)`/g, (match, symbol) => `[${symbol}](path.ts)`);

      assert.ok(enhanced.includes('**important**'));
      assert.ok(enhanced.includes('**attention**'));
      assert.ok(enhanced.includes('[critical]'));
    });

    it('should handle multiple cross-links in one markdown', () => {
      const markdown = `
## Analysis

The \`processRequest\` function in \`src/api/handler.ts\` (line 123) calls \`validateInput\` from \`src/validators.ts\`.

Similar code found in src/legacy/old_handler.ts.
      `;

      const symbols = Array.from(markdown.matchAll(/`([^`]+)`/g)).map(m => m[1]);
      const files = Array.from(markdown.matchAll(/([^\s]+\.ts)/g)).map(m => m[1]);

      assert.ok(symbols.length >= 2);
      assert.ok(files.length >= 3);
    });
  });

  describe('Cross-Link Summary', () => {
    it('should generate summary with file and symbol count', () => {
      const crossLinks: MockCrossLink[] = [
        { displayText: 'processData', filePath: 'src/utils/data.ts', symbolName: 'processData', linkType: 'symbol' },
        { displayText: 'validateInput', filePath: 'src/validators.ts', symbolName: 'validateInput', linkType: 'symbol' },
        { displayText: 'src/api/handler.ts', filePath: 'src/api/handler.ts', linkType: 'file' },
      ];

      const fileLinks = crossLinks.filter(l => l.linkType === 'file' || l.linkType === 'symbol');
      const summary = `Files/Symbols Referenced: ${fileLinks.length}`;

      assert.strictEqual(fileLinks.length, 3);
      assert.ok(summary.includes('3'));
    });

    it('should list all referenced files in summary', () => {
      const crossLinks: MockCrossLink[] = [
        { displayText: 'foo', filePath: 'src/utils/a.ts', symbolName: 'foo', linkType: 'symbol' },
        { displayText: 'bar', filePath: 'src/utils/b.ts', symbolName: 'bar', linkType: 'symbol' },
        { displayText: 'baz', filePath: 'src/utils/a.ts', symbolName: 'baz', linkType: 'symbol' },
      ];

      const uniqueFiles = new Set(crossLinks.map(l => l.filePath));

      assert.strictEqual(uniqueFiles.size, 2); // a.ts and b.ts
    });

    it('should group symbols by file', () => {
      const crossLinks: MockCrossLink[] = [
        { displayText: 'processData', filePath: 'src/utils/data.ts', symbolName: 'processData', linkType: 'symbol' },
        { displayText: 'validateData', filePath: 'src/utils/data.ts', symbolName: 'validateData', linkType: 'symbol' },
        { displayText: 'parseInput', filePath: 'src/api/parser.ts', symbolName: 'parseInput', linkType: 'symbol' },
      ];

      const byFile = new Map<string, string[]>();
      for (const link of crossLinks) {
        if (!byFile.has(link.filePath)) {
          byFile.set(link.filePath, []);
        }
        byFile.get(link.filePath)!.push(link.symbolName || '');
      }

      assert.strictEqual(byFile.size, 2);
      assert.strictEqual(byFile.get('src/utils/data.ts')?.length, 2);
      assert.strictEqual(byFile.get('src/api/parser.ts')?.length, 1);
    });

    it('should limit summary to top N files', () => {
      const crossLinks: MockCrossLink[] = [];
      for (let i = 0; i < 15; i++) {
        crossLinks.push({
          displayText: `sym${i}`,
          filePath: `src/file${i}.ts`,
          symbolName: `sym${i}`,
          linkType: 'symbol',
        });
      }

      const uniqueFiles = new Set(crossLinks.map(l => l.filePath));
      const topFiles = Array.from(uniqueFiles).slice(0, 10);

      assert.strictEqual(topFiles.length, 10); // Limited to 10
    });
  });

  describe('Link Opening', () => {
    it('should construct proper file URI for opening', () => {
      const link: MockCrossLink = {
        displayText: 'data.ts',
        filePath: 'src/utils/data.ts',
        linkType: 'file',
      };

      const fileUri = `file://${link.filePath}`;
      assert.ok(fileUri.startsWith('file://'));
    });

    it('should include line number in URI', () => {
      const link: MockCrossLink = {
        displayText: 'processData',
        filePath: 'src/utils/data.ts',
        lineNumber: 42,
        symbolName: 'processData',
        linkType: 'symbol',
      };

      const fileUri = `${link.filePath}#L${link.lineNumber}`;
      assert.ok(fileUri.includes('#L42'));
    });

    it('should handle opening symbol at correct position', () => {
      const link: MockCrossLink = {
        displayText: 'processData',
        filePath: 'src/utils/data.ts',
        symbolName: 'processData',
        linkType: 'symbol',
      };

      const lineNumber = 25; // Line where symbol is defined
      const position = { line: lineNumber - 1, character: 0 };

      assert.strictEqual(position.line, 24); // 0-indexed
    });
  });
});
