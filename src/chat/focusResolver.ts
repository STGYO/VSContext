import * as vscode from 'vscode';

import { GraphNode, WorkspaceGraph } from '../graph/graphBuilder';
import { toWorkspaceRelativePath } from '../utils/workspaceScanner';

interface ResolveFocusOptions {
  readonly explicitNodeId?: string;
  readonly treeSelectionNodeId?: string;
  readonly prompt: string;
}

export function resolveFocusNode(graph: WorkspaceGraph, options: ResolveFocusOptions): GraphNode | undefined {
  if (options.explicitNodeId) {
    const explicit = graph.nodes.get(options.explicitNodeId);
    if (explicit) {
      return explicit;
    }
  }

  const editorMatch = resolveFocusFromActiveEditor(graph);
  if (editorMatch) {
    return editorMatch;
  }

  if (options.treeSelectionNodeId) {
    const selected = graph.nodes.get(options.treeSelectionNodeId);
    if (selected) {
      return selected;
    }
  }

  return resolveFocusFromPrompt(graph, options.prompt);
}

function resolveFocusFromActiveEditor(graph: WorkspaceGraph): GraphNode | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const filePath = toWorkspaceRelativePath(editor.document.uri);
  const fileNodeIds = graph.fileIndex.get(filePath) ?? [];
  const fileNodes = fileNodeIds
    .map((nodeId) => graph.nodes.get(nodeId))
    .filter((node): node is GraphNode => node !== undefined);

  if (fileNodes.length === 0) {
    return undefined;
  }

  const lineNumber = editor.selection.active.line + 1;
  return fileNodes
    .filter((node) => lineNumber >= node.rangeStartLine && lineNumber <= node.rangeEndLine)
    .sort((left, right) => {
      const leftSpan = left.rangeEndLine - left.rangeStartLine;
      const rightSpan = right.rangeEndLine - right.rangeStartLine;
      return leftSpan - rightSpan;
    })[0];
}

function resolveFocusFromPrompt(graph: WorkspaceGraph, prompt: string): GraphNode | undefined {
  const candidates = extractPromptCandidates(prompt);
  if (candidates.length === 0) {
    return undefined;
  }

  const activeFilePath = vscode.window.activeTextEditor
    ? toWorkspaceRelativePath(vscode.window.activeTextEditor.document.uri)
    : undefined;

  for (const candidate of candidates) {
    const exact = findBestSymbol(graph, candidate, activeFilePath, true);
    if (exact) {
      return exact;
    }
  }

  for (const candidate of candidates) {
    const partial = findBestSymbol(graph, candidate, activeFilePath, false);
    if (partial) {
      return partial;
    }
  }

  return undefined;
}

function extractPromptCandidates(prompt: string): string[] {
  const normalized = prompt.trim();
  if (normalized.length === 0) {
    return [];
  }

  const set = new Set<string>();
  const quotedPattern = /[`"']([A-Za-z_][\w.$:-]{1,})[`"']/g;
  let quotedMatch: RegExpExecArray | null;
  while ((quotedMatch = quotedPattern.exec(normalized)) !== null) {
    set.add(quotedMatch[1]);
  }

  const tokenPattern = /[A-Za-z_][\w.$:-]{2,}/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenPattern.exec(normalized)) !== null) {
    const token = tokenMatch[0];
    if (!STOP_WORDS.has(token.toLowerCase())) {
      set.add(token);
    }
  }

  return [...set].slice(0, 8);
}

function findBestSymbol(
  graph: WorkspaceGraph,
  candidate: string,
  activeFilePath: string | undefined,
  exact: boolean,
): GraphNode | undefined {
  const normalizedCandidate = candidate.toLowerCase();
  const matches = [...graph.nodes.values()].filter((node) => {
    const normalizedName = node.symbolName.toLowerCase();
    if (exact) {
      return normalizedName === normalizedCandidate;
    }

    return normalizedName.includes(normalizedCandidate);
  });

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((left, right) => {
    const leftInFile = activeFilePath && left.filePath === activeFilePath ? 0 : 1;
    const rightInFile = activeFilePath && right.filePath === activeFilePath ? 0 : 1;
    if (leftInFile !== rightInFile) {
      return leftInFile - rightInFile;
    }

    if (left.symbolName.length !== right.symbolName.length) {
      return left.symbolName.length - right.symbolName.length;
    }

    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }

    return left.lineNumber - right.lineNumber;
  });

  return matches[0];
}

const STOP_WORDS = new Set<string>([
  'what',
  'which',
  'where',
  'when',
  'who',
  'why',
  'how',
  'for',
  'with',
  'about',
  'show',
  'trace',
  'impact',
  'summary',
  'context',
  'from',
  'into',
  'this',
  'that',
  'these',
  'those',
  'give',
  'find',
  'the',
  'and',
  'or',
]);
