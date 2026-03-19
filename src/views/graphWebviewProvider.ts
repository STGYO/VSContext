import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import { Logger } from '../utils/logger';
import type { CodeGraphNode, CodeGraphPayload, NodeNavigationTarget } from './codeGraphView';

interface ReadyMessage {
  readonly type: 'ready';
}

interface OpenNodeMessage {
  readonly type: 'openNode';
  readonly target: NodeNavigationTarget;
}

interface RequestLoadMoreMessage {
  readonly type: 'requestLoadMore';
}

interface OpenNodeResultMessage {
  readonly type: 'openNodeResult';
  readonly status: 'success' | 'error';
  readonly message?: string;
}

interface GraphLoadState {
  readonly remainingCount: number;
  readonly canLoadMore: boolean;
  readonly wasTruncated: boolean;
}

interface GraphTotals {
  readonly totalNodeCount: number;
  readonly totalEdgeCount: number;
}

interface WebviewGraphSession {
  readonly sourcePayload: CodeGraphPayload;
  readonly totals: GraphTotals;
  visibleNodeIds: Set<string>;
  remainingNodes: CodeGraphNode[];
  wasTruncated: boolean;
}

type GraphMessage = ReadyMessage | OpenNodeMessage | RequestLoadMoreMessage;

const LARGE_GRAPH_THRESHOLD = 1400;
const INITIAL_NODE_LIMIT = 1200;
const LOAD_MORE_NODE_CHUNK = 600;

let graphPanel: vscode.WebviewPanel | undefined;
let graphPanelDisposables: vscode.Disposable[] = [];
let graphSession: WebviewGraphSession | undefined;

export async function openGraphWebviewPanel(
  context: vscode.ExtensionContext,
  payload: CodeGraphPayload,
  logger: Logger,
  onOpenNode: (target: NodeNavigationTarget) => Promise<void>,
): Promise<void> {
  graphSession = createWebviewGraphSession(payload);

  if (graphPanel) {
    graphPanel.reveal(vscode.ViewColumn.Beside, true);
    await postInitialGraphData(graphPanel.webview);
    return;
  }

  graphPanel = vscode.window.createWebviewPanel(
    'vscontext.codeGraph',
    'VSContext Code Graph',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        joinExtensionPath(context.extensionUri, 'webview'),
        joinExtensionPath(context.extensionUri, 'node_modules', 'cytoscape', 'dist'),
        joinExtensionPath(context.extensionUri, 'node_modules', 'cytoscape-dagre'),
        joinExtensionPath(context.extensionUri, 'node_modules', 'dagre', 'dist'),
      ],
    },
  );

  graphPanel.webview.html = await renderGraphHtml(graphPanel.webview, context.extensionUri);

  graphPanelDisposables.push(
    graphPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isGraphMessage(message)) {
        return;
      }

      if (!graphPanel) {
        return;
      }

      if (message.type === 'ready') {
        await postInitialGraphData(graphPanel.webview);
        return;
      }

      if (message.type === 'requestLoadMore') {
        await postNextGraphChunk(graphPanel.webview);
        return;
      }

      try {
        await onOpenNode(message.target);
        await postOpenNodeResult(graphPanel.webview, {
          type: 'openNodeResult',
          status: 'success',
        });
      } catch (error) {
        logger.error('Failed to open node from code graph panel.', error);
        await postOpenNodeResult(graphPanel.webview, {
          type: 'openNodeResult',
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to open selected symbol.',
        });
      }
    }),
    graphPanel.onDidDispose(() => {
      for (const disposable of graphPanelDisposables) {
        disposable.dispose();
      }

      graphPanelDisposables = [];
      graphSession = undefined;
      graphPanel = undefined;
    }),
  );
}

function createWebviewGraphSession(payload: CodeGraphPayload): WebviewGraphSession {
  const sortedNodes = [...payload.nodes].sort((left, right) => {
    const degreeDiff = (right.degree || 0) - (left.degree || 0);
    if (degreeDiff !== 0) {
      return degreeDiff;
    }

    return left.name.localeCompare(right.name);
  });

  const visibleNodeIds = new Set<string>();
  let remainingNodes: CodeGraphNode[] = [];
  let wasTruncated = false;

  if (sortedNodes.length <= LARGE_GRAPH_THRESHOLD) {
    for (const node of sortedNodes) {
      visibleNodeIds.add(node.id);
    }
  } else {
    const fileNodes = sortedNodes.filter((node) => node.type === 'file');
    const nonFileNodes = sortedNodes.filter((node) => node.type !== 'file');

    for (const fileNode of fileNodes) {
      visibleNodeIds.add(fileNode.id);
    }

    const symbolSlots = Math.max(0, INITIAL_NODE_LIMIT - fileNodes.length);
    const initiallyVisibleNodes = nonFileNodes.slice(0, symbolSlots);
    for (const node of initiallyVisibleNodes) {
      visibleNodeIds.add(node.id);
    }

    remainingNodes = nonFileNodes.slice(symbolSlots);
    wasTruncated = remainingNodes.length > 0;
  }

  return {
    sourcePayload: payload,
    totals: {
      totalNodeCount: payload.nodes.length,
      totalEdgeCount: payload.edges.length,
    },
    visibleNodeIds,
    remainingNodes,
    wasTruncated,
  };
}

