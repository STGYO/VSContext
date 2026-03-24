import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph, WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { KNOWLEDGE_MODEL_MANIFEST, KNOWLEDGE_MODEL_VERSION } from '../graph/knowledgeModel';
import { Logger } from '../utils/logger';
import { openGraphWebviewPanel } from './graphWebviewProvider';

export type CodeGraphNodeType = 'file' | 'class' | 'function' | 'method' | 'variable';

export type CodeGraphRelationship =
  | 'file-class'
  | 'file-method'
  | 'file-function'
  | 'file-variable'
  | 'class-method'
  | 'function-variable'
  | 'method-variable'
  | 'calls'
  | 'implements'
  | 'reads'
  | 'writes'
  | 'file-dependency';

export interface NodeNavigationTarget {
  readonly uriString: string;
  readonly line: number;
  readonly rangeStartLine: number;
  readonly rangeStartCharacter: number;
  readonly rangeEndLine: number;
  readonly rangeEndCharacter: number;
}

export interface CodeGraphNode {
  readonly id: string;
  readonly name: string;
  readonly type: CodeGraphNodeType;
  readonly filePath: string;
  readonly uriString: string;
  readonly line: number;
  readonly rangeStartLine: number;
  readonly rangeStartCharacter: number;
  readonly rangeEndLine: number;
  readonly rangeEndCharacter: number;
  readonly parentId?: string;
  degree: number;
}

export interface CodeGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relationship: CodeGraphRelationship;
}

export interface CodeGraphPayload {
  readonly nodes: CodeGraphNode[];
  readonly edges: CodeGraphEdge[];
  readonly meta: {
    readonly generatedAt: string;
    readonly knowledgeModelVersion: number;
    readonly knowledgeNodeKinds: readonly string[];
    readonly knowledgeRelationshipKinds: readonly string[];
    readonly symbolNodeCount: number;
    readonly fileNodeCount: number;
    readonly edgeCount: number;
  };
}

interface FileNodeInfo {
  readonly id: string;
  readonly uriString: string;
}

export async function openCodeGraphView(
  context: vscode.ExtensionContext,
  graphBuilder: WorkspaceGraphBuilder,
  logger: Logger,
): Promise<void> {
  if (!graphBuilder.hasCompletedInitialIndex()) {
    void vscode.window.showInformationMessage('Workspace graph not ready yet.');
    return;
  }

  const graph = graphBuilder.peekGraph();
  if (graph.nodes.size === 0) {
    void vscode.window.showInformationMessage('No indexed symbols available.');
    return;
  }

  const payload = serializeWorkspaceGraph(graph);
  await openGraphWebviewPanel(context, payload, logger, openTargetInEditor);
}

function serializeWorkspaceGraph(graph: WorkspaceGraph): CodeGraphPayload {
  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const degreeByNodeId = new Map<string, number>();
  const fileNodeByPath = new Map<string, FileNodeInfo>();

  const sortedFilePaths = [...graph.fileIndex.keys()].sort((left, right) => left.localeCompare(right));

  for (const filePath of sortedFilePaths) {
    const nodeIds = graph.fileIndex.get(filePath) ?? [];
    const symbols = nodeIds
      .map((nodeId) => graph.nodes.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined);

    if (symbols.length === 0) {
      continue;
    }

    const firstSymbol = symbols[0];
    const fileNodeId = `file::${filePath}`;
    fileNodeByPath.set(filePath, {
      id: fileNodeId,
      uriString: firstSymbol.uriString,
    });

    nodes.push({
      id: fileNodeId,
      name: filePath,
      type: 'file',
      filePath,
      uriString: firstSymbol.uriString,
      line: 1,
      rangeStartLine: 1,
      rangeStartCharacter: 0,
      rangeEndLine: 1,
      rangeEndCharacter: 1,
      degree: 0,
    });

    for (const symbol of symbols) {
      nodes.push({
        id: symbol.id,
        name: symbol.symbolName,
        type: symbol.nodeType,
        filePath: symbol.filePath,
        uriString: symbol.uriString,
        line: symbol.lineNumber,
        rangeStartLine: symbol.rangeStartLine,
        rangeStartCharacter: symbol.rangeStartCharacter,
        rangeEndLine: symbol.rangeEndLine,
        rangeEndCharacter: symbol.rangeEndCharacter,
        parentId: fileNodeId,
        degree: 0,
      });

      addEdge(
        edges,
        edgeKeys,
        degreeByNodeId,
        fileNodeId,
        symbol.id,
        resolveFileRelationship(symbol.nodeType),
      );
    }

    connectContainedSymbols(edges, edgeKeys, degreeByNodeId, symbols);
  }

  for (const symbol of graph.nodes.values()) {
    for (const targetId of symbol.outgoingCalls) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) {
        continue;
      }

      addEdge(edges, edgeKeys, degreeByNodeId, symbol.id, targetId, 'calls');

      if (symbol.filePath !== targetNode.filePath) {
        const sourceFileNodeId = fileNodeByPath.get(symbol.filePath)?.id;
        const targetFileNodeId = fileNodeByPath.get(targetNode.filePath)?.id;
        if (sourceFileNodeId && targetFileNodeId) {
          addEdge(edges, edgeKeys, degreeByNodeId, sourceFileNodeId, targetFileNodeId, 'file-dependency');
        }
      }
    }

    for (const targetId of symbol.implementations) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) {
        continue;
      }

      addEdge(edges, edgeKeys, degreeByNodeId, symbol.id, targetId, 'implements');

      if (symbol.filePath !== targetNode.filePath) {
        const sourceFileNodeId = fileNodeByPath.get(symbol.filePath)?.id;
        const targetFileNodeId = fileNodeByPath.get(targetNode.filePath)?.id;
        if (sourceFileNodeId && targetFileNodeId) {
          addEdge(edges, edgeKeys, degreeByNodeId, sourceFileNodeId, targetFileNodeId, 'file-dependency');
        }
      }
    }

    for (const targetId of symbol.references.reads) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) {
        continue;
      }

      addEdge(edges, edgeKeys, degreeByNodeId, symbol.id, targetId, 'reads');

      if (symbol.filePath !== targetNode.filePath) {
        const sourceFileNodeId = fileNodeByPath.get(symbol.filePath)?.id;
        const targetFileNodeId = fileNodeByPath.get(targetNode.filePath)?.id;
        if (sourceFileNodeId && targetFileNodeId) {
          addEdge(edges, edgeKeys, degreeByNodeId, sourceFileNodeId, targetFileNodeId, 'file-dependency');
        }
      }
    }

    for (const targetId of symbol.references.writes) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) {
        continue;
      }

      addEdge(edges, edgeKeys, degreeByNodeId, symbol.id, targetId, 'writes');

      if (symbol.filePath !== targetNode.filePath) {
        const sourceFileNodeId = fileNodeByPath.get(symbol.filePath)?.id;
        const targetFileNodeId = fileNodeByPath.get(targetNode.filePath)?.id;
        if (sourceFileNodeId && targetFileNodeId) {
          addEdge(edges, edgeKeys, degreeByNodeId, sourceFileNodeId, targetFileNodeId, 'file-dependency');
        }
      }
    }
  }

  for (const node of nodes) {
    node.degree = degreeByNodeId.get(node.id) ?? 0;
  }

  return {
    nodes,
    edges,
    meta: {
      generatedAt: new Date().toISOString(),
      knowledgeModelVersion: KNOWLEDGE_MODEL_VERSION,
      knowledgeNodeKinds: [...KNOWLEDGE_MODEL_MANIFEST.nodeKinds],
      knowledgeRelationshipKinds: [...KNOWLEDGE_MODEL_MANIFEST.relationshipKinds],
      symbolNodeCount: graph.nodes.size,
      fileNodeCount: fileNodeByPath.size,
      edgeCount: edges.length,
    },
  };
}

