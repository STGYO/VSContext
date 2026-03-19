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
    nodeId;
    constructor(label, collapsibleState, id, children = [], nodeId) {
        super(label || 'Unnamed Item', collapsibleState);
        this.id = id || `item:${Date.now().toString()}`;
        this.children = children;
        this.nodeId = nodeId;
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
        const workspaceNode = new VSContextTreeItem('Workspace', vscode.TreeItemCollapsibleState.Expanded, 'vscontext:workspace', [filesNode]);
        workspaceNode.iconPath = this.themeIcon('root-folder');
        const symbolsNode = this.buildSymbolsNode(graph);
        symbolsNode.iconPath = this.themeIcon('symbol-namespace');
        return [workspaceNode, symbolsNode];
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
                .filter((node) => node.symbolKind === vscode.SymbolKind.Function)
                .map((node) => this.createSymbolItem(node, true));
            const methodItems = symbols
                .filter((node) => this.isMethodLike(node.symbolKind))
                .map((node) => this.createSymbolItem(node, true));
            const classItems = symbols
                .filter((node) => node.symbolKind === vscode.SymbolKind.Class)
                .map((node) => this.createSymbolItem(node, false));
            const constantItems = symbols
                .filter((node) => node.symbolKind === vscode.SymbolKind.Constant)
                .map((node) => this.createSymbolItem(node, false));
            const fieldItems = symbols
                .filter((node) => node.symbolKind === vscode.SymbolKind.Field || node.symbolKind === vscode.SymbolKind.Property)
                .map((node) => this.createSymbolItem(node, false));
            const localVariableItems = symbols
                .filter((node) => node.symbolKind === vscode.SymbolKind.Variable)
                .map((node) => this.createSymbolItem(node, false));
            const groupedChildren = [
                new VSContextTreeItem(this.withCount('Functions', functionItems.length), vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:functions`, functionItems.length > 0
                    ? functionItems
                    : [new VSContextTreeItem('No functions', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:functions:empty`)]),
                new VSContextTreeItem(this.withCount('Methods', methodItems.length), vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:methods`, methodItems.length > 0
                    ? methodItems
                    : [new VSContextTreeItem('No methods', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:methods:empty`)]),
                new VSContextTreeItem(this.withCount('Classes', classItems.length), vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:classes`, classItems.length > 0
                    ? classItems
                    : [new VSContextTreeItem('No classes', vscode.TreeItemCollapsibleState.None, `vscontext:file:${filePath}:classes:empty`)]),
                new VSContextTreeItem(this.withCount('Variables', constantItems.length + fieldItems.length + localVariableItems.length), vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}:variables`, this.buildVariableGroupChildren(`vscontext:file:${filePath}:variables`, constantItems, fieldItems, localVariableItems)),
            ];
            groupedChildren[0].iconPath = this.themeIcon('symbol-function');
            groupedChildren[1].iconPath = this.themeIcon('symbol-method');
            groupedChildren[2].iconPath = this.themeIcon('symbol-class');
            groupedChildren[3].iconPath = this.themeIcon('symbol-variable');
            const fileItem = new VSContextTreeItem(filePath || 'Unnamed File', vscode.TreeItemCollapsibleState.Collapsed, `vscontext:file:${filePath}`, groupedChildren);
            fileItem.iconPath = this.themeIcon('file');
            fileItems.push(fileItem);
        }
        if (fileItems.length === 0) {
            fileItems.push(new VSContextTreeItem('No symbols indexed yet', vscode.TreeItemCollapsibleState.None, 'vscontext:file:empty'));
        }
        const filesNode = new VSContextTreeItem(this.withCount('Files', fileItems.filter((item) => item.id?.startsWith('vscontext:file:') && !item.id?.endsWith(':empty')).length), fileItems.length > 25
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded, 'vscontext:files', fileItems);
        filesNode.iconPath = this.themeIcon('files');
        return filesNode;
    }
    createSymbolItem(node, appendCallSuffix) {
        const baseLabel = node.symbolName && node.symbolName.trim().length > 0 ? node.symbolName : 'Unknown Symbol';
        const item = new VSContextTreeItem(appendCallSuffix ? `${baseLabel}()` : baseLabel, vscode.TreeItemCollapsibleState.None, `vscontext:symbol:${node.id}`, [], node.id);
        item.description = `Line ${node.lineNumber}`;
        item.command = {
            command: 'vscontext.openNode',
            title: 'Open Symbol',
            arguments: [node.id],
        };
        item.contextValue = this.isVariableLike(node.symbolKind)
            ? 'vscontext.variable'
            : appendCallSuffix
                ? 'vscontext.method'
                : 'vscontext.class';
        item.iconPath = this.getNodeIcon(node.symbolKind);
        this.logTreeNodeCreation(node);
        return item;
    }
    isFunctionLike(kind) {
        return (kind === vscode.SymbolKind.Function);
    }
    isMethodLike(kind) {
        return kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Constructor;
    }
    isVariableLike(kind) {
        return (kind === vscode.SymbolKind.Variable
            || kind === vscode.SymbolKind.Constant
            || kind === vscode.SymbolKind.Field
            || kind === vscode.SymbolKind.Property);
    }
    getNodeIcon(kind) {
        if (this.isFunctionLike(kind)) {
            return this.themeIcon('symbol-function');
        }
        if (this.isMethodLike(kind)) {
            return this.themeIcon('symbol-method');
        }
        if (kind === vscode.SymbolKind.Class) {
            return this.themeIcon('symbol-class');
        }
        if (kind === vscode.SymbolKind.Constant) {
            return this.themeIcon('symbol-constant');
        }
        if (kind === vscode.SymbolKind.Field) {
            return this.themeIcon('symbol-field');
        }
        if (kind === vscode.SymbolKind.Property) {
            return this.themeIcon('symbol-property');
        }
        if (kind === vscode.SymbolKind.Variable) {
            return this.themeIcon('symbol-variable');
        }
        return this.themeIcon('symbol-misc');
    }
    themeIcon(id) {
        const ThemeIconCtor = vscode.ThemeIcon;
        return new ThemeIconCtor(id);
    }
    buildSymbolsNode(graph) {
        const allNodes = [...graph.nodes.values()];
        const functionItems = allNodes
            .filter((node) => node.symbolKind === vscode.SymbolKind.Function)
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, true));
        const methodItems = allNodes
            .filter((node) => this.isMethodLike(node.symbolKind))
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, true));
        const classItems = allNodes
            .filter((node) => node.symbolKind === vscode.SymbolKind.Class)
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, false));
        const constantItems = allNodes
            .filter((node) => node.symbolKind === vscode.SymbolKind.Constant)
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, false));
        const fieldItems = allNodes
            .filter((node) => node.symbolKind === vscode.SymbolKind.Field || node.symbolKind === vscode.SymbolKind.Property)
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, false));
        const localVariableItems = allNodes
            .filter((node) => node.symbolKind === vscode.SymbolKind.Variable)
            .sort((left, right) => left.symbolName.localeCompare(right.symbolName))
            .map((node) => this.createSymbolItem(node, false));
        const variableChildren = this.buildVariableGroupChildren('vscontext:symbols:variables', constantItems, fieldItems, localVariableItems);
        const symbolsNode = new VSContextTreeItem(this.withCount('Symbols', allNodes.length), vscode.TreeItemCollapsibleState.Collapsed, 'vscontext:symbols', [
            this.createSymbolCategoryItem(this.withCount('Classes', classItems.length), 'vscontext:symbols:classes', classItems, 'symbol-class', 'No classes'),
            this.createSymbolCategoryItem(this.withCount('Functions', functionItems.length), 'vscontext:symbols:functions', functionItems, 'symbol-function', 'No functions'),
            this.createSymbolCategoryItem(this.withCount('Methods', methodItems.length), 'vscontext:symbols:methods', methodItems, 'symbol-method', 'No methods'),
            new VSContextTreeItem(this.withCount('Variables', constantItems.length + fieldItems.length + localVariableItems.length), vscode.TreeItemCollapsibleState.Collapsed, 'vscontext:symbols:variables', variableChildren),
        ]);
        symbolsNode.children[3].iconPath = this.themeIcon('symbol-variable');
        return symbolsNode;
    }
    buildVariableGroupChildren(parentId, constantItems, fieldItems, localVariableItems) {
        return [
            this.createSymbolCategoryItem(this.withCount('Constants', constantItems.length), `${parentId}:constants`, constantItems, 'symbol-constant', 'No constants'),
            this.createSymbolCategoryItem(this.withCount('Fields', fieldItems.length), `${parentId}:fields`, fieldItems, 'symbol-field', 'No fields'),
            this.createSymbolCategoryItem(this.withCount('Locals', localVariableItems.length), `${parentId}:locals`, localVariableItems, 'symbol-variable', 'No local variables'),
        ];
    }
    withCount(label, count) {
        return `${label} (${count})`;
    }
    createSymbolCategoryItem(label, id, children, iconName, emptyLabel) {
        const category = new VSContextTreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, id, children.length > 0 ? children : [new VSContextTreeItem(emptyLabel, vscode.TreeItemCollapsibleState.None, `${id}:empty`)]);
        category.iconPath = this.themeIcon(iconName);
        return category;
    }
    logTreeNodeCreation(node) {
        if (!this.isSymbolDebugEnabled()) {
            return;
        }
        const kindLabel = vscode.SymbolKind[node.symbolKind] ?? node.symbolKind.toString();
        this.logger.info(`[VSContext][debug] Tree node created: ${node.symbolName} (${kindLabel})`);
    }
    isSymbolDebugEnabled() {
        return vscode.workspace.getConfiguration('vscontext').get('debugSymbolDetection', false);
    }
}
exports.ContextTreeProvider = ContextTreeProvider;
//# sourceMappingURL=contextTreeProvider.js.map