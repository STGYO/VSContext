import type * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph, WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { KNOWLEDGE_MODEL_MANIFEST, KNOWLEDGE_MODEL_VERSION } from '../graph/knowledgeModel';
import { Logger } from '../utils/logger';

export type CodeGraphNodeType =
  | 'file'
  | 'branch'
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'dependency'
  | 'metadata';

export type CodeGraphBranchKind =
  | 'metadata'
  | 'dependencies'
  | 'global-scope'
  | 'definitions'
  | 'docstrings'
  | 'comments'
  | 'imports'
  | 'includes'
  | 'constants'
  | 'variables'
  | 'locals'
  | 'classes'
  | 'functions'
  | 'methods'
  | 'interfaces'
  | 'enums'
  | 'modules';

export type CodeGraphRelationship =
  | 'file-branch'
  | 'branch-subbranch'
  | 'branch-leaf'
  | 'dependency-import'
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
  | 'file-dependency'
  | 'imports'
  | 'covers'
  | 'documents'
  | 'related-to';

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
  readonly branchKind?: CodeGraphBranchKind;
  readonly symbolKind?: string;
  readonly treeLevel?: number;
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

interface FileTreeBranchIds {
  readonly metadata: string;
  readonly dependencies: string;
  readonly globalScope: string;
  readonly definitions: string;
  readonly docstrings: string;
  readonly comments: string;
  readonly imports: string;
  readonly includes: string;
  readonly constants: string;
  readonly variables: string;
  readonly locals: string;
  readonly classes: string;
  readonly functions: string;
  readonly methods: string;
  readonly interfaces: string;
  readonly enums: string;
  readonly modules: string;
}

const SYMBOL_KIND = {
  Module: 1,
  Namespace: 2,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  TypeParameter: 25,
} as const;

const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'Module',
  2: 'Namespace',
  4: 'Class',
  5: 'Method',
  6: 'Property',
  7: 'Field',
  8: 'Constructor',
  9: 'Enum',
  10: 'Interface',
  11: 'Function',
  12: 'Variable',
  13: 'Constant',
  25: 'TypeParameter',
};

