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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const worker_threads_1 = require("worker_threads");
function extractSymbols(filePath, content) {
    const extension = path.extname(filePath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const symbols = [];
    const seen = new Set();
    const pushSymbol = (name, lineIndex, kind) => {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
            return;
        }
        const key = `${kind}:${lineIndex.toString()}:${name}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        symbols.push({
            name,
            line: lineIndex,
            kind,
        });
    };
    const pushMatch = (regex, kind) => {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const match = regex.exec(line);
            if (match && match[1]) {
                pushSymbol(match[1], lineIndex + 1, kind);
            }
        }
    };
    const pushGlobalMatches = (regex, kind) => {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            regex.lastIndex = 0;
            let match = regex.exec(line);
            while (match) {
                if (match[1]) {
                    pushSymbol(match[1], lineIndex + 1, kind);
                }
                match = regex.exec(line);
            }
        }
    };
    const pushVariableDeclarations = (keyword, kind) => {
        const declarationPattern = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?${keyword}\\s+([^;]+)`, 'i');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const declarationMatch = declarationPattern.exec(line);
            if (!declarationMatch || !declarationMatch[1]) {
                continue;
            }
            const declaration = declarationMatch[1];
            const identifierRegex = /(^|,\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=,]+)?(?==|,|$)/g;
            let identifierMatch = identifierRegex.exec(declaration);
            while (identifierMatch) {
                pushSymbol(identifierMatch[2], lineIndex + 1, kind);
                identifierMatch = identifierRegex.exec(declaration);
            }
        }
    };
    const countIndent = (line) => {
        const match = line.match(/^\s*/);
        return match ? match[0].length : 0;
    };
    const countBraces = (line) => ({
        open: (line.match(/\{/g) ?? []).length,
        close: (line.match(/\}/g) ?? []).length,
    });
    const extractClassMembers = () => {
        let classDepth = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            if (classDepth > 0) {
                const methodMatch = /^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*\{\s*$/.exec(line);
                if (methodMatch && methodMatch[1]) {
                    pushSymbol(methodMatch[1], lineIndex + 1, 'method');
                }
                const constructorMatch = /^\s*constructor\s*\(/.exec(line);
                if (constructorMatch) {
                    pushSymbol('constructor', lineIndex + 1, 'method');
                }
                const fieldMatch = /^\s*(?:(?:public|private|protected|readonly|static|declare|abstract|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?\s*(?:=|;)\s*.*$/.exec(line);
                if (fieldMatch && fieldMatch[1]) {
                    pushSymbol(fieldMatch[1], lineIndex + 1, 'field');
                }
            }
            const openBraces = (trimmed.match(/\{/g) ?? []).length;
            const closeBraces = (trimmed.match(/\}/g) ?? []).length;
            if (/^\s*class\s+[A-Za-z_$][A-Za-z0-9_$]*/.test(line)) {
                classDepth += openBraces - closeBraces;
                if (classDepth <= 0 && openBraces > 0) {
                    classDepth = 1;
                }
                continue;
            }
            if (classDepth > 0) {
                classDepth += openBraces - closeBraces;
                if (classDepth < 0) {
                    classDepth = 0;
                }
            }
        }
    };
    if (extension === '.py') {
        const classIndentStack = [];
        const methodIndentStack = [];
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            const indent = countIndent(line);
            if (trimmed.length > 0 && !trimmed.startsWith('#')) {
                while (classIndentStack.length > 0 && indent <= classIndentStack[classIndentStack.length - 1]) {
                    classIndentStack.pop();
                }
                while (methodIndentStack.length > 0 && indent <= methodIndentStack[methodIndentStack.length - 1]) {
                    methodIndentStack.pop();
                }
            }
            const classMatch = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)/.exec(line);
            if (classMatch && classMatch[1]) {
                pushSymbol(classMatch[1], lineIndex + 1, 'class');
                classIndentStack.push(indent);
                continue;
            }
            const defMatch = /^\s*(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
            if (defMatch && defMatch[1]) {
                if (classIndentStack.length > 0 && indent > classIndentStack[classIndentStack.length - 1]) {
                    pushSymbol(defMatch[1], lineIndex + 1, 'method');
                    methodIndentStack.push(indent);
                }
                else {
                    pushSymbol(defMatch[1], lineIndex + 1, 'function');
                }
                continue;
            }
            const selfFieldMatch = /^\s*(?:self|cls)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            if (selfFieldMatch && selfFieldMatch[1]) {
                pushSymbol(selfFieldMatch[1], lineIndex + 1, 'field');
            }
            const assignmentMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?::[^=]+)?=/.exec(line);
            if (!assignmentMatch || !assignmentMatch[1]) {
                continue;
            }
            const names = assignmentMatch[1].split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
            const inClassScope = classIndentStack.length > 0 && indent > classIndentStack[classIndentStack.length - 1];
            const inMethodScope = methodIndentStack.length > 0 && indent > methodIndentStack[methodIndentStack.length - 1];
            for (const name of names) {
                if (inClassScope && !inMethodScope) {
                    pushSymbol(name, lineIndex + 1, 'field');
                    continue;
                }
                if (indent === 0 && /^[A-Z_][A-Z0-9_]*$/.test(name)) {
                    pushSymbol(name, lineIndex + 1, 'constant');
                }
                else {
                    pushSymbol(name, lineIndex + 1, 'variable');
                }
            }
        }
        return symbols;
    }
    if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.jsx') {
        pushMatch(/^\s*function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, 'function');
        pushMatch(/^\s*class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:extends|\{)/, 'class');
        extractClassMembers();
        pushVariableDeclarations('const', 'constant');
        pushVariableDeclarations('let', 'variable');
        pushVariableDeclarations('var', 'variable');
        pushGlobalMatches(/\bthis\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g, 'field');
        pushGlobalMatches(/\b(?!this\b)[A-Za-z_$][A-Za-z0-9_$]*\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g, 'property');
        pushMatch(/^\s*(?:public|private|protected|readonly|static|declare|abstract|override)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|=|;)/, 'field');
        pushMatch(/^\s*(?:get|set)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, 'property');
        return symbols;
    }
    if (extension === '.go') {
        let inStructBlock = false;
        let structBraceDepth = 0;
        let inConstBlock = false;
        let inVarBlock = false;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            const structMatch = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line);
            if (structMatch && structMatch[1]) {
                pushSymbol(structMatch[1], lineIndex + 1, 'class');
                if (trimmed.includes('{')) {
                    inStructBlock = true;
                    const braceCount = countBraces(line);
                    structBraceDepth += braceCount.open - braceCount.close;
                }
                continue;
            }
            const methodMatch = /^\s*func\s*\([^)]+\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
            if (methodMatch && methodMatch[1]) {
                pushSymbol(methodMatch[1], lineIndex + 1, 'method');
            }
            const functionMatch = /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
            if (functionMatch && functionMatch[1]) {
                pushSymbol(functionMatch[1], lineIndex + 1, 'function');
            }
            if (/^\s*const\s*\(\s*$/.test(line)) {
                inConstBlock = true;
                continue;
            }
            if (/^\s*var\s*\(\s*$/.test(line)) {
                inVarBlock = true;
                continue;
            }
            if (inConstBlock) {
                if (/^\s*\)\s*$/.test(line)) {
                    inConstBlock = false;
                }
                else {
                    const constEntryMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
                    if (constEntryMatch && constEntryMatch[1]) {
                        pushSymbol(constEntryMatch[1], lineIndex + 1, 'constant');
                    }
                }
            }
            if (inVarBlock) {
                if (/^\s*\)\s*$/.test(line)) {
                    inVarBlock = false;
                }
                else {
                    const varEntryMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
                    if (varEntryMatch && varEntryMatch[1]) {
                        pushSymbol(varEntryMatch[1], lineIndex + 1, 'variable');
                    }
                }
            }
            const constMatch = /^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (constMatch && constMatch[1]) {
                pushSymbol(constMatch[1], lineIndex + 1, 'constant');
            }
            const varMatch = /^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (varMatch && varMatch[1]) {
                pushSymbol(varMatch[1], lineIndex + 1, 'variable');
            }
            const shortDeclMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=/.exec(line);
            if (shortDeclMatch && shortDeclMatch[1]) {
                pushSymbol(shortDeclMatch[1], lineIndex + 1, 'variable');
            }
            if (inStructBlock) {
                const fieldMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+[\*\[\]A-Za-z_][A-Za-z0-9_\[\]\*\.]*\b/.exec(line);
                if (fieldMatch && fieldMatch[1]) {
                    pushSymbol(fieldMatch[1], lineIndex + 1, 'field');
                }
                const braceCount = countBraces(line);
                structBraceDepth += braceCount.open - braceCount.close;
                if (structBraceDepth <= 0) {
                    inStructBlock = false;
                    structBraceDepth = 0;
                }
            }
        }
        return symbols;
    }
    if (extension === '.java') {
        let inClassBlock = false;
        let classBraceDepth = 0;
        let inMethodBlock = false;
        let methodBraceDepth = 0;
        let currentClassName = '';
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            const classMatch = /^\s*(?:public|protected|private)?\s*(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (classMatch && classMatch[1]) {
                currentClassName = classMatch[1];
                pushSymbol(currentClassName, lineIndex + 1, 'class');
                if (trimmed.includes('{')) {
                    inClassBlock = true;
                    const braceCount = countBraces(line);
                    classBraceDepth += braceCount.open - braceCount.close;
                }
                continue;
            }
            const methodMatch = /^\s*(?:public|protected|private|static|final|synchronized|native|abstract|\s)+[A-Za-z_][A-Za-z0-9_<>,\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?/.exec(line);
            const constructorMatch = new RegExp(`^\\s*(?:public|protected|private|\\s)+${currentClassName}\\s*\\(`).exec(line);
            if (constructorMatch && currentClassName) {
                pushSymbol(currentClassName, lineIndex + 1, 'method');
                if (trimmed.includes('{')) {
                    inMethodBlock = true;
                    const braceCount = countBraces(line);
                    methodBraceDepth += braceCount.open - braceCount.close;
                }
            }
            else if (methodMatch && methodMatch[1]) {
                pushSymbol(methodMatch[1], lineIndex + 1, inClassBlock ? 'method' : 'function');
                if (trimmed.includes('{')) {
                    inMethodBlock = true;
                    const braceCount = countBraces(line);
                    methodBraceDepth += braceCount.open - braceCount.close;
                }
            }
            const fieldMatch = /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z_][A-Za-z0-9_<>,\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)\s*.*$/.exec(line);
            if (fieldMatch && fieldMatch[1] && inClassBlock && !inMethodBlock) {
                const isConstant = /\bfinal\b/.test(line) || /^[A-Z_][A-Z0-9_]*$/.test(fieldMatch[1]);
                pushSymbol(fieldMatch[1], lineIndex + 1, isConstant ? 'constant' : 'field');
            }
            const localVarMatch = /^\s*(?:final\s+)?[A-Za-z_][A-Za-z0-9_<>,\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)\s*.*$/.exec(line);
            if (localVarMatch && localVarMatch[1] && inMethodBlock) {
                pushSymbol(localVarMatch[1], lineIndex + 1, 'variable');
            }
            const braceCount = countBraces(line);
            if (inMethodBlock) {
                methodBraceDepth += braceCount.open - braceCount.close;
                if (methodBraceDepth <= 0) {
                    inMethodBlock = false;
                    methodBraceDepth = 0;
                }
            }
            if (inClassBlock) {
                classBraceDepth += braceCount.open - braceCount.close;
                if (classBraceDepth <= 0) {
                    inClassBlock = false;
                    classBraceDepth = 0;
                    currentClassName = '';
                }
            }
        }
        return symbols;
    }
    if (extension === '.rs') {
        let inStructBlock = false;
        let structBraceDepth = 0;
        let inImplBlock = false;
        let implBraceDepth = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            const structMatch = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (structMatch && structMatch[1]) {
                pushSymbol(structMatch[1], lineIndex + 1, 'class');
                if (trimmed.includes('{')) {
                    inStructBlock = true;
                    const braceCount = countBraces(line);
                    structBraceDepth += braceCount.open - braceCount.close;
                }
            }
            if (/^\s*impl\b/.test(line) && trimmed.includes('{')) {
                inImplBlock = true;
                const braceCount = countBraces(line);
                implBraceDepth += braceCount.open - braceCount.close;
            }
            const fnMatch = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
            if (fnMatch && fnMatch[1]) {
                pushSymbol(fnMatch[1], lineIndex + 1, inImplBlock ? 'method' : 'function');
            }
            const constMatch = /^\s*(?:pub\s+)?(?:const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (constMatch && constMatch[1]) {
                pushSymbol(constMatch[1], lineIndex + 1, 'constant');
            }
            const letMatch = /^\s*let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (letMatch && letMatch[1]) {
                pushSymbol(letMatch[1], lineIndex + 1, 'variable');
            }
            const selfFieldMatch = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (selfFieldMatch && selfFieldMatch[1]) {
                pushSymbol(selfFieldMatch[1], lineIndex + 1, 'field');
            }
            if (inStructBlock) {
                const fieldMatch = /^\s*(?:pub\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^,]+,?\s*$/.exec(line);
                if (fieldMatch && fieldMatch[1]) {
                    pushSymbol(fieldMatch[1], lineIndex + 1, 'field');
                }
                const braceCount = countBraces(line);
                structBraceDepth += braceCount.open - braceCount.close;
                if (structBraceDepth <= 0) {
                    inStructBlock = false;
                    structBraceDepth = 0;
                }
            }
            if (inImplBlock) {
                const braceCount = countBraces(line);
                implBraceDepth += braceCount.open - braceCount.close;
                if (implBraceDepth <= 0) {
                    inImplBlock = false;
                    implBraceDepth = 0;
                }
            }
        }
        return symbols;
    }
    if (extension === '.c' || extension === '.h' || extension === '.cpp') {
        let inTypeBlock = false;
        let typeBraceDepth = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            const classMatch = /^\s*(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (classMatch && classMatch[1]) {
                pushSymbol(classMatch[1], lineIndex + 1, 'class');
                if (trimmed.includes('{')) {
                    inTypeBlock = true;
                    const braceCount = countBraces(line);
                    typeBraceDepth += braceCount.open - braceCount.close;
                }
            }
            const methodMatch = /^\s*[A-Za-z_][A-Za-z0-9_:<>\s\*&]*::([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/.exec(line);
            if (methodMatch && methodMatch[1]) {
                pushSymbol(methodMatch[1], lineIndex + 1, 'method');
            }
            const functionMatch = /^\s*(?:[A-Za-z_][A-Za-z0-9_:\s\*<>\&]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/.exec(line);
            if (functionMatch && functionMatch[1] && !/^(if|for|while|switch|catch)$/.test(functionMatch[1])) {
                pushSymbol(functionMatch[1], lineIndex + 1, inTypeBlock ? 'method' : 'function');
            }
            const defineMatch = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
            if (defineMatch && defineMatch[1]) {
                pushSymbol(defineMatch[1], lineIndex + 1, 'constant');
            }
            const constMatch = /^\s*(?:static\s+)?const\s+[A-Za-z_][A-Za-z0-9_:\s\*<>\&]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/.exec(line);
            if (constMatch && constMatch[1]) {
                pushSymbol(constMatch[1], lineIndex + 1, 'constant');
            }
            const variableMatch = /^\s*(?:unsigned\s+|signed\s+|static\s+|extern\s+)?[A-Za-z_][A-Za-z0-9_:\s\*<>\&]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)\s*$/.exec(line);
            if (variableMatch && variableMatch[1]) {
                pushSymbol(variableMatch[1], lineIndex + 1, inTypeBlock ? 'field' : 'variable');
            }
            if (inTypeBlock) {
                const fieldMatch = /^\s*[A-Za-z_][A-Za-z0-9_:\s\*<>\&]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/.exec(line);
                if (fieldMatch && fieldMatch[1]) {
                    pushSymbol(fieldMatch[1], lineIndex + 1, 'field');
                }
                const braceCount = countBraces(line);
                typeBraceDepth += braceCount.open - braceCount.close;
                if (typeBraceDepth <= 0) {
                    inTypeBlock = false;
                    typeBraceDepth = 0;
                }
            }
        }
        pushMatch(/^\s*(?:[A-Za-z_][A-Za-z0-9_\s\*]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/, 'function');
        return symbols;
    }
    return symbols;
}
function run() {
    const input = worker_threads_1.workerData;
    const candidateFilePaths = [];
    const symbolMap = {};
    for (const filePath of input.filePaths) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const symbols = extractSymbols(filePath, content);
            if (symbols.length > 0) {
                candidateFilePaths.push(filePath);
                symbolMap[filePath] = symbols;
            }
        }
        catch {
            continue;
        }
    }
    const result = {
        candidateFilePaths,
        symbolMap,
    };
    worker_threads_1.parentPort?.postMessage(result);
}
run();
//# sourceMappingURL=symbolPreScanWorker.js.map