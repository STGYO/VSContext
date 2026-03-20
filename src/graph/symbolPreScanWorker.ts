import { promises as fs } from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import Parser = require('tree-sitter');
import C = require('tree-sitter-c');
import CSharp = require('tree-sitter-c-sharp');
import CPP = require('tree-sitter-cpp');
import Go = require('tree-sitter-go');
import Java = require('tree-sitter-java');
import JavaScript = require('tree-sitter-javascript');
import Kotlin = require('tree-sitter-kotlin');
import PHP = require('tree-sitter-php');
import Python = require('tree-sitter-python');
import Ruby = require('tree-sitter-ruby');
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

type LanguageFamily = 'ts' | 'py' | 'rs' | 'go' | 'java' | 'c' | 'cs' | 'php' | 'ruby' | 'kotlin';

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
  '.cc': { language: CPP as unknown, family: 'c' },
  '.cxx': { language: CPP as unknown, family: 'c' },
  '.hpp': { language: CPP as unknown, family: 'c' },
  '.hh': { language: CPP as unknown, family: 'c' },
  '.hxx': { language: CPP as unknown, family: 'c' },
  '.cs': { language: CSharp as unknown, family: 'cs' },
  '.php': { language: PHP as unknown, family: 'php' },
  '.phtml': { language: PHP as unknown, family: 'php' },
  '.rb': { language: Ruby as unknown, family: 'ruby' },
  '.kt': { language: Kotlin as unknown, family: 'kotlin' },
  '.kts': { language: Kotlin as unknown, family: 'kotlin' },
};

