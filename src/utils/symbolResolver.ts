import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { toWorkspaceRelativePath } from './workspaceScanner';

export interface ResolveSymbolOptions {
  readonly isIndexing: boolean;
}

export async function resolveSelectedSymbol(
  graph: WorkspaceGraph,
  explicitNodeId?: string,
  options?: ResolveSymbolOptions,
): Promise<GraphNode | undefined> {
  if (explicitNodeId) {
    return graph.nodes.get(explicitNodeId);
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Open a file and place the cursor inside a function or method.');
    return undefined;
  }

  const filePath = toWorkspaceRelativePath(editor.document.uri);
  const fileNodeIds = graph.fileIndex.get(filePath) ?? [];
  const fileNodes = fileNodeIds
    .map((nodeId) => graph.nodes.get(nodeId))
    .filter((node): node is GraphNode => node !== undefined);

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

  const picked = await vscode.window.showQuickPick(
    fileNodes.map((node) => ({
      label: node.symbolName,
      description: `${node.filePath}:${node.lineNumber}`,
      nodeId: node.id,
    })),
    {
      placeHolder: 'Select a function or method to analyze',
    },
  );

  if (!picked) {
    return undefined;
  }

  return graph.nodes.get(picked.nodeId);
}

export async function openGraphNodeInEditor(node: GraphNode): Promise<void> {
  const uri = vscode.Uri.parse(node.uriString);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const start = new vscode.Position(
    Math.max(0, node.rangeStartLine - 1),
    Math.max(0, node.rangeStartCharacter),
  );
  const end = new vscode.Position(
    Math.max(0, node.rangeEndLine - 1),
    Math.max(0, node.rangeEndCharacter),
  );
  const range = new vscode.Range(start, end);

  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
