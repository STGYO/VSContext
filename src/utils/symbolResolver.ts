import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { toWorkspaceRelativePath } from './workspaceScanner';

export interface ResolveSymbolOptions {
  readonly isIndexing: boolean;
}

interface SymbolQuickPickItem extends vscode.QuickPickItem {
  readonly nodeId: string;
}

const OPEN_EXPLORER_ACTION = 'Open VSContext Explorer';
const PICK_INDEXED_SYMBOL_ACTION = 'Choose Indexed Symbol';

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
    const action = await vscode.window.showWarningMessage(
      'Open a file and place the cursor inside a function or method.',
      OPEN_EXPLORER_ACTION,
      PICK_INDEXED_SYMBOL_ACTION,
    );

    if (action === OPEN_EXPLORER_ACTION) {
      await vscode.commands.executeCommand('workbench.view.extension.vscontextExplorer');
      return undefined;
    }

    if (action === PICK_INDEXED_SYMBOL_ACTION) {
      return promptForSymbolSelection(
        [...graph.nodes.values()],
        'Select a symbol from indexed workspace',
        true,
      );
    }

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

    const action = await vscode.window.showWarningMessage(
      'No function symbols were found in the current file.',
      PICK_INDEXED_SYMBOL_ACTION,
    );

    if (action === PICK_INDEXED_SYMBOL_ACTION) {
      return promptForSymbolSelection(
        [...graph.nodes.values()],
        'Select a symbol from indexed workspace',
        true,
      );
    }

    return undefined;
  }

  return promptForSymbolSelection(
    fileNodes,
    'Select a function or method to analyze',
    false,
  );
}

async function promptForSymbolSelection(
  nodes: GraphNode[],
  placeHolder: string,
  includeFilePathInDescription: boolean,
): Promise<GraphNode | undefined> {
  if (nodes.length === 0) {
    return undefined;
  }

  const sortedNodes = [...nodes].sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }

    if (left.lineNumber !== right.lineNumber) {
      return left.lineNumber - right.lineNumber;
    }

    return left.symbolName.localeCompare(right.symbolName);
  });

  const picked = await vscode.window.showQuickPick<SymbolQuickPickItem>(
    sortedNodes.map((node) => {
      const symbolName = node.symbolName && node.symbolName.trim().length > 0
        ? node.symbolName
        : 'Unknown Symbol';
      const locationLabel = includeFilePathInDescription
        ? `${node.filePath}:${node.lineNumber}`
        : `Line ${node.lineNumber}`;

      return {
        label: symbolName,
        description: locationLabel,
        detail: `${toSymbolKindLabel(node.symbolKind)} - lines ${node.rangeStartLine}-${node.rangeEndLine}`,
        nodeId: node.id,
      };
    }),
    {
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (!picked) {
    return undefined;
  }

  return nodes.find((node) => node.id === picked.nodeId);
}

function toSymbolKindLabel(kind: vscode.SymbolKind): string {
  const labels = vscode.SymbolKind as unknown as Record<number, string>;
  return labels[kind] ?? 'Symbol';
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