const IDENTIFIER_NODE_TYPES = new Set<string>([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'simple_identifier',
  'variable_name',
  'constant',
  'instance_variable',
  'class_variable',
  'global_variable',
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
const CSHARP_TYPE_SCOPE_TYPES = new Set<string>([
  'class_declaration',
  'struct_declaration',
  'interface_declaration',
  'record_declaration',
]);
const KOTLIN_TYPE_SCOPE_TYPES = new Set<string>([
  'class_body',
  'class_declaration',
  'object_declaration',
  'object_body',
]);
const KOTLIN_FUNCTION_SCOPE_TYPES = new Set<string>([
  'function_declaration',
  'lambda_literal',
  'anonymous_function',
]);

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
    const normalized = normalizeIdentifierName(name);
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

function normalizeIdentifierName(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith('@@')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('@') || normalized.startsWith('$')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

function _testNormalizeIdentifierName(): void {
  const cases: Array<{ input: string; expected: string }> = [
    { input: '', expected: '' },
    { input: '   ', expected: '' },
    { input: '@', expected: '' },
    { input: '@@', expected: '' },
    { input: '$', expected: '' },
    { input: '@foo', expected: 'foo' },
    { input: '@@foo', expected: 'foo' },
    { input: '$foo', expected: 'foo' },
    { input: '  @bar  ', expected: 'bar' },
    { input: 'baz', expected: 'baz' },
  ];

  for (const { input, expected } of cases) {
    const actual = normalizeIdentifierName(input);
    if (actual !== expected) {
      throw new Error(
        `normalizeIdentifierName test failed for input ${JSON.stringify(input)}: ` +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }
}

if (process.env.NODE_ENV === 'test' && process.env.SYMBOL_PRESCAN_TEST_NORMALIZE === '1') {
  _testNormalizeIdentifierName();
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
    const isTrailingMethodPunctuation = index === value.length - 1 && (code === 33 || code === 63);
    if (isTrailingMethodPunctuation) {
      continue;
    }

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

function collectIdentifierNodes(node: Parser.SyntaxNode | null | undefined, output: Parser.SyntaxNode[]): void {
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

function collectDeclaratorNames(node: Parser.SyntaxNode, declaratorType: string): Parser.SyntaxNode[] {
  const names: Parser.SyntaxNode[] = [];

  walkNamed(node, (entry) => {
    if (entry.type !== declaratorType) {
      return;
    }

    const nameNode = entry.childForFieldName('name') ?? findNameNode(entry);
    if (!nameNode) {
      return;
    }

    names.push(nameNode);
  });

  return names;
}

// Lightweight self-tests for collectDeclaratorNames. These are only executed in test environments.
function selfTestCollectDeclaratorNames(): void {
  type AnyNode = any;

  const makeNode = (overrides: Partial<Parser.SyntaxNode>): Parser.SyntaxNode => {
    const base: AnyNode = {
      type: 'root',
      childCount: 0,
      namedChildCount: 0,
      child() {
        return null;
      },
      namedChild() {
        return null;
      },
      childForFieldName() {
        return null;
      },
    };

    return Object.assign(base, overrides) as Parser.SyntaxNode;
  };

  // Multiple declarators with direct name field.
  const id1 = makeNode({ type: 'identifier' });
  const id2 = makeNode({ type: 'identifier' });

  const declType = 'variable_declarator';

  const decl1 = makeNode({
    type: declType,
    childForFieldName(name: string) {
      return name === 'name' ? (id1 as AnyNode) : null;
    },
  });

  const decl2 = makeNode({
    type: declType,
    childForFieldName(name: string) {
      return name === 'name' ? (id2 as AnyNode) : null;
    },
  });

  const decl3MissingName = makeNode({
    type: declType,
    // No 'name' field and no identifier children; should be ignored.
  });

  const rootMultiple = makeNode({
    type: 'root',
    namedChildCount: 3,
    namedChild(index: number) {
      if (index === 0) return decl1 as AnyNode;
      if (index === 1) return decl2 as AnyNode;
      if (index === 2) return decl3MissingName as AnyNode;
      return null;
    },
  });

  const namesMultiple = collectDeclaratorNames(rootMultiple, declType);
  console.assert(namesMultiple.length === 2, 'Expected two names for multiple declarators');
  console.assert(namesMultiple[0] === id1 && namesMultiple[1] === id2, 'Names should be collected in order');

  // Nested declarator structure: root -> wrapper -> declarator (using findNameNode fallback).
  const nestedId = makeNode({ type: 'identifier' });
  const nestedDecl = makeNode({
    type: declType,
    childForFieldName() {
      return null;
    },
    namedChildCount: 1,
    namedChild(index: number) {
      return index === 0 ? (nestedId as AnyNode) : null;
    },
  });

  const wrapper = makeNode({
    type: 'wrapper',
    namedChildCount: 1,
    namedChild(index: number) {
      return index === 0 ? (nestedDecl as AnyNode) : null;
    },
  });

  const rootNested = makeNode({
    type: 'root',
    namedChildCount: 1,
    namedChild(index: number) {
      return index === 0 ? (wrapper as AnyNode) : null;
    },
  });

  const namesNested = collectDeclaratorNames(rootNested, declType);
  console.assert(namesNested.length === 1, 'Expected one name for nested declarator');
  console.assert(namesNested[0] === nestedId, 'Nested declarator name should be collected via findNameNode');
}

if (process.env.NODE_ENV === 'test') {
  selfTestCollectDeclaratorNames();
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

function extractCSharpSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'struct_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'destructor_declaration':
      case 'operator_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'local_function_statement': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'function');
        break;
      }
      case 'property_declaration':
      case 'event_declaration':
      case 'indexer_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'property');
        break;
      }
      case 'field_declaration': {
        const isConst = hasModifierToken(node, collector, 'const') || hasModifierToken(node, collector, 'readonly');
        for (const nameNode of collectDeclaratorNames(node, 'variable_declarator')) {
          const name = collector.readText(nameNode);
          if (isConst || isUpperSnakeCase(name)) {
            collector.add(name, nameNode.startPosition.row + 1, 'constant');
          } else {
            collector.add(name, nameNode.startPosition.row + 1, 'field');
          }
        }

        break;
      }
      case 'local_declaration_statement':
      case 'variable_declaration': {
        for (const nameNode of collectDeclaratorNames(node, 'variable_declarator')) {
          collector.addFromNode(nameNode, 'variable');
        }

        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left') ?? node.namedChild(0);
        const receiver = left?.childForFieldName('object') ?? left?.childForFieldName('expression');
        const member = left?.childForFieldName('name') ?? left?.childForFieldName('field') ?? findNameNode(left ?? node);
        if (!receiver || !member) {
          break;
        }

        const receiverText = collector.readText(receiver);
        if (receiverText === 'this' || receiverText === 'base') {
          collector.addFromNode(member, hasAncestorType(node, CSHARP_TYPE_SCOPE_TYPES) ? 'field' : 'property');
        }

        break;
      }
      default:
        break;
    }
  });
}

function extractPhpSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration':
      case 'enum_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'method_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'function_definition': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'function');
        break;
      }
      case 'property_declaration': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node, names);
        for (const nameNode of names) {
          const name = collector.readText(nameNode);
          if (name.startsWith('$')) {
            collector.add(name, nameNode.startPosition.row + 1, 'field');
          }
        }

        break;
      }
      case 'const_declaration':
      case 'const_element': {
        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(node, names);
        for (const nameNode of names) {
          collector.addFromNode(nameNode, 'constant');
        }

        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left') ?? node.namedChild(0);
        if (!left) {
          break;
        }

        const names: Parser.SyntaxNode[] = [];
        collectIdentifierNodes(left, names);
        for (const nameNode of names) {
          const name = collector.readText(nameNode);
          if (name.startsWith('$')) {
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

function extractRubySymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class':
      case 'module': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'method':
      case 'singleton_method': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'assignment':
      case 'operator_assignment': {
        const left = node.childForFieldName('left') ?? node.childForFieldName('name') ?? node.namedChild(0);
        const nameNode = left ? (left.childForFieldName('name') ?? findNameNode(left)) : undefined;
        if (!nameNode) {
          break;
        }

        const name = collector.readText(nameNode);
        if (name.startsWith('@')) {
          collector.add(name, nameNode.startPosition.row + 1, 'field');
        } else if (/^[A-Z]/.test(name)) {
          collector.add(name, nameNode.startPosition.row + 1, 'constant');
        } else {
          collector.add(name, nameNode.startPosition.row + 1, 'variable');
        }

        break;
      }
      default:
        break;
    }
  });
}

