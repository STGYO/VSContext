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
exports.ContextTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class VSContextTreeItem extends vscode.TreeItem {
    children;
    constructor(label, collapsibleState, id, children = []) {
        super(label || 'Unnamed Item', collapsibleState);
        this.id = id || `item:${Date.now().toString()}`;
        this.children = children;
    }
}
class ContextTreeProvider {
    graphBuilder;
    logger;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(graphBuilder, logger) {
        this.graphBuilder = graphBuilder;
        this.logger = logger;
    }
    refresh() {
        this.logger.info('Tree refresh requested.');
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        try {
            if (element) {
                return element.children ?? [];
            }
            const graph = this.graphBuilder.peekGraph();
            this.logger.info(`Tree root requested with ${graph.nodes.size} nodes.`);
            return this.buildRootTree(graph, this.graphBuilder.isIndexing());
        }
        catch (error) {
            this.logger.error('Tree rendering failed.', error);
            return [
                new VSContextTreeItem('VSContext tree failed to render', vscode.TreeItemCollapsibleState.None, 'vscontext:error'),
            ];
        }
    }
    buildRootTree(graph, isIndexing) {
        const filesNode = this.buildFilesNode(graph, isIndexing);
        const analysisNode = this.buildAnalysisNode();
        const workspaceNode = new VSContextTreeItem('Workspace', vscode.TreeItemCollapsibleState.Expanded, 'vscontext:workspace', [filesNode, analysisNode]);
        return [workspaceNode];
    }
    buildFilesNode(graph, isIndexing) {
        const fileItems = [];
        if (isIndexing && graph.nodes.size === 0) {
            fileItems.push(new VSContextTreeItem('Indexing workspace symbols...', vscode.TreeItemCollapsibleState.None, 'vscontext:indexing:loading'));
        }
        const sortedFiles = [...graph.fileIndex.keys()].sort((left, right) => left.localeCompare(right));
        for (const filePath of sortedFiles) {
            const nodeIds = graph.fileIndex.get(filePath) ?? [];
            const symbols = nodeIds
                .map((nodeId) => graph.nodes.get(nodeId))
                .filter((node) => node !== undefined);
            const functionItems = symbols
                .filter((node) => this.isFunctionLike(node.symbolKind))
                .map((node) => this.createSymbolItem(node, true));
            const classItems = symbols
                .filter((node) => node.symbolKind === vscode.SymbolKind.Class)
                .map((node) => this.createSymbolItem(node, false));
            const groupedChildren = [
                new VSContextTreeItem('Functions', vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:functions`, functionItems.length > 0
                    ? functionItems
                    : [new VSContextTreeItem('No functions', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:functions:empty`)]),
                new VSContextTreeItem('Classes', vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:classes`, classItems.length > 0
                    ? classItems
                    : [new VSContextTreeItem('No classes', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:classes:empty`)]),
            ];
            const fileItem = new VSContextTreeItem(filePath || 'Unnamed File', vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}`, groupedChildren);
            fileItems.push(fileItem);
        }
        if (fileItems.length === 0) {
            fileItems.push(new VSContextTreeItem('No symbols indexed yet', vscode.TreeItemCollapsibleState.None, 'vscontext:file:empty'));
        }
        const filesNode = new VSContextTreeItem('Files', vscode.TreeItemCollapsibleState.Expanded, 'vscontext:files', fileItems);
        return filesNode;
    }
    createSymbolItem(node, appendCallSuffix) {
        const baseLabel = node.symbolName && node.symbolName.trim().length > 0 ? node.symbolName : 'Unknown Symbol';
        const item = new VSContextTreeItem(appendCallSuffix ? `${baseLabel}()` : baseLabel, vscode.TreeItemCollapsibleState.None, `vscontext:symbol:${node.id}`);
        item.description = `Line ${node.lineNumber}`;
        item.command = {
            command: 'vscontext.openNode',
            title: 'Open Symbol',
            arguments: [node.id],
        };
        item.contextValue = appendCallSuffix ? 'vscontext.method' : 'vscontext.class';
        return item;
    }
    isFunctionLike(kind) {
        return (kind === vscode.SymbolKind.Function
            || kind === vscode.SymbolKind.Method
            || kind === vscode.SymbolKind.Constructor);
    }
    buildAnalysisNode() {
        const traceItem = new VSContextTreeItem('Trace Execution Path', vscode.TreeItemCollapsibleState.None, 'vscontext:analysis:trace');
        traceItem.command = {
            command: 'vscontext.traceExecution',
            title: 'Trace Execution Path',
        };
        const impactItem = new VSContextTreeItem('Impact Analysis', vscode.TreeItemCollapsibleState.None, 'vscontext:analysis:impact');
        impactItem.command = {
            command: 'vscontext.findImpact',
            title: 'Find Impact of Change',
        };
        const analysisNode = new VSContextTreeItem('Analysis', vscode.TreeItemCollapsibleState.Expanded, 'vscontext:analysis', [traceItem, impactItem]);
        return analysisNode;
    }
}
exports.ContextTreeProvider = ContextTreeProvider;
//# sourceMappingURL=contextTreeProvider.js.map