function getVscodeApi(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

export async function openCodeGraphView(
  context: vscode.ExtensionContext,
  graphBuilder: WorkspaceGraphBuilder,
  logger: Logger,
): Promise<void> {
  const vscodeApi = getVscodeApi();

  if (!graphBuilder.hasCompletedInitialIndex()) {
    void vscodeApi.window.showInformationMessage('Workspace graph not ready yet.');
    return;
  }

  const graph = graphBuilder.peekGraph();
  if (graph.nodes.size === 0) {
    void vscodeApi.window.showInformationMessage('No indexed symbols available.');
    return;
  }

  const payload = serializeWorkspaceGraph(graph);
  const { openGraphWebviewPanel } = require('./graphWebviewProvider') as typeof import('./graphWebviewProvider');
  await openGraphWebviewPanel(context, payload, logger, openTargetInEditor);
}

function serializeWorkspaceGraph(graph: WorkspaceGraph): CodeGraphPayload {
  const nodes: CodeGraphNode[] = [];
  const nodeById = new Map<string, CodeGraphNode>();
  const edges: CodeGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const degreeByNodeId = new Map<string, number>();
  const fileNodeByPath = new Map<string, FileNodeInfo>();
  const relationshipsBySource = new Map<string, typeof graph.fileRelationships>();

  for (const [filePath, nodeIds] of graph.fileIndex) {
    const symbols = nodeIds
      .map((nodeId) => graph.nodes.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined);

    if (symbols.length === 0) {
      continue;
    }

    fileNodeByPath.set(filePath, {
      id: `file::${filePath}`,
      uriString: symbols[0].uriString,
    });
  }

  for (const relationship of graph.fileRelationships) {
    ensureFileNodeInfo(fileNodeByPath, relationship.sourceFilePath, relationship.sourceUriString);
    ensureFileNodeInfo(fileNodeByPath, relationship.targetFilePath, relationship.targetUriString);

    const bucket = relationshipsBySource.get(relationship.sourceFilePath) ?? [];
    bucket.push(relationship);
    relationshipsBySource.set(relationship.sourceFilePath, bucket);
  }

  const sortedFilePaths = [...fileNodeByPath.keys()].sort((left, right) => left.localeCompare(right));

  for (const filePath of sortedFilePaths) {
    const nodeIds = graph.fileIndex.get(filePath) ?? [];
    const symbols = nodeIds
      .map((nodeId) => graph.nodes.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined);

    const fileNodeInfo = fileNodeByPath.get(filePath);
    if (!fileNodeInfo) {
      continue;
    }

    const fileNode: CodeGraphNode = {
      id: fileNodeInfo.id,
      name: filePath,
      type: 'file',
      filePath,
      uriString: fileNodeInfo.uriString,
      line: 1,
      rangeStartLine: 1,
      rangeStartCharacter: 0,
      rangeEndLine: 1,
      rangeEndCharacter: 1,
      treeLevel: 0,
      degree: 0,
    };
    addNode(nodes, nodeById, fileNode);

    const branches = buildFileTreeBranches(
      filePath,
      fileNode,
      nodes,
      nodeById,
      edges,
      edgeKeys,
      degreeByNodeId,
    );

    const sourceRelationships = relationshipsBySource.get(filePath) ?? [];
    const importRelationships = sourceRelationships.filter(
      (relationship) => relationship.relationship === 'imports',
    );
    if (importRelationships.length === 0) {
      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.imports,
        {
          id: `dependency::${filePath}::imports::none`,
          name: 'No extracted imports',
          type: 'dependency',
          branchKind: 'imports',
          filePath,
          uriString: fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );

      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.includes,
        {
          id: `dependency::${filePath}::includes::none`,
          name: 'No resolved targets',
          type: 'dependency',
          branchKind: 'includes',
          filePath,
          uriString: fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );
    }

    for (const relationship of importRelationships) {
      const targetFileNode = fileNodeByPath.get(relationship.targetFilePath);
      const dependencyLeafId = `dependency::${filePath}::imports::${relationship.targetFilePath}`;
      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.imports,
        {
          id: dependencyLeafId,
          name: relationship.targetFilePath,
          type: 'dependency',
          branchKind: 'imports',
          filePath,
          uriString: relationship.targetUriString || fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );

      if (targetFileNode) {
        addEdge(
          edges,
          edgeKeys,
          degreeByNodeId,
          dependencyLeafId,
          targetFileNode.id,
          'dependency-import',
        );
      }

      const resolvedLeafId = `dependency::${filePath}::includes::${relationship.targetFilePath}`;
      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.includes,
        {
          id: resolvedLeafId,
          name: relationship.targetFilePath,
          type: 'dependency',
          branchKind: 'includes',
          filePath,
          uriString: relationship.targetUriString || fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );

      if (targetFileNode) {
        addEdge(
          edges,
          edgeKeys,
          degreeByNodeId,
          resolvedLeafId,
          targetFileNode.id,
          'dependency-import',
        );
      }
    }

    const documentRelationships = sourceRelationships.filter(
      (relationship) => relationship.relationship === 'documents',
    );
    if (documentRelationships.length === 0) {
      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.comments,
        {
          id: `metadata::${filePath}::comments::none`,
          name: 'No extracted comments/docstrings',
          type: 'metadata',
          branchKind: 'comments',
          filePath,
          uriString: fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );
    }

    for (const relationship of documentRelationships) {
      const targetFileNode = fileNodeByPath.get(relationship.targetFilePath);
      const metadataLeafId = `metadata::${filePath}::documents::${relationship.targetFilePath}`;
      addSyntheticLeafNode(
        nodes,
        nodeById,
        branches.docstrings,
        {
          id: metadataLeafId,
          name: relationship.targetFilePath,
          type: 'metadata',
          branchKind: 'docstrings',
          filePath,
          uriString: relationship.targetUriString || fileNodeInfo.uriString,
        },
        edges,
        edgeKeys,
        degreeByNodeId,
      );

      if (targetFileNode) {
        addEdge(
          edges,
          edgeKeys,
          degreeByNodeId,
          metadataLeafId,
          targetFileNode.id,
          'documents',
        );
      }
    }

    const symbolsBySize = [...symbols].sort((left, right) => {
      const leftSize = (left.rangeEndLine - left.rangeStartLine) * 200 + (left.rangeEndCharacter - left.rangeStartCharacter);
      const rightSize = (right.rangeEndLine - right.rangeStartLine) * 200 + (right.rangeEndCharacter - right.rangeStartCharacter);
      return leftSize - rightSize;
    });

    for (const symbol of symbolsBySize) {
      const branchTargetId = resolveBranchTargetForSymbol(symbol, symbolsBySize, branches);

      const branchParent = nodeById.get(branchTargetId);
      const symbolNode: CodeGraphNode = {
        id: symbol.id,
        name: symbol.symbolName,
        type: symbol.nodeType,
        branchKind: branchParent?.branchKind,
        symbolKind: symbolKindLabel(symbol.symbolKind),
        filePath: symbol.filePath,
        uriString: symbol.uriString,
        line: symbol.lineNumber,
        rangeStartLine: symbol.rangeStartLine,
        rangeStartCharacter: symbol.rangeStartCharacter,
        rangeEndLine: symbol.rangeEndLine,
        rangeEndCharacter: symbol.rangeEndCharacter,
        parentId: branchTargetId,
        treeLevel: (branchParent?.treeLevel ?? 2) + 1,
        degree: 0,
      };
      addNode(nodes, nodeById, symbolNode);
      addEdge(edges, edgeKeys, degreeByNodeId, branchTargetId, symbol.id, 'branch-leaf');
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

  for (const relationship of graph.fileRelationships) {
    const sourceNode = fileNodeByPath.get(relationship.sourceFilePath);
    const targetNode = fileNodeByPath.get(relationship.targetFilePath);
    if (!sourceNode || !targetNode) {
      continue;
    }

    addEdge(edges, edgeKeys, degreeByNodeId, sourceNode.id, targetNode.id, relationship.relationship);
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

export function serializeWorkspaceGraphForTests(
  graph: WorkspaceGraph,
): CodeGraphPayload {
  return serializeWorkspaceGraph(graph);
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

function addNode(
  nodes: CodeGraphNode[],
  nodeById: Map<string, CodeGraphNode>,
  node: CodeGraphNode,
): void {
  if (nodeById.has(node.id)) {
    return;
  }

  nodeById.set(node.id, node);
  nodes.push(node);
}

function buildFileTreeBranches(
  filePath: string,
  fileNode: CodeGraphNode,
  nodes: CodeGraphNode[],
  nodeById: Map<string, CodeGraphNode>,
  edges: CodeGraphEdge[],
  edgeKeys: Set<string>,
  degreeByNodeId: Map<string, number>,
): FileTreeBranchIds {
  const metadata = createBranchNode(
    filePath,
    fileNode,
    'metadata',
    'Metadata',
    'file-branch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const dependencies = createBranchNode(
    filePath,
    fileNode,
    'dependencies',
    'Dependencies',
    'file-branch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const globalScope = createBranchNode(
    filePath,
    fileNode,
    'global-scope',
    'Global Scope',
    'file-branch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const definitions = createBranchNode(
    filePath,
    fileNode,
    'definitions',
    'Definitions',
    'file-branch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );

  const docstrings = createBranchNode(
    filePath,
    metadata,
    'docstrings',
    'Docstrings',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const comments = createBranchNode(
    filePath,
    metadata,
    'comments',
    'Comments',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const imports = createBranchNode(
    filePath,
    dependencies,
    'imports',
    'Imports/Includes',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const includes = createBranchNode(
    filePath,
    dependencies,
    'includes',
    'Resolved Targets',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const constants = createBranchNode(
    filePath,
    globalScope,
    'constants',
    'Constants',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const variables = createBranchNode(
    filePath,
    globalScope,
    'variables',
    'Variables',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const locals = createBranchNode(
    filePath,
    definitions,
    'locals',
    'Local Variables',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const classes = createBranchNode(
    filePath,
    definitions,
    'classes',
    'Classes',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const functions = createBranchNode(
    filePath,
    definitions,
    'functions',
    'Functions',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const methods = createBranchNode(
    filePath,
    definitions,
    'methods',
    'Methods',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const interfaces = createBranchNode(
    filePath,
    definitions,
    'interfaces',
    'Interfaces',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const enums = createBranchNode(
    filePath,
    definitions,
    'enums',
    'Enums',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );
  const modules = createBranchNode(
    filePath,
    definitions,
    'modules',
    'Namespaces/Modules',
    'branch-subbranch',
    nodes,
    nodeById,
    edges,
    edgeKeys,
    degreeByNodeId,
  );

  return {
    metadata: metadata.id,
    dependencies: dependencies.id,
    globalScope: globalScope.id,
    definitions: definitions.id,
    docstrings: docstrings.id,
    comments: comments.id,
    imports: imports.id,
    includes: includes.id,
    constants: constants.id,
    variables: variables.id,
    locals: locals.id,
    classes: classes.id,
    functions: functions.id,
    methods: methods.id,
    interfaces: interfaces.id,
    enums: enums.id,
    modules: modules.id,
  };
}

function createBranchNode(
  filePath: string,
  parentNode: CodeGraphNode,
  branchKind: CodeGraphBranchKind,
  label: string,
  relationship: CodeGraphRelationship,
  nodes: CodeGraphNode[],
  nodeById: Map<string, CodeGraphNode>,
  edges: CodeGraphEdge[],
  edgeKeys: Set<string>,
  degreeByNodeId: Map<string, number>,
): CodeGraphNode {
  const nodeId = `branch::${filePath}::${branchKind}`;
  const existing = nodeById.get(nodeId);
  if (existing) {
    return existing;
  }

  const branchNode: CodeGraphNode = {
    id: nodeId,
    name: label,
    type: 'branch',
    branchKind,
    filePath,
    uriString: parentNode.uriString,
    line: parentNode.line,
    rangeStartLine: parentNode.rangeStartLine,
    rangeStartCharacter: parentNode.rangeStartCharacter,
    rangeEndLine: parentNode.rangeEndLine,
    rangeEndCharacter: parentNode.rangeEndCharacter,
    parentId: parentNode.id,
    treeLevel: (parentNode.treeLevel ?? 0) + 1,
    degree: 0,
  };

  addNode(nodes, nodeById, branchNode);
  addEdge(edges, edgeKeys, degreeByNodeId, parentNode.id, branchNode.id, relationship);
  return branchNode;
}

function addSyntheticLeafNode(
  nodes: CodeGraphNode[],
  nodeById: Map<string, CodeGraphNode>,
  parentBranchId: string,
  descriptor: {
    id: string;
    name: string;
    type: Extract<CodeGraphNodeType, 'dependency' | 'metadata'>;
    branchKind: CodeGraphBranchKind;
    filePath: string;
    uriString: string;
  },
  edges: CodeGraphEdge[],
  edgeKeys: Set<string>,
  degreeByNodeId: Map<string, number>,
): void {
  const parent = nodeById.get(parentBranchId);
  const syntheticNode: CodeGraphNode = {
    id: descriptor.id,
    name: descriptor.name,
    type: descriptor.type,
    branchKind: descriptor.branchKind,
    filePath: descriptor.filePath,
    uriString: descriptor.uriString,
    line: 1,
    rangeStartLine: 1,
    rangeStartCharacter: 0,
    rangeEndLine: 1,
    rangeEndCharacter: 1,
    parentId: parentBranchId,
    treeLevel: (parent?.treeLevel ?? 2) + 1,
    degree: 0,
  };

  addNode(nodes, nodeById, syntheticNode);
  addEdge(edges, edgeKeys, degreeByNodeId, parentBranchId, descriptor.id, 'branch-leaf');
}

function resolveBranchTargetForSymbol(
  symbol: GraphNode,
  fileSymbols: GraphNode[],
  branches: FileTreeBranchIds,
): string {
  switch (symbol.symbolKind) {
    case SYMBOL_KIND.Class:
      return branches.classes;
    case SYMBOL_KIND.Interface:
      return branches.interfaces;
    case SYMBOL_KIND.Enum:
      return branches.enums;
    case SYMBOL_KIND.Namespace:
    case SYMBOL_KIND.Module:
    case SYMBOL_KIND.TypeParameter:
      return branches.modules;
    case SYMBOL_KIND.Function:
      return branches.functions;
    case SYMBOL_KIND.Method:
    case SYMBOL_KIND.Constructor:
      return branches.methods;
    case SYMBOL_KIND.Constant:
      return isGlobalScopeSymbol(symbol, fileSymbols) ? branches.constants : branches.locals;
    case SYMBOL_KIND.Variable:
    case SYMBOL_KIND.Field:
    case SYMBOL_KIND.Property:
      return isGlobalScopeSymbol(symbol, fileSymbols) ? branches.variables : branches.locals;
    default:
      return branches.locals;
  }
}

function isGlobalScopeSymbol(symbol: GraphNode, fileSymbols: GraphNode[]): boolean {
  if (!isVariableLikeSymbolKind(symbol.symbolKind)) {
    return false;
  }

  for (const candidate of fileSymbols) {
    if (candidate.id === symbol.id) {
      continue;
    }

    if (!isContainerSymbolKind(candidate.symbolKind)) {
      continue;
    }

    if (isContainedWithin(candidate, symbol)) {
      return false;
    }
  }

  return true;
}

function isVariableLikeSymbolKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === SYMBOL_KIND.Variable ||
    kind === SYMBOL_KIND.Constant ||
    kind === SYMBOL_KIND.Field ||
    kind === SYMBOL_KIND.Property
  );
}

function isContainerSymbolKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === SYMBOL_KIND.Function ||
    kind === SYMBOL_KIND.Method ||
    kind === SYMBOL_KIND.Constructor ||
    kind === SYMBOL_KIND.Class ||
    kind === SYMBOL_KIND.Interface ||
    kind === SYMBOL_KIND.Enum ||
    kind === SYMBOL_KIND.Namespace ||
    kind === SYMBOL_KIND.Module ||
    kind === SYMBOL_KIND.TypeParameter
  );
}

function symbolKindLabel(kind: vscode.SymbolKind): string {
  const label = SYMBOL_KIND_LABELS[kind];
  return label ?? kind.toString();
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

function ensureFileNodeInfo(
  fileNodeByPath: Map<string, FileNodeInfo>,
  filePath: string,
  uriString: string,
): void {
  if (fileNodeByPath.has(filePath)) {
    const existing = fileNodeByPath.get(filePath);
    if (existing && existing.uriString.length === 0 && uriString.length > 0) {
      fileNodeByPath.set(filePath, { id: existing.id, uriString });
    }

    return;
  }

  fileNodeByPath.set(filePath, {
    id: `file::${filePath}`,
    uriString,
  });
}

async function openTargetInEditor(target: NodeNavigationTarget): Promise<void> {
  const vscodeApi = getVscodeApi();

  const uri = vscodeApi.Uri.parse(target.uriString);
  const document = await vscodeApi.workspace.openTextDocument(uri);
  const editor = await vscodeApi.window.showTextDocument(document, { preview: false });

  const start = new vscodeApi.Position(
    Math.max(0, target.rangeStartLine - 1),
    Math.max(0, target.rangeStartCharacter),
  );
  const end = new vscodeApi.Position(
    Math.max(0, target.rangeEndLine - 1),
    Math.max(0, target.rangeEndCharacter),
  );
  const range = new vscodeApi.Range(start, end);

  editor.selection = new vscodeApi.Selection(start, end);
  editor.revealRange(range, vscodeApi.TextEditorRevealType.InCenterIfOutsideViewport);
}
