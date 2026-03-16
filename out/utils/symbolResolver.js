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
exports.resolveSelectedSymbol = resolveSelectedSymbol;
exports.openGraphNodeInEditor = openGraphNodeInEditor;
const vscode = __importStar(require("vscode"));
const workspaceScanner_1 = require("./workspaceScanner");
async function resolveSelectedSymbol(graph, explicitNodeId, options) {
    if (explicitNodeId) {
        return graph.nodes.get(explicitNodeId);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showWarningMessage('Open a file and place the cursor inside a function or method.');
        return undefined;
    }
    const filePath = (0, workspaceScanner_1.toWorkspaceRelativePath)(editor.document.uri);
    const fileNodeIds = graph.fileIndex.get(filePath) ?? [];
    const fileNodes = fileNodeIds
        .map((nodeId) => graph.nodes.get(nodeId))
        .filter((node) => node !== undefined);
    const lineNumber = editor.selection.active.line + 1;
    const cursorMatch = fileNodes
        .filter((node) => lineNumber >= node.rangeStartLine && lineNumber <= node.rangeEndLine)
        .sort((left, right) => {
        const leftSpan = left.rangeEndLine - left.rangeStartLine;
        const rightSpan = right.rangeEndLine - right.rangeStartLine;
        return leftSpan - rightSpan;
    })[0];
    if (cursorMatch) {
        return cursorMatch;
    }
    if (fileNodes.length === 0) {
        if (options?.isIndexing) {
            void vscode.window.showInformationMessage('VSContext is still indexing the workspace.');
            return undefined;
        }
        void vscode.window.showWarningMessage('No function symbols were found in the current file.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(fileNodes.map((node) => ({
        label: node.symbolName,
        description: `${node.filePath}:${node.lineNumber}`,
        nodeId: node.id,
    })), {
        placeHolder: 'Select a function or method to analyze',
    });
    if (!picked) {
        return undefined;
    }
    return graph.nodes.get(picked.nodeId);
}
async function openGraphNodeInEditor(node) {
    const uri = vscode.Uri.parse(node.uriString);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(Math.max(0, node.lineNumber - 1), 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
//# sourceMappingURL=symbolResolver.js.map