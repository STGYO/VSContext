import * as vscode from 'vscode';

import { ImpactAnalysisResult } from '../analysis/impactAnalysis';
import { Logger } from '../utils/logger';

export function openImpactPanel(
  result: ImpactAnalysisResult,
  logger: Logger,
  onOpenNode: (nodeId: string) => Promise<void>,
): void {
  const panel = vscode.window.createWebviewPanel(
    'vscontext.impactAnalysis',
    'Impact Analysis Panel',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = renderImpactHtml(panel.webview, result);

  const disposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isOpenNodeMessage(message)) {
      return;
    }

    try {
      await onOpenNode(message.nodeId);
    } catch (error) {
      logger.error('Failed to open node from impact panel.', error);
    }
  });

  panel.onDidDispose(() => {
    disposable.dispose();
  });
}

interface OpenNodeMessage {
  readonly type: 'openNode';
  readonly nodeId: string;
}

function isOpenNodeMessage(message: unknown): message is OpenNodeMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return candidate.type === 'openNode' && typeof candidate.nodeId === 'string';
}

function renderImpactHtml(webview: vscode.Webview, result: ImpactAnalysisResult): string {
  const nonce = createNonce();
  const rows = result.nodes
    .map((node) => {
      const depth = node.depth.toString();
      const location = `${escapeHtml(node.filePath)}:${node.lineNumber.toString()}`;
      return `<tr>
        <td>${depth}</td>
        <td><button class="link" data-node-id="${escapeHtml(node.nodeId)}">${escapeHtml(node.symbolName)}</button></td>
        <td>${location}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body { font-family: Segoe UI, sans-serif; margin: 16px; }
    h2 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #444; padding: 8px; text-align: left; }
    th { background: #252526; }
    .link { background: none; border: none; color: #4da3ff; cursor: pointer; padding: 0; font: inherit; }
  </style>
</head>
<body>
  <h2>Impact Analysis</h2>
  <p>Affected nodes: ${result.nodes.length.toString()} | Max depth: ${result.maxDepth.toString()}</p>
  <table>
    <thead>
      <tr>
        <th>Depth</th>
        <th>Function</th>
        <th>Location</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const buttons = document.querySelectorAll('[data-node-id]');
    for (const button of buttons) {
      button.addEventListener('click', () => {
        const nodeId = button.getAttribute('data-node-id');
        if (nodeId) {
          vscode.postMessage({ type: 'openNode', nodeId });
        }
      });
    }
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 24; i += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return text;
}

function escapeHtml(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
