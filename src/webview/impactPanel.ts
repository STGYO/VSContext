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
  const graphPayload = JSON.stringify({
    nodes: result.nodes,
    edges: result.edges,
    startNodeId: result.startNodeId,
  });
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
    body {
      margin: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h2 {
      margin-top: 0;
      margin-bottom: 8px;
    }
    .summary {
      margin: 0 0 12px;
      color: var(--vscode-descriptionForeground);
    }
    .graph-shell {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, #000 12%);
      overflow: auto;
      max-height: 58vh;
      margin-bottom: 16px;
    }
    svg {
      display: block;
      min-width: 100%;
    }
    .edge {
      stroke: color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
      stroke-width: 1.6;
      fill: none;
      marker-end: url(#arrow);
    }
    .edge.edge-calls {
      stroke: #38bdf8;
    }
    .edge.edge-implements {
      stroke: #f59e0b;
    }
    .edge.edge-reads {
      stroke: #22c55e;
      stroke-dasharray: 4 2;
    }
    .edge.edge-writes {
      stroke: #ef4444;
      stroke-width: 2;
    }
    .node {
      cursor: pointer;
    }
    .node rect {
      fill: color-mix(in srgb, var(--vscode-button-secondaryBackground) 72%, var(--vscode-editor-background) 28%);
      stroke: color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
      stroke-width: 1;
      rx: 7;
      ry: 7;
    }
    .node.start rect {
      stroke: var(--vscode-button-background);
      stroke-width: 2;
    }
    .node text {
      fill: var(--vscode-foreground);
      font-size: 12px;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .section-title {
      margin: 0 0 8px;
      font-size: 12px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--vscode-panel-border);
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, #000 20%);
    }
    .link {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 0;
      text-align: left;
      font: inherit;
    }
    .empty {
      margin: 0;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h2>Impact Analysis</h2>
  <p class="summary">Affected nodes: ${result.nodes.length.toString()} | Max depth: ${result.maxDepth.toString()}</p>
  <div class="graph-shell">
    <svg id="impact-graph" aria-label="Impact analysis graph"></svg>
  </div>
  <h3 class="section-title">Node Details</h3>
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
    const graphData = ${graphPayload};

    const nodeWidth = 230;
    const nodeHeight = 32;
    const horizontalGap = 70;
    const verticalGap = 14;
    const padding = 24;
    const ns = 'http://www.w3.org/2000/svg';

    function truncateLabel(label) {
      const max = 28;
      return label.length > max ? label.slice(0, max - 1) + '…' : label;
    }

    function buildLayout(nodes) {
      const groups = new Map();
      for (const node of nodes) {
        const depth = Number.isFinite(node.depth) ? node.depth : 0;
        if (!groups.has(depth)) {
          groups.set(depth, []);
        }
        groups.get(depth).push(node);
      }

      const sortedDepths = Array.from(groups.keys()).sort((a, b) => a - b);
      const positions = new Map();
      let maxColumnHeight = 1;

      for (const depth of sortedDepths) {
        const nodesAtDepth = groups.get(depth);
        nodesAtDepth.sort((a, b) => a.symbolName.localeCompare(b.symbolName));
        maxColumnHeight = Math.max(maxColumnHeight, nodesAtDepth.length);

        for (let index = 0; index < nodesAtDepth.length; index += 1) {
          const node = nodesAtDepth[index];
          const x = padding + depth * (nodeWidth + horizontalGap);
          const y = padding + index * (nodeHeight + verticalGap);
          positions.set(node.nodeId, { x, y, node });
        }
      }

      const maxDepth = sortedDepths.length > 0 ? sortedDepths[sortedDepths.length - 1] : 0;
      const width = padding * 2 + (maxDepth + 1) * nodeWidth + maxDepth * horizontalGap;
      const height = padding * 2 + maxColumnHeight * nodeHeight + (maxColumnHeight - 1) * verticalGap;

      return { positions, width: Math.max(width, 760), height: Math.max(height, 180) };
    }

    function appendSvgNode(parent, name, attrs) {
      const element = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, String(value));
      }
      parent.appendChild(element);
      return element;
    }

    function renderGraph() {
      const svg = document.getElementById('impact-graph');
      if (!svg) {
        return;
      }

      if (!graphData.nodes || graphData.nodes.length === 0) {
        const paragraph = document.createElement('p');
        paragraph.className = 'empty';
        paragraph.textContent = 'No nodes available for this impact analysis.';
        svg.parentElement.replaceChildren(paragraph);
        return;
      }

      const { positions, width, height } = buildLayout(graphData.nodes);
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));

      const defs = appendSvgNode(svg, 'defs', {});
      const marker = appendSvgNode(defs, 'marker', {
        id: 'arrow',
        markerWidth: 8,
        markerHeight: 8,
        refX: 7,
        refY: 3,
        orient: 'auto',
      });
      appendSvgNode(marker, 'path', {
        d: 'M0,0 L7,3 L0,6 z',
        fill: 'currentColor',
      });

      const edgeLayer = appendSvgNode(svg, 'g', {});
      for (const edge of graphData.edges || []) {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) {
          continue;
        }

        const x1 = from.x + nodeWidth;
        const y1 = from.y + nodeHeight / 2;
        const x2 = to.x;
        const y2 = to.y + nodeHeight / 2;
        const control = Math.max(24, (x2 - x1) / 2);

        const edgeType = ['calls', 'implements', 'reads', 'writes'].includes(edge.edgeType)
          ? edge.edgeType
          : 'calls';

        const path = appendSvgNode(edgeLayer, 'path', {
          class: 'edge edge-' + edgeType,
          d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + control) + ' ' + y1 + ', ' + (x2 - control) + ' ' + y2 + ', ' + x2 + ' ' + y2,
        });

        const edgeTitle = appendSvgNode(path, 'title', {});
        edgeTitle.textContent = edgeType;
      }

      const nodeLayer = appendSvgNode(svg, 'g', {});
      for (const [nodeId, position] of positions) {
        const isStart = nodeId === graphData.startNodeId;
        const group = appendSvgNode(nodeLayer, 'g', {
          class: isStart ? 'node start' : 'node',
          transform: 'translate(' + position.x + ' ' + position.y + ')',
          'data-node-id': nodeId,
          role: 'button',
        });

        appendSvgNode(group, 'rect', {
          width: nodeWidth,
          height: nodeHeight,
        });

        appendSvgNode(group, 'text', {
          x: 10,
          y: nodeHeight / 2,
        }).textContent = truncateLabel(position.node.symbolName);

        const title = appendSvgNode(group, 'title', {});
        title.textContent = position.node.symbolName + ' (' + position.node.filePath + ':' + position.node.lineNumber + ')';

        group.addEventListener('click', () => {
          vscode.postMessage({ type: 'openNode', nodeId });
        });
      }
    }

    renderGraph();

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