async function postInitialGraphData(webview: vscode.Webview): Promise<void> {
  if (!graphSession) {
    return;
  }

  const visiblePayload = buildVisiblePayload(graphSession);
  await webview.postMessage({
    type: 'setGraphData',
    payload: visiblePayload,
    loadState: buildLoadState(graphSession),
    totals: graphSession.totals,
  });
}

async function postNextGraphChunk(webview: vscode.Webview): Promise<void> {
  if (!graphSession) {
    return;
  }

  const nextNodes = graphSession.remainingNodes.splice(0, LOAD_MORE_NODE_CHUNK);
  for (const node of nextNodes) {
    graphSession.visibleNodeIds.add(node.id);
  }

  const appendPayload = buildAppendPayload(graphSession, nextNodes);
  await webview.postMessage({
    type: 'appendGraphData',
    payload: appendPayload,
    loadState: buildLoadState(graphSession),
    totals: graphSession.totals,
    appendedNodeCount: nextNodes.length,
  });
}

async function postOpenNodeResult(webview: vscode.Webview, result: OpenNodeResultMessage): Promise<void> {
  await webview.postMessage(result);
}

function buildVisiblePayload(session: WebviewGraphSession): CodeGraphPayload {
  const nodes = session.sourcePayload.nodes.filter((node) => session.visibleNodeIds.has(node.id));
  const edges = session.sourcePayload.edges.filter((edge) => {
    return session.visibleNodeIds.has(edge.source) && session.visibleNodeIds.has(edge.target);
  });

  return {
    nodes,
    edges,
    meta: session.sourcePayload.meta,
  };
}

function buildAppendPayload(session: WebviewGraphSession, appendedNodes: CodeGraphNode[]): CodeGraphPayload {
  if (appendedNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      meta: session.sourcePayload.meta,
    };
  }

  const appendedNodeIds = new Set(appendedNodes.map((node) => node.id));
  const edges = session.sourcePayload.edges.filter((edge) => {
    if (!session.visibleNodeIds.has(edge.source) || !session.visibleNodeIds.has(edge.target)) {
      return false;
    }

    return appendedNodeIds.has(edge.source) || appendedNodeIds.has(edge.target);
  });

  return {
    nodes: appendedNodes,
    edges,
    meta: session.sourcePayload.meta,
  };
}

function buildLoadState(session: WebviewGraphSession): GraphLoadState {
  const remainingCount = session.remainingNodes.length;

  return {
    remainingCount,
    canLoadMore: remainingCount > 0,
    wasTruncated: session.wasTruncated,
  };
}

function isGraphMessage(message: unknown): message is GraphMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  if (candidate.type === 'ready') {
    return true;
  }

  if (candidate.type === 'requestLoadMore') {
    return true;
  }

  if (candidate.type !== 'openNode' || typeof candidate.target !== 'object' || candidate.target === null) {
    return false;
  }

  const target = candidate.target as Record<string, unknown>;
  return (
    typeof target.uriString === 'string'
    && typeof target.line === 'number'
    && typeof target.rangeStartLine === 'number'
    && typeof target.rangeStartCharacter === 'number'
    && typeof target.rangeEndLine === 'number'
    && typeof target.rangeEndCharacter === 'number'
  );
}

async function renderGraphHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const htmlUri = joinExtensionPath(extensionUri, 'webview', 'graph.html');
  const cssUri = webview.asWebviewUri(joinExtensionPath(extensionUri, 'webview', 'graph.css'));
  const scriptUri = webview.asWebviewUri(joinExtensionPath(extensionUri, 'webview', 'graph.js'));
  const cytoscapeUri = webview.asWebviewUri(
    joinExtensionPath(extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
  );
  const dagreUri = webview.asWebviewUri(
    joinExtensionPath(extensionUri, 'node_modules', 'dagre', 'dist', 'dagre.min.js'),
  );
  const cytoscapeDagreUri = webview.asWebviewUri(
    joinExtensionPath(extensionUri, 'node_modules', 'cytoscape-dagre', 'cytoscape-dagre.js'),
  );

  const nonce = createNonce();
  let template: string;

  try {
    template = await fs.readFile(htmlUri.fsPath, 'utf8');
  } catch {
    template = fallbackTemplate();
  }

  return template
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{styleUri}}', cssUri.toString())
    .replaceAll('{{scriptUri}}', scriptUri.toString())
    .replaceAll('{{cytoscapeUri}}', cytoscapeUri.toString())
    .replaceAll('{{dagreUri}}', dagreUri.toString())
    .replaceAll('{{cytoscapeDagreUri}}', cytoscapeDagreUri.toString())
    .replaceAll('{{htmlDir}}', path.dirname(htmlUri.fsPath));
}

function fallbackTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src {{cspSource}} data:; style-src {{cspSource}}; script-src 'nonce-{{nonce}}';" />
  <title>VSContext Code Graph</title>
  <link nonce="{{nonce}}" rel="stylesheet" href="{{styleUri}}" />
</head>
<body>
  <div id="app">
    <header class="toolbar">
      <div class="toolbar-left">
        <h2>Codebase Graph</h2>
        <p id="summary">Waiting for graph data...</p>
      </div>
      <div class="toolbar-right">
        <button
          id="menu-toggle"
          type="button"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-controls="overflow-menu"
          title="Graph controls"
        >
          ...
        </button>
        <button
          id="top-bars-toggle"
          type="button"
          aria-expanded="true"
          aria-controls="notice density-controls"
          title="Hide top bars"
          aria-label="Hide top bars"
        >
          &#9650;
        </button>
        <div id="overflow-menu" class="overflow-menu" role="menu" aria-label="Graph controls" hidden>
          <div class="menu-group" role="group" aria-label="Layout controls">
            <p class="menu-heading">Layout</p>
            <button id="view-toggle" type="button">View: Mind Map</button>
            <button id="direction-toggle" type="button">Direction: TB</button>
            <button id="collapse-all" type="button">Collapse Groups</button>
            <button id="expand-all" type="button">Expand Groups</button>
            <button id="fit-view" type="button">Fit</button>
            <button id="relayout" type="button">Relayout</button>
            <button id="load-more" type="button">Load More</button>
          </div>

          <div class="menu-group" role="group" aria-label="Visibility filters">
            <p class="menu-heading">Visibility</p>
            <button id="toggle-containment" type="button" data-active="false" title="Hide containment-only relationships">Hide Structural Edges</button>
            <button id="toggle-variables" type="button" data-active="false" title="Hide variable nodes">Hide Variables</button>
            <button id="toggle-smart-labels" type="button" data-active="true" title="Hide most labels when zoomed out">Smart Labels: On</button>
          </div>

          <div class="menu-group" role="group" aria-label="Edge type filters">
            <p class="menu-heading">Edge Types</p>
            <button id="toggle-edge-calls" type="button" data-active="true" title="Toggle calls edges">Calls: On</button>
            <button id="toggle-edge-implements" type="button" data-active="true" title="Toggle implements edges">Implements: On</button>
            <button id="toggle-edge-reads" type="button" data-active="true" title="Toggle reads edges">Reads: On</button>
            <button id="toggle-edge-writes" type="button" data-active="true" title="Toggle writes edges">Writes: On</button>
            <button id="toggle-edge-file-dependency" type="button" data-active="true" title="Toggle file dependency edges">File Deps: On</button>
            <button id="reset-filters" type="button" title="Reset all clarity controls">Reset</button>
          </div>
        </div>
      </div>
    </header>
    <div id="notice" aria-live="polite"></div>
    <section id="density-controls" aria-label="Graph clarity controls">
      <label for="graph-search">Search</label>
      <input id="graph-search" type="search" placeholder="Node or file name" spellcheck="false" />

      <label for="edge-budget">Edge Budget</label>
      <input id="edge-budget" type="range" min="1500" max="22000" step="500" value="22000" />
      <span id="edge-budget-value" aria-live="polite">22000</span>
    </section>
    <section id="graph-shell">
      <main id="graph" role="region" tabindex="0" aria-label="VSContext code graph canvas"></main>
      <div id="zoom-controls" aria-label="Graph zoom controls">
        <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
        <span id="zoom-level" aria-live="polite">100%</span>
        <button id="zoom-out" type="button" aria-label="Zoom out">-</button>
      </div>
      <aside id="legend" aria-label="Graph legend">
        <h3>Legend</h3>
        <ul>
          <li><span class="legend-swatch" data-node-type="file"></span>File Scope</li>
          <li><span class="legend-swatch" data-node-type="class"></span>Class Scope</li>
          <li><span class="legend-swatch" data-node-type="function"></span>Function</li>
          <li><span class="legend-swatch" data-node-type="method"></span>Method</li>
          <li><span class="legend-swatch" data-node-type="variable"></span>Variable</li>
        </ul>
        <p class="legend-help">Double-click a parent boundary to collapse or expand. Ctrl/Cmd+Click or Alt+Click opens code. Keyboard: arrows move focus, Enter opens, +/- zoom, F fit, V view mode, D direction, / search.</p>
      </aside>
      <div id="node-tooltip" role="tooltip" hidden></div>
    </section>
  </div>
  <script nonce="{{nonce}}" src="{{cytoscapeUri}}"></script>
  <script nonce="{{nonce}}" src="{{dagreUri}}"></script>
  <script nonce="{{nonce}}" src="{{cytoscapeDagreUri}}"></script>
  <script nonce="{{nonce}}" src="{{scriptUri}}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 24; index += 1) {
    const randomIndex = Math.floor(Math.random() * alphabet.length);
    nonce += alphabet[randomIndex];
  }

  return nonce;
}

function joinExtensionPath(baseUri: vscode.Uri, ...segments: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(baseUri.fsPath, ...segments));
}
