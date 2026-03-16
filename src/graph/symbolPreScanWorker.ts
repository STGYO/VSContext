import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

type WorkerSymbolKind = 'function' | 'method' | 'class';

interface WorkerExtractedSymbol {
  readonly name: string;
  readonly line: number;
  readonly kind: WorkerSymbolKind;
}

interface WorkerBatchInput {
  readonly filePaths: string[];
}

interface WorkerBatchResult {
  readonly candidateFilePaths: string[];
  readonly symbolMap: Record<string, WorkerExtractedSymbol[]>;
}

function extractSymbols(filePath: string, content: string): WorkerExtractedSymbol[] {
  const extension = path.extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const symbols: WorkerExtractedSymbol[] = [];

  const pushMatch = (regex: RegExp, kind: WorkerSymbolKind): void => {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const match = regex.exec(line);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          line: lineIndex + 1,
          kind,
        });
      }
    }
  };

  if (extension === '.py') {
    pushMatch(/^\s*(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function');
    pushMatch(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)/, 'class');
    return symbols;
  }

  if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.jsx') {
    pushMatch(/^\s*function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, 'function');
    pushMatch(/^\s*class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:extends|\{)/, 'class');
    return symbols;
  }

  if (extension === '.go') {
    pushMatch(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function');
    pushMatch(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/, 'class');
    return symbols;
  }

  if (extension === '.java') {
    pushMatch(/^\s*(?:public|protected|private)?\s*(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, 'class');
    pushMatch(/^\s*(?:public|protected|private|static|final|synchronized|native|abstract|\s)+[A-Za-z_][A-Za-z0-9_<>,\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function');
    return symbols;
  }

  if (extension === '.rs') {
    pushMatch(/^\s*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function');
    pushMatch(/^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/, 'class');
    return symbols;
  }

  if (extension === '.c' || extension === '.h' || extension === '.cpp') {
    pushMatch(/^\s*(?:[A-Za-z_][A-Za-z0-9_\s\*]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/, 'function');
    return symbols;
  }

  return symbols;
}

function run(): void {
  const input = workerData as WorkerBatchInput;
  const candidateFilePaths: string[] = [];
  const symbolMap: Record<string, WorkerExtractedSymbol[]> = {};

  for (const filePath of input.filePaths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const symbols = extractSymbols(filePath, content);
      if (symbols.length > 0) {
        candidateFilePaths.push(filePath);
        symbolMap[filePath] = symbols;
      }
    } catch {
      continue;
    }
  }

  const result: WorkerBatchResult = {
    candidateFilePaths,
    symbolMap,
  };

  parentPort?.postMessage(result);
}

run();