function connectContainedSymbols(
  edges: CodeGraphEdge[],
  edgeKeys: Set<string>,
  degreeByNodeId: Map<string, number>,
  symbols: GraphNode[],
): void {
  const classes = symbols.filter((node) => node.nodeType === 'class');
  const methods = symbols.filter((node) => node.nodeType === 'method');
  const functions = symbols.filter((node) => node.nodeType === 'function');
  const variables = symbols.filter((node) => node.nodeType === 'variable');

  for (const classNode of classes) {
    for (const methodNode of methods) {
      if (isContainedWithin(classNode, methodNode)) {
        addEdge(edges, edgeKeys, degreeByNodeId, classNode.id, methodNode.id, 'class-method');
      }
    }
  }

  for (const functionNode of functions) {
    for (const variableNode of variables) {
      if (isContainedWithin(functionNode, variableNode)) {
        addEdge(edges, edgeKeys, degreeByNodeId, functionNode.id, variableNode.id, 'function-variable');
      }
    }
  }

  for (const methodNode of methods) {
    for (const variableNode of variables) {
      if (isContainedWithin(methodNode, variableNode)) {
        addEdge(edges, edgeKeys, degreeByNodeId, methodNode.id, variableNode.id, 'method-variable');
      }
    }
  }
}

function isContainedWithin(outer: GraphNode, inner: GraphNode): boolean {
  if (outer.id === inner.id) {
    return false;
  }

  if (inner.rangeStartLine < outer.rangeStartLine || inner.rangeEndLine > outer.rangeEndLine) {
    return false;
  }

  if (inner.rangeStartLine === outer.rangeStartLine && inner.rangeStartCharacter < outer.rangeStartCharacter) {
    return false;
  }

  if (inner.rangeEndLine === outer.rangeEndLine && inner.rangeEndCharacter > outer.rangeEndCharacter) {
    return false;
  }

  return true;
}

function addEdge(
  edges: CodeGraphEdge[],
  edgeKeys: Set<string>,
  degreeByNodeId: Map<string, number>,
  source: string,
  target: string,
  relationship: CodeGraphRelationship,
): void {
  const key = `${source}=>${target}::${relationship}`;
  if (edgeKeys.has(key)) {
    return;
  }

  edgeKeys.add(key);
  edges.push({
    id: key,
    source,
    target,
    relationship,
  });

  degreeByNodeId.set(source, (degreeByNodeId.get(source) ?? 0) + 1);
  degreeByNodeId.set(target, (degreeByNodeId.get(target) ?? 0) + 1);
}

function resolveFileRelationship(nodeType: GraphNode['nodeType']): CodeGraphRelationship {
  if (nodeType === 'class') {
    return 'file-class';
  }

  if (nodeType === 'method') {
    return 'file-method';
  }

  if (nodeType === 'variable') {
    return 'file-variable';
  }

  return 'file-function';
}

async function openTargetInEditor(target: NodeNavigationTarget): Promise<void> {
  const uri = vscode.Uri.parse(target.uriString);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  const start = new vscode.Position(
    Math.max(0, target.rangeStartLine - 1),
    Math.max(0, target.rangeStartCharacter),
  );
  const end = new vscode.Position(
    Math.max(0, target.rangeEndLine - 1),
    Math.max(0, target.rangeEndCharacter),
  );
  const range = new vscode.Range(start, end);

  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
