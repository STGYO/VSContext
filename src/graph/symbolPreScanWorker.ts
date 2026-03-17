import { promises as fs } from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import Parser = require('tree-sitter');
import C = require('tree-sitter-c');
import CPP = require('tree-sitter-cpp');
import Go = require('tree-sitter-go');
import Java = require('tree-sitter-java');
import JavaScript = require('tree-sitter-javascript');
import Python = require('tree-sitter-python');
import Rust = require('tree-sitter-rust');
import TypeScript = require('tree-sitter-typescript');

type WorkerSymbolKind = 'function' | 'method' | 'class' | 'variable' | 'constant' | 'field' | 'property';

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

type LanguageFamily = 'ts' | 'py' | 'rs' | 'go' | 'java' | 'c';

const TS_LANGUAGES = TypeScript as unknown as {
  readonly typescript: unknown;
  readonly tsx: unknown;
};

const LANGUAGE_BY_EXTENSION: Record<string, { language: unknown; family: LanguageFamily } | undefined> = {
  '.ts': { language: TS_LANGUAGES.typescript, family: 'ts' },
  '.tsx': { language: TS_LANGUAGES.tsx, family: 'ts' },
  '.js': { language: JavaScript as unknown, family: 'ts' },
  '.jsx': { language: JavaScript as unknown, family: 'ts' },
  '.py': { language: Python as unknown, family: 'py' },
  '.rs': { language: Rust as unknown, family: 'rs' },
  '.go': { language: Go as unknown, family: 'go' },
  '.java': { language: Java as unknown, family: 'java' },
  '.c': { language: C as unknown, family: 'c' },
  '.h': { language: CPP as unknown, family: 'c' },
  '.cpp': { language: CPP as unknown, family: 'c' },
};

const IDENTIFIER_NODE_TYPES = new Set<string>([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'shorthand_property_identifier_pattern',
]);

const TS_CLASS_SCOPE_TYPES = new Set<string>(['class_body']);
const TS_FUNCTION_SCOPE_TYPES = new Set<string>([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
]);
const PY_CLASS_SCOPE_TYPES = new Set<string>(['class_definition']);
const PY_FUNCTION_SCOPE_TYPES = new Set<string>(['function_definition', 'async_function_definition', 'lambda']);
const RUST_METHOD_SCOPE_TYPES = new Set<string>(['impl_item', 'trait_item']);
const C_TYPE_SCOPE_TYPES = new Set<string>(['struct_specifier', 'class_specifier']);
const C_FUNCTION_DECLARATOR_TYPES = new Set<string>(['function_declarator']);

class SymbolCollector {
  private readonly symbols: WorkerExtractedSymbol[] = [];
  private readonly seen = new Set<string>();

  public constructor(private readonly content: string) {}

  public addFromNode(nameNode: Parser.SyntaxNode | null | undefined, kind: WorkerSymbolKind): void {
    if (!nameNode) {
      return;
    }

    this.add(this.readText(nameNode), nameNode.startPosition.row + 1, kind);
  }

  public add(name: string, line: number, kind: WorkerSymbolKind): void {
    const normalized = name.trim();
    if (!isValidIdentifier(normalized)) {
      return;
    }

    const key = `${kind}:${line.toString()}:${normalized}`;
    if (this.seen.has(key)) {
      return;
    }

    this.seen.add(key);
    this.symbols.push({
      name: normalized,
      line,
      kind,
    });
  }

  public readText(node: Parser.SyntaxNode): string {
    return this.content.slice(node.startIndex, node.endIndex);
  }

  public toArray(): WorkerExtractedSymbol[] {
    return this.symbols;
  }
}

const parserCache = new Map<string, Parser>();

function isValidIdentifier(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const first = value.charCodeAt(0);
  const firstIsValid = (
    (first >= 65 && first <= 90)
    || (first >= 97 && first <= 122)
    || first === 95
    || first === 36
  );

  if (!firstIsValid) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isValid = (
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 95
      || code === 36
    );

    if (!isValid) {
      return false;
    }
  }

  return true;
}

