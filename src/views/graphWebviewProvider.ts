import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import { Logger } from '../utils/logger';
import type { CodeGraphPayload, NodeNavigationTarget } from './codeGraphView';

interface ReadyMessage {
  readonly type: 'ready';
}

interface OpenNodeMessage {
  readonly type: 'openNode';
  readonly target: NodeNavigationTarget;
}

type GraphMessage = ReadyMessage | OpenNodeMessage;

let graphPanel: vscode.WebviewPanel | undefined;
let graphPanelDisposables: vscode.Disposable[] = [];

export async function openGraphWebviewPanel(
  context: vscode.ExtensionContext,
  payload: CodeGraphPayload,
  logger: Logger,
  onOpenNode: (target: NodeNavigationTarget) => Promise<void>,
): Promise<void> {
  if (graphPanel) {
    graphPanel.reveal(vscode.ViewColumn.Beside, true);
    void graphPanel.webview.postMessage({
      type: 'setGraphData',
      payload,
    });
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
      ],
    },
  );

  graphPanel.webview.html = await renderGraphHtml(graphPanel.webview, context.extensionUri);

  graphPanelDisposables.push(
    graphPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isGraphMessage(message)) {
        return;
      }

      if (message.type === 'ready') {
        void graphPanel?.webview.postMessage({
          type: 'setGraphData',
          payload,
        });
        return;
      }

      try {
        await onOpenNode(message.target);
      } catch (error) {
        logger.error('Failed to open node from code graph panel.', error);
      }
    }),
    graphPanel.onDidDispose(() => {
      for (const disposable of graphPanelDisposables) {
        disposable.dispose();
      }

      graphPanelDisposables = [];
      graphPanel = undefined;
    }),
  );
}

function isGraphMessage(message: unknown): message is GraphMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  if (candidate.type === 'ready') {
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
        <button id="fit-view" type="button">Fit</button>
        <button id="relayout" type="button">Relayout</button>
        <button id="load-more" type="button">Load More</button>
      </div>
    </header>
    <div id="notice" aria-live="polite"></div>
    <section id="graph-shell">
      <main id="graph" role="application" aria-label="VSContext code graph"></main>
      <div id="zoom-controls" aria-label="Graph zoom controls">
        <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
        <span id="zoom-level" aria-live="polite">100%</span>
        <button id="zoom-out" type="button" aria-label="Zoom out">-</button>
      </div>
      <aside id="legend" aria-label="Graph legend">
        <h3>Legend</h3>
        <ul>
          <li><span class="legend-swatch" data-node-type="file"></span>File</li>
          <li><span class="legend-swatch" data-node-type="class"></span>Class</li>
          <li><span class="legend-swatch" data-node-type="function"></span>Function</li>
          <li><span class="legend-swatch" data-node-type="method"></span>Method</li>
          <li><span class="legend-swatch" data-node-type="variable"></span>Variable</li>
        </ul>
      </aside>
    </section>
  </div>
  <script nonce="{{nonce}}" src="{{cytoscapeUri}}"></script>
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