function extractKotlinSymbols(root: Parser.SyntaxNode, collector: SymbolCollector): void {
  walkNamed(root, (node) => {
    switch (node.type) {
      case 'class_declaration':
      case 'object_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'type_alias': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
        break;
      }
      case 'function_declaration': {
        const inTypeScope = hasAncestorType(node, KOTLIN_TYPE_SCOPE_TYPES);
        const inFunctionScope = hasAncestorType(node, KOTLIN_FUNCTION_SCOPE_TYPES);
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), inTypeScope && !inFunctionScope ? 'method' : 'function');
        break;
      }
      case 'secondary_constructor':
      case 'constructor_declaration': {
        collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'method');
        break;
      }
      case 'property_declaration': {
        const nameNode = node.childForFieldName('name') ?? findNameNode(node);
        if (!nameNode) {
          break;
        }

        const declarationText = collector.readText(node);
        const inTypeScope = hasAncestorType(node, KOTLIN_TYPE_SCOPE_TYPES);
        const inFunctionScope = hasAncestorType(node, KOTLIN_FUNCTION_SCOPE_TYPES);
        const isConst = /\bconst\b/.test(declarationText);
        const isTopLevelVal = /\bval\b/.test(declarationText) && !inFunctionScope && !inTypeScope;
        const name = collector.readText(nameNode);

        if (inTypeScope && !inFunctionScope) {
          collector.add(name, nameNode.startPosition.row + 1, 'field');
        } else if (isConst || (isTopLevelVal && isUpperSnakeCase(name))) {
          collector.add(name, nameNode.startPosition.row + 1, 'constant');
        } else {
          collector.add(name, nameNode.startPosition.row + 1, 'variable');
        }

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
    case 'cs':
      extractCSharpSymbols(tree.rootNode, collector);
      break;
    case 'php':
      extractPhpSymbols(tree.rootNode, collector);
      break;
    case 'ruby':
      extractRubySymbols(tree.rootNode, collector);
      break;
    case 'kotlin':
      extractKotlinSymbols(tree.rootNode, collector);
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