function isUpperSnakeCase(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isValid = (
      (code >= 65 && code <= 90)
      || (code >= 48 && code <= 57)
      || code === 95
    );

    if (!isValid) {
      return false;
    }
  }

  return value.includes('_') || value === value.toUpperCase();
}

function getParserForExtension(extension: string): { parser: Parser; family: LanguageFamily } | undefined {
  const definition = LANGUAGE_BY_EXTENSION[extension];
  if (!definition) {
    return undefined;
  }

  let parser = parserCache.get(extension);
  if (parser) {
    return {
      parser,
      family: definition.family,
    };
  }

  try {
    parser = new Parser();
    parser.setLanguage(definition.language as never);
    parserCache.set(extension, parser);

    return {
      parser,
      family: definition.family,
    };
  } catch {
    return undefined;
  }
}

function walkNamed(root: Parser.SyntaxNode, visitor: (node: Parser.SyntaxNode) => void): void {
  const stack: Parser.SyntaxNode[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    visitor(current);

    for (let childIndex = current.namedChildCount - 1; childIndex >= 0; childIndex -= 1) {
      const child = current.namedChild(childIndex);
      if (!child) {
        continue;
      }

      stack.push(child);
    }
  }
}

function hasAncestorType(node: Parser.SyntaxNode, types: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function findNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const direct = node.childForFieldName('name');
  if (direct && IDENTIFIER_NODE_TYPES.has(direct.type)) {
    return direct;
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }

    if (IDENTIFIER_NODE_TYPES.has(child.type)) {
      return child;
    }
  }

  return undefined;
}

function collectIdentifierNodes(node: Parser.SyntaxNode | undefined, output: Parser.SyntaxNode[]): void {
  if (!node) {
    return;
  }

  if (IDENTIFIER_NODE_TYPES.has(node.type)) {
    output.push(node);
  }

  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }

    collectIdentifierNodes(child, output);
  }
}

function getDeclarationKeyword(node: Parser.SyntaxNode): 'const' | 'let' | 'var' | undefined {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child) {
      continue;
    }

    if (child.type === 'const' || child.type === 'let' || child.type === 'var') {
      return child.type;
    }
  }

  return undefined;
}

function hasModifierToken(node: Parser.SyntaxNode, collector: SymbolCollector, token: string): boolean {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (!child || child.type !== 'modifiers') {
      continue;
    }

    if (collector.readText(child).split(/\s+/).includes(token)) {
      return true;
    }
  }

  return false;
}

function extractTypeScriptLikeSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_declaration':
      case 'class': {
        collector.addFromNode(findNameNode(node), 'class');
        break;
      }
      case 'method_definition':
      case 'abstract_method_signature': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'public_field_definition':
      case 'property_signature':
      case 'property_definition': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'field');
        break;
      }
      case 'function_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'function');
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarationKind = getDeclarationKeyword(node);
        const inClassScope = hasAncestorType(node, TS_CLASS_SCOPE_TYPES);
        const inFunctionScope = hasAncestorType(node, TS_FUNCTION_SCOPE_TYPES);

        for (let index = 0; index < node.namedChildCount; index += 1) {
          const child = node.namedChild(index);
          if (!child || child.type !== 'variable_declarator') {
            continue;
          }

          const names: Parser.SyntaxNode[] = [];
          collectIdentifierNodes(child.childForFieldName('name') ?? child, names);

          for (const nameNode of names) {
            if (inClassScope && !inFunctionScope) {
              collector.addFromNode(nameNode, 'field');
            } else if (declarationKind === 'const') {
              collector.addFromNode(nameNode, 'constant');
            } else {
              collector.addFromNode(nameNode, 'variable');
            }
          }
        }

        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (!left || left.type !== 'member_expression') {
          break;
        }

        const objectNode = left.childForFieldName('object');
        const propertyNode = left.childForFieldName('property');
        if (!objectNode || !propertyNode) {
          break;
        }

        const objectText = collector.readText(objectNode);
        if (objectText === 'this' || objectText === 'self') {
          collector.addFromNode(propertyNode, 'field');
        }

        break;
      }
      default:
        break;
    }
  });
}

function extractPythonSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_definition': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'function_definition':
      case 'async_function_definition': {
        const kind: WorkerSymbolKind = hasAncestorType(node, PY_CLASS_SCOPE_TYPES) ? 'method' : 'function';
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), kind);
        break;
      }
      case 'assignment':
      case 'augmented_assignment': {
        const target = node.childForFieldName('left') ?? node.childForFieldName('target') ?? node.namedChild(0);
        if (!target) {
          break;
        }

        const inClassScope = hasAncestorType(node, PY_CLASS_SCOPE_TYPES);
        const inFunctionScope = hasAncestorType(node, PY_FUNCTION_SCOPE_TYPES);

        if (target.type === 'attribute') {
          const ownerNode = target.childForFieldName('object');
          const attributeNode = target.childForFieldName('attribute') ?? findNameNode(target);
          if (ownerNode && attributeNode) {
            const ownerText = collector.readText(ownerNode);
            if (ownerText === 'self' || ownerText === 'cls') {
              collector.addFromNode(attributeNode, 'field');
              break;
            }
          }
        }

        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(target, names);
        for (const nameNode of names) {
          const name = collector.readText(nameNode);
          if (name === 'self' || name === 'cls') {
            continue;
          }

          if (inClassScope && !inFunctionScope) {
            collector.add(name, nameNode.startPosition.row + 1, 'field');
          } else if (!inFunctionScope && isUpperSnakeCase(name)) {
            collector.add(name, nameNode.startPosition.row + 1, 'constant');
          } else {
            collector.add(name, nameNode.startPosition.row + 1, 'variable');
          }
        }

        break;
      }
      default:
        break;
    }
  });
}

function extractRustSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'struct_item':
      case 'enum_item':
      case 'union_item': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'function_item': {
        const kind: WorkerSymbolKind = hasAncestorType(node, RUST_METHOD_SCOPE_TYPES) ? 'method' : 'function';
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), kind);
        break;
      }
      case 'const_item':
      case 'static_item': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'constant');
        break;
      }
      case 'let_declaration': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node.childForFieldName('pattern') ?? node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'variable');
        }

        break;
      }
      case 'field_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'field');
        break;
      }
      default:
        break;
    }
  });
}

function extractGoSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'type_spec': {
        const typeNode = node.childForFieldName('type');
        if (typeNode?.type === 'struct_type') {
          collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        }

        break;
      }
      case 'method_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'function_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'function');
        break;
      }
      case 'const_spec': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node.childForFieldName('name') ?? node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'constant');
        }

        break;
      }
      case 'var_spec':
      case 'short_var_declaration': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node.childForFieldName('left') ?? node.childForFieldName('name') ?? node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'variable');
        }

        break;
      }
      case 'field_declaration': {
        if (!hasAncestorType(node, new Set<string>(['struct_type']))) {
          break;
        }

        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node.childForFieldName('name') ?? node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'field');
        }

        break;
      }
      default:
        break;
    }
  });
}

function extractJavaSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'method_declaration':
      case 'constructor_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'field_declaration': {
        const isFinal = hasModifierToken(node, collector, 'final');
        for (let index = 0; index < node.namedChildCount; index += 1) {
          const child = node.namedChild(index);
          if (!child || child.type !== 'variable_declarator') {
            continue;
          }

          const nameNode = child.childForFieldName('name') ?? findNameNode(child);
          if (!nameNode) {
            continue;
          }

          const name = collector.readText(nameNode);
          if (isFinal || isUpperSnakeCase(name)) {
            collector.add(name, nameNode.startPosition.row + 1, 'constant');
          } else {
            collector.add(name, nameNode.startPosition.row + 1, 'field');
          }
        }

        break;
      }
      case 'local_variable_declaration': {
        for (let index = 0; index < node.namedChildCount; index += 1) {
          const child = node.namedChild(index);
          if (!child || child.type !== 'variable_declarator') {
            continue;
          }

          collector.addFromNode(child.childForFieldName('name') ?? findNameNode(child), 'variable');
        }

        break;
      }
      default:
        break;
    }
  });
}

