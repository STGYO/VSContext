"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path = __importStar(require("path"));
const worker_threads_1 = require("worker_threads");
const Parser = require("tree-sitter");
const C = require("tree-sitter-c");
const CPP = require("tree-sitter-cpp");
const Go = require("tree-sitter-go");
const Java = require("tree-sitter-java");
const JavaScript = require("tree-sitter-javascript");
const Python = require("tree-sitter-python");
const Rust = require("tree-sitter-rust");
const TypeScript = require("tree-sitter-typescript");
const TS_LANGUAGES = TypeScript;
const LANGUAGE_BY_EXTENSION = {
    '.ts': { language: TS_LANGUAGES.typescript, family: 'ts' },
    '.tsx': { language: TS_LANGUAGES.tsx, family: 'ts' },
    '.js': { language: JavaScript, family: 'ts' },
    '.jsx': { language: JavaScript, family: 'ts' },
    '.py': { language: Python, family: 'py' },
    '.rs': { language: Rust, family: 'rs' },
    '.go': { language: Go, family: 'go' },
    '.java': { language: Java, family: 'java' },
    '.c': { language: C, family: 'c' },
    '.h': { language: CPP, family: 'c' },
    '.cpp': { language: CPP, family: 'c' },
};
const IDENTIFIER_NODE_TYPES = new Set([
    'identifier',
    'property_identifier',
    'field_identifier',
    'type_identifier',
    'shorthand_property_identifier_pattern',
]);
const TS_CLASS_SCOPE_TYPES = new Set(['class_body']);
const TS_FUNCTION_SCOPE_TYPES = new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function',
]);
const PY_CLASS_SCOPE_TYPES = new Set(['class_definition']);
const PY_FUNCTION_SCOPE_TYPES = new Set(['function_definition', 'async_function_definition', 'lambda']);
const RUST_METHOD_SCOPE_TYPES = new Set(['impl_item', 'trait_item']);
const C_TYPE_SCOPE_TYPES = new Set(['struct_specifier', 'class_specifier']);
const C_FUNCTION_DECLARATOR_TYPES = new Set(['function_declarator']);
class SymbolCollector {
    content;
    symbols = [];
    seen = new Set();
    constructor(content) {
        this.content = content;
    }
    addFromNode(nameNode, kind) {
        if (!nameNode) {
            return;
        }
        this.add(this.readText(nameNode), nameNode.startPosition.row + 1, kind);
    }
    add(name, line, kind) {
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
    readText(node) {
        return this.content.slice(node.startIndex, node.endIndex);
    }
    toArray() {
        return this.symbols;
    }
}
const parserCache = new Map();
function isValidIdentifier(value) {
    if (value.length === 0) {
        return false;
    }
    const first = value.charCodeAt(0);
    const firstIsValid = ((first >= 65 && first <= 90)
        || (first >= 97 && first <= 122)
        || first === 95
        || first === 36);
    if (!firstIsValid) {
        return false;
    }
    for (let index = 1; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const isValid = ((code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || (code >= 48 && code <= 57)
            || code === 95
            || code === 36);
        if (!isValid) {
            return false;
        }
    }
    return true;
}
function isUpperSnakeCase(value) {
    if (value.length === 0) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const isValid = ((code >= 65 && code <= 90)
            || (code >= 48 && code <= 57)
            || code === 95);
        if (!isValid) {
            return false;
        }
    }
    return value.includes('_') || value === value.toUpperCase();
}
function getParserForExtension(extension) {
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
        parser.setLanguage(definition.language);
        parserCache.set(extension, parser);
        return {
            parser,
            family: definition.family,
        };
    }
    catch {
        return undefined;
    }
}
function walkNamed(root, visitor) {
    const stack = [root];
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
function hasAncestorType(node, types) {
    let current = node.parent;
    while (current) {
        if (types.has(current.type)) {
            return true;
        }
        current = current.parent;
    }
    return false;
}
function findNameNode(node) {
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
function collectIdentifierNodes(node, output) {
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
function getDeclarationKeyword(node) {
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
function hasModifierToken(node, collector, token) {
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
function extractTypeScriptLikeSymbols(root, collector) {
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
                    const names = [];
                    collectIdentifierNodes(child.childForFieldName('name') ?? child, names);
                    for (const nameNode of names) {
                        if (inClassScope && !inFunctionScope) {
                            collector.addFromNode(nameNode, 'field');
                        }
                        else if (declarationKind === 'const') {
                            collector.addFromNode(nameNode, 'constant');
                        }
                        else {
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
function extractPythonSymbols(root, collector) {
    walkNamed(root, (node) => {
        switch (node.type) {
            case 'class_definition': {
                collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
                break;
            }
            case 'function_definition':
            case 'async_function_definition': {
                const kind = hasAncestorType(node, PY_CLASS_SCOPE_TYPES) ? 'method' : 'function';
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
                const names = [];
                collectIdentifierNodes(target, names);
                for (const nameNode of names) {
                    const name = collector.readText(nameNode);
                    if (name === 'self' || name === 'cls') {
                        continue;
                    }
                    if (inClassScope && !inFunctionScope) {
                        collector.add(name, nameNode.startPosition.row + 1, 'field');
                    }
                    else if (!inFunctionScope && isUpperSnakeCase(name)) {
                        collector.add(name, nameNode.startPosition.row + 1, 'constant');
                    }
                    else {
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
function extractRustSymbols(root, collector) {
    walkNamed(root, (node) => {
        switch (node.type) {
            case 'struct_item':
            case 'enum_item':
            case 'union_item': {
                collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'class');
                break;
            }
            case 'function_item': {
                const kind = hasAncestorType(node, RUST_METHOD_SCOPE_TYPES) ? 'method' : 'function';
                collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), kind);
                break;
            }
            case 'const_item':
            case 'static_item': {
                collector.addFromNode(node.childForFieldName('name') ?? findNameNode(node), 'constant');
                break;
            }
            case 'let_declaration': {
                const names = [];
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
function extractGoSymbols(root, collector) {
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
                const names = [];
                collectIdentifierNodes(node.childForFieldName('name') ?? node, names);
                for (const nameNode of names) {
                    collector.addFromNode(nameNode, 'constant');
                }
                break;
            }
            case 'var_spec':
            case 'short_var_declaration': {
                const names = [];
                collectIdentifierNodes(node.childForFieldName('left') ?? node.childForFieldName('name') ?? node, names);
                for (const nameNode of names) {
                    collector.addFromNode(nameNode, 'variable');
                }
                break;
            }
            case 'field_declaration': {
                if (!hasAncestorType(node, new Set(['struct_type']))) {
                    break;
                }
                const names = [];
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
function extractJavaSymbols(root, collector) {
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
                    }
                    else {
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
function findFunctionDeclaratorName(node) {
    if (!node) {
        return undefined;
    }
    const candidates = [];
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
function extractCStyleSymbols(root, collector) {
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
                const kind = declaratorText.includes('::') ? 'method' : 'function';
                collector.addFromNode(nameNode, kind);
                break;
            }
            case 'field_declaration': {
                const names = [];
                collectIdentifierNodes(node, names);
                for (const nameNode of names) {
                    collector.addFromNode(nameNode, 'field');
                }
                break;
            }
            case 'declaration': {
                const names = [];
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
                    }
                    else if (isConst) {
                        collector.addFromNode(nameNode, 'constant');
                    }
                    else {
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
function extractSymbols(filePath, content) {
    const extension = path.extname(filePath).toLowerCase();
    const parserInfo = getParserForExtension(extension);
    if (!parserInfo) {
        return [];
    }
    let tree;
    try {
        tree = parserInfo.parser.parse(content);
    }
    catch {
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
async function forEachWithConcurrency(values, concurrency, work) {
    let pointer = 0;
    const run = async () => {
        while (pointer < values.length) {
            const current = values[pointer];
            pointer += 1;
            await work(current);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => run()));
}
async function run() {
    const input = worker_threads_1.workerData ?? { filePaths: [] };
    const candidateFilePaths = [];
    const symbolMap = {};
    await forEachWithConcurrency(input.filePaths, 12, async (filePath) => {
        try {
            const content = await fs_1.promises.readFile(filePath, 'utf8');
            const symbols = extractSymbols(filePath, content);
            if (symbols.length > 0) {
                candidateFilePaths.push(filePath);
                symbolMap[filePath] = symbols;
            }
        }
        catch {
            // Ignore unreadable files and continue pre-scanning the batch.
        }
    });
    const result = {
        candidateFilePaths,
        symbolMap,
    };
    worker_threads_1.parentPort?.postMessage(result);
}
void run().catch(() => {
    const fallback = {
        candidateFilePaths: [],
        symbolMap: {},
    };
    worker_threads_1.parentPort?.postMessage(fallback);
});
//# sourceMappingURL=symbolPreScanWorker.js.map