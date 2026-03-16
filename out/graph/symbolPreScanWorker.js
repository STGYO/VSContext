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
    const pushMatch = (regex, kind) => {
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