function findFunctionDeclaratorName(node: Parser.SyntaxNode | undefined): Parser.SyntaxNode | undefined {
  if (!node) {
    return undefined;
  }

  const candidates: Parser.SyntaxNode[] = [];
  walkNamed(node, (entry) => {
    if (entry.type === 'identifier' || entry.type === 'field_identifier') {
      candidates.push(entry);
    }
  });

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[candidates.length - 1];
}

function extractCStyleSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'struct_specifier':
      case 'class_specifier': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'function_definition': {
        const declarator = node.childForFieldName('declarator') ?? findNameNode(node);
        const nameNode = declarator ? findFunctionDeclaratorName(declarator) : undefined;
        if (!nameNode) {
          break;
        }

        const declaratorText = declarator ? collector.readText(declarator) : '';
        const kind: WorkerSymbolKind = declaratorText.includes('::') ? 'method' : 'function';
        collector.addFromNode(nameNode, kind);
        break;
      }
      case 'field_declaration': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'field');
        }

        break;
      }
      case 'declaration': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node, names);

        const declarationText = collector.readText(node);
        const isConst = declarationText.includes('const');
        const inTypeScope = hasAncestorType(node, C_TYPE_SCOPE_TYPES);

        for (const nameNode of names) {
          if (hasAncestorType(nameNode, C_FUNCTION_DECLARATOR_TYPES)) {
            continue;
          }

          if (inTypeScope) {
            collector.addFromNode(nameNode, 'field');
          } else if (isConst) {
            collector.addFromNode(nameNode, 'constant');
          } else {
            collector.addFromNode(nameNode, 'variable');
          }
        }

        break;
      }
      case 'preproc_def': {
        const nameNode = findNameNode(node);
        collector.addFromNode(nameNode, 'constant');
        break;
      }
      default:
        break;
    }
  });
}

function extractSymbols(filePath: string, content: string): WorkerExtractedSymbol[] {
  const extension = path.extname(filePath).toLowerCase();
  const parserInfo = getParserForExtension(extension);
  if (!parserInfo) {
    return [];
  }

  let tree: Parser.Tree;
  try {
    tree = parserInfo.parser.parse(content);
  } catch {
    return [];
  }

  const collector = new SymbolCollector(content);

  switch (parserInfo.family) {
    case 'ts':
      extractTypeScriptLikeSymbols(tree.rootNode, collector);
      break;
    case 'py':
      extractPythonSymbols(tree.rootNode, collector);
      break;
    case 'rs':
      extractRustSymbols(tree.rootNode, collector);
      break;
    case 'go':
      extractGoSymbols(tree.rootNode, collector);
      break;
    case 'java':
      extractJavaSymbols(tree.rootNode, collector);
      break;
    case 'c':
      extractCStyleSymbols(tree.rootNode, collector);
      break;
    default:
      break;
  }

  return collector.toArray();
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let pointer = 0;

  const run = async (): Promise<void> => {
    while (pointer < values.length) {
      const current = values[pointer];
      pointer += 1;
      await work(current);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => run()));
}

async function run(): Promise<void> {
  const input = (workerData as WorkerBatchInput | undefined) ?? { filePaths: [] };
  const candidateFilePaths: string[] = [];
  const symbolMap: Record<string, WorkerExtractedSymbol[]> = {};

  await forEachWithConcurrency(input.filePaths, 12, async (filePath) => {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const symbols = extractSymbols(filePath, content);
      if (symbols.length > 0) {
        candidateFilePaths.push(filePath);
        symbolMap[filePath] = symbols;
      }
    } catch {
      // Ignore unreadable files and continue pre-scanning the batch.
    }
  });

  const result: WorkerBatchResult = {
    candidateFilePaths,
    symbolMap,
  };

  parentPort?.postMessage(result);
}

void run().catch(() => {
  const fallback: WorkerBatchResult = {
    candidateFilePaths: [],
    symbolMap: {},
  };

  parentPort?.postMessage(fallback);
});
