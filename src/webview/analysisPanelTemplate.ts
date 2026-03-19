import * as vscode from 'vscode';

import type { TraversalEdge, TraversalNode } from '../analysis/executionTrace';
import { Logger } from '../utils/logger';

interface AnalysisPanelResult {
  readonly startNodeId: string;
  readonly maxDepth: number;
  readonly nodes: TraversalNode[];
  readonly edges: TraversalEdge[];
}

export interface AnalysisPanelOptions {
  readonly panelId: string;
  readonly panelTitle: string;
  readonly heading: string;
  readonly summaryPrefix: string;
  readonly graphAriaLabel: string;
  readonly emptyGraphMessage: string;
}

interface OpenNodeMessage {
  readonly type: 'openNode';
  readonly nodeId: string;
}

export function openAnalysisPanel(
  options: AnalysisPanelOptions,
  result: AnalysisPanelResult,
  logger: Logger,
  onOpenNode: (nodeId: string) => Promise<void>,
): void {
  const panel = vscode.window.createWebviewPanel(
    options.panelId,
    options.panelTitle,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = renderAnalysisHtml(panel.webview, options, result);

  const disposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isOpenNodeMessage(message)) {
      return;
    }

    try {
      await onOpenNode(message.nodeId);
      await panel.webview.postMessage({
        type: 'openNodeResult',
        status: 'success',
        nodeId: message.nodeId,
      });
    } catch (error) {
      logger.error(`Failed to open node from ${options.panelId} panel.`, error);
      await panel.webview.postMessage({
        type: 'openNodeResult',
        status: 'error',
        nodeId: message.nodeId,
        message: error instanceof Error ? error.message : 'Unable to open selected symbol.',
      });
    }
  });

  panel.onDidDispose(() => {
    disposable.dispose();
  });
}

function isOpenNodeMessage(message: unknown): message is OpenNodeMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return candidate.type === 'openNode' && typeof candidate.nodeId === 'string';
}

function renderAnalysisHtml(webview: vscode.Webview, options: AnalysisPanelOptions, result: AnalysisPanelResult): string {
  const nonce = createNonce();
  const payload = JSON.stringify({
    nodes: result.nodes,
    edges: result.edges,
    startNodeId: result.startNodeId,
    maxDepth: result.maxDepth,
    heading: options.heading,
    summaryPrefix: options.summaryPrefix,
    emptyGraphMessage: options.emptyGraphMessage,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: grid;
      grid-template-rows: auto auto auto auto auto 1fr;
      gap: 10px;
      height: calc(100vh - 32px);
      box-sizing: border-box;
    }
    h2 {
      margin: 0;
      font-size: 18px;
    }
    .summary {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .state-line {
      min-height: 20px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, #000 12%);
      color: var(--vscode-descriptionForeground);
    }
    .state-line[data-tone='success'] {
      color: var(--vscode-testing-iconPassed, #22c55e);
    }
    .state-line[data-tone='error'] {
      color: var(--vscode-testing-iconFailed, #ef4444);
    }
    .legend {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend-line {
      width: 16px;
      height: 0;
      border-top-width: 2px;
      border-top-style: solid;
    }
    .legend-line.calls {
      border-top-color: #38bdf8;
      border-top-style: solid;
    }
    .legend-line.implements {
      border-top-color: #f59e0b;
      border-top-style: dotted;
    }
    .legend-line.reads {
      border-top-color: #22c55e;
      border-top-style: dashed;
    }
    .legend-line.writes {
      border-top-color: #ef4444;
      border-top-style: solid;
      border-top-width: 3px;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .controls label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .controls input {
      min-width: 220px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      font: inherit;
      padding: 6px 8px;
    }
    .controls button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 6px;
      font: inherit;
      padding: 6px 8px;
      cursor: pointer;
    }
    .controls button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .controls button:focus-visible,
    .controls input:focus-visible,
    .sort-button:focus-visible,
    .row-link:focus-visible,
    .graph-node:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .graph-shell {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, #000 12%);
      overflow: auto;
      max-height: 44vh;
      min-height: 150px;
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
      stroke-dasharray: none;
    }
    .edge.edge-implements {
      stroke: #f59e0b;
      stroke-dasharray: 2 2;
    }
    .edge.edge-reads {
      stroke: #22c55e;
      stroke-dasharray: 4 2;
    }
    .edge.edge-writes {
      stroke: #ef4444;
      stroke-width: 2;
    }
    .graph-node {
      cursor: pointer;
    }
    .graph-node rect {
      fill: color-mix(in srgb, var(--vscode-button-secondaryBackground) 72%, var(--vscode-editor-background) 28%);
      stroke: color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
      stroke-width: 1;
      rx: 7;
      ry: 7;
    }
    .graph-node.start rect {
      stroke: var(--vscode-button-background);
      stroke-width: 2;
    }
    .graph-node.selected rect {
      stroke: var(--vscode-focusBorder);
      stroke-width: 2.2;
    }
    .graph-node text {
      fill: var(--vscode-foreground);
      font-size: 12px;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .section-title {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--vscode-panel-border);
      table-layout: fixed;
    }
    caption {
      caption-side: top;
      text-align: left;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0 8px;
    }
    thead {
      position: sticky;
      top: 0;
      z-index: 1;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
      font-size: 12px;
      word-wrap: break-word;
    }
    th {
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, #000 20%);
    }
    .sort-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }
    .sort-indicator {
      display: inline-block;
      min-width: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .row-link {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 0;
      text-align: left;
      font: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    tbody tr.selected-row {
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 40%, transparent);
    }
    .empty {
      margin: 0;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <header>
    <h2>${escapeHtml(options.heading)}</h2>
    <p class="summary" id="summary"></p>
  </header>
  <div id="state-line" class="state-line" role="status" aria-live="polite" data-tone="info">Preparing panel...</div>
  <div class="legend" aria-label="Edge type legend">
    <span class="legend-item"><span class="legend-line calls"></span>Calls</span>
    <span class="legend-item"><span class="legend-line implements"></span>Implements</span>
    <span class="legend-item"><span class="legend-line reads"></span>Reads</span>
    <span class="legend-item"><span class="legend-line writes"></span>Writes</span>
  </div>
  <section class="controls" aria-label="Node details filter controls">
    <label for="table-filter">Filter nodes</label>
    <input id="table-filter" type="search" placeholder="Symbol or file" spellcheck="false" />
    <button id="clear-filter" type="button">Clear</button>
  </section>
  <div class="graph-shell" id="graph-shell">
    <svg id="analysis-graph" aria-label="${escapeHtml(options.graphAriaLabel)}"></svg>
  </div>
  <h3 class="section-title">Node Details</h3>
  <table aria-label="Traversal nodes table">
    <caption id="table-caption"></caption>
    <thead>
      <tr>
        <th scope="col"><button class="sort-button" data-sort-key="depth" type="button">Depth <span class="sort-indicator" data-sort-indicator="depth"></span></button></th>
        <th scope="col"><button class="sort-button" data-sort-key="symbolName" type="button">Function <span class="sort-indicator" data-sort-indicator="symbolName"></span></button></th>
        <th scope="col"><button class="sort-button" data-sort-key="filePath" type="button">Location <span class="sort-indicator" data-sort-indicator="filePath"></span></button></th>
      </tr>
    </thead>
    <tbody id="details-body"></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const graphData = ${payload};

    const nodeWidth = 230;
    const nodeHeight = 32;
    const horizontalGap = 70;
    const verticalGap = 14;
    const padding = 24;
    const ns = 'http://www.w3.org/2000/svg';

    const state = {
      selectedNodeId: graphData.startNodeId || '',
      filterQuery: '',
      sortKey: 'depth',
      sortDirection: 'asc',
    };

    const nodesById = new Map((graphData.nodes || []).map((node) => [node.nodeId, node]));
    const elements = {
      summary: document.getElementById('summary'),
      stateLine: document.getElementById('state-line'),
      filterInput: document.getElementById('table-filter'),
      clearFilter: document.getElementById('clear-filter'),
      graph: document.getElementById('analysis-graph'),
      graphShell: document.getElementById('graph-shell'),
      tableBody: document.getElementById('details-body'),
      tableCaption: document.getElementById('table-caption'),
      sortButtons: document.querySelectorAll('.sort-button'),
      sortIndicators: document.querySelectorAll('[data-sort-indicator]'),
    };

    function setStateLine(message, tone = 'info') {
      if (!elements.stateLine) {
        return;
      }

      elements.stateLine.textContent = message;
      elements.stateLine.dataset.tone = tone;
    }

    function truncateLabel(label) {
      const text = typeof label === 'string' ? label : '';
      const max = 28;
      return text.length > max ? text.slice(0, max - 3) + '...' : text;
    }

    function normalize(value) {
      return String(value || '').toLowerCase();
    }

    function getVisibleNodes() {
      const query = normalize(state.filterQuery).trim();
      const allNodes = graphData.nodes || [];
      if (!query) {
        return allNodes;
      }

      return allNodes.filter((node) => {
        return normalize(node.symbolName).includes(query)
          || normalize(node.filePath).includes(query)
          || normalize(node.lineNumber).includes(query)
          || normalize(node.depth).includes(query);
      });
    }

    function compareNodes(left, right) {
      const key = state.sortKey;
      let delta = 0;

      if (key === 'depth') {
        delta = Number(left.depth || 0) - Number(right.depth || 0);
      } else if (key === 'symbolName') {
        delta = String(left.symbolName || '').localeCompare(String(right.symbolName || ''));
      } else {
        const leftLocation = String(left.filePath || '') + ':' + String(Number(left.lineNumber || 0));
        const rightLocation = String(right.filePath || '') + ':' + String(Number(right.lineNumber || 0));
        delta = leftLocation.localeCompare(rightLocation);
      }

      if (delta === 0) {
        delta = String(left.nodeId || '').localeCompare(String(right.nodeId || ''));
      }

      return state.sortDirection === 'asc' ? delta : -delta;
    }

    function getSortedNodes(nodes) {
      return [...nodes].sort(compareNodes);
    }

    function updateSummary(visibleNodeCount) {
      if (!elements.summary) {
        return;
      }

      const totalNodes = (graphData.nodes || []).length;
      elements.summary.textContent = String(graphData.summaryPrefix || 'Nodes')
        + ': '
        + String(totalNodes)
        + ' | Max depth: '
        + String(Number(graphData.maxDepth || 0))
        + ' | Visible: '
        + String(visibleNodeCount);
    }

    function updateSortIndicators() {
      for (const indicator of elements.sortIndicators) {
        const key = indicator.getAttribute('data-sort-indicator');
        if (!key) {
          continue;
        }

        indicator.textContent = key === state.sortKey
          ? (state.sortDirection === 'asc' ? '^' : 'v')
          : '';
      }

      for (const button of elements.sortButtons) {
        const key = button.getAttribute('data-sort-key');
        if (!key) {
          continue;
        }

        const isActive = key === state.sortKey;
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        if (isActive) {
          button.setAttribute('aria-label', 'Sorted by ' + key + ' (' + state.sortDirection + ')');
        } else {
          button.setAttribute('aria-label', 'Sort by ' + key);
        }
      }
    }

    function requestOpenNode(nodeId) {
      if (!nodeId) {
        return;
      }

      state.selectedNodeId = nodeId;
      renderTable();
      renderGraph();
      setStateLine('Opening selected symbol...', 'info');
      vscode.postMessage({ type: 'openNode', nodeId });
    }

    function appendSvgNode(parent, name, attrs) {
      const element = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, String(value));
      }
      parent.appendChild(element);
      return element;
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
        nodesAtDepth.sort((a, b) => String(a.symbolName || '').localeCompare(String(b.symbolName || '')));
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

    function renderGraph() {
      if (!elements.graph || !elements.graphShell) {
        return;
      }

      const visibleNodes = getSortedNodes(getVisibleNodes());
      const visibleNodeIds = new Set(visibleNodes.map((node) => node.nodeId));
      const visibleEdges = (graphData.edges || []).filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));

      if (visibleNodes.length === 0) {
        const paragraph = document.createElement('p');
        paragraph.className = 'empty';
        paragraph.textContent = state.filterQuery.trim().length > 0
          ? 'No nodes match the current filter.'
          : graphData.emptyGraphMessage;
        elements.graphShell.replaceChildren(paragraph);
        return;
      }

      if (!elements.graphShell.contains(elements.graph)) {
        elements.graphShell.replaceChildren(elements.graph);
      }

      elements.graph.replaceChildren();

      const { positions, width, height } = buildLayout(visibleNodes);
      elements.graph.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      elements.graph.setAttribute('width', String(width));
      elements.graph.setAttribute('height', String(height));

      const defs = appendSvgNode(elements.graph, 'defs', {});
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

      const edgeLayer = appendSvgNode(elements.graph, 'g', {});
      for (const edge of visibleEdges) {
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

      const nodeLayer = appendSvgNode(elements.graph, 'g', {});
      for (const [nodeId, position] of positions) {
        const isStart = nodeId === graphData.startNodeId;
        const isSelected = nodeId === state.selectedNodeId;
        const classes = ['graph-node'];
        if (isStart) {
          classes.push('start');
        }
        if (isSelected) {
          classes.push('selected');
        }

        const group = appendSvgNode(nodeLayer, 'g', {
          class: classes.join(' '),
          transform: 'translate(' + position.x + ' ' + position.y + ')',
          'data-node-id': nodeId,
          role: 'button',
          tabindex: '0',
          'aria-label': 'Open ' + String(position.node.symbolName || 'symbol'),
        });

        appendSvgNode(group, 'rect', {
          width: nodeWidth,
          height: nodeHeight,
        });

        appendSvgNode(group, 'text', {
          x: 10,
          y: nodeHeight / 2,
        }).textContent = truncateLabel(position.node.symbolName || 'Unknown Symbol');

        const title = appendSvgNode(group, 'title', {});
        title.textContent = String(position.node.symbolName || 'Unknown Symbol') + ' (' + String(position.node.filePath || '') + ':' + String(position.node.lineNumber || '-') + ')';

        group.addEventListener('click', () => {
          requestOpenNode(nodeId);
        });

        group.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }

          event.preventDefault();
          requestOpenNode(nodeId);
        });
      }
    }

    function renderTable() {
      if (!elements.tableBody || !elements.tableCaption) {
        return;
      }

      const visibleNodes = getSortedNodes(getVisibleNodes());
      updateSummary(visibleNodes.length);
      elements.tableCaption.textContent = 'Showing '
        + String(visibleNodes.length)
        + ' of '
        + String((graphData.nodes || []).length)
        + ' nodes.';

      elements.tableBody.replaceChildren();
      if (visibleNodes.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 3;
        cell.className = 'empty';
        cell.textContent = state.filterQuery.trim().length > 0
          ? 'No nodes match the current filter.'
          : graphData.emptyGraphMessage;
        row.appendChild(cell);
        elements.tableBody.appendChild(row);
        return;
      }

      for (const node of visibleNodes) {
        const row = document.createElement('tr');
        if (node.nodeId === state.selectedNodeId) {
          row.classList.add('selected-row');
        }

        const depthCell = document.createElement('td');
        depthCell.textContent = String(node.depth);

        const symbolCell = document.createElement('td');
        const button = document.createElement('button');
        button.className = 'row-link';
        button.type = 'button';
        button.textContent = String(node.symbolName || 'Unknown Symbol');
        button.setAttribute('data-node-id', String(node.nodeId));
        button.setAttribute('aria-label', 'Open ' + String(node.symbolName || 'symbol'));
        button.addEventListener('click', () => {
          requestOpenNode(node.nodeId);
        });
        symbolCell.appendChild(button);

        const locationCell = document.createElement('td');
        locationCell.textContent = String(node.filePath || '') + ':' + String(node.lineNumber || '-');

        row.appendChild(depthCell);
        row.appendChild(symbolCell);
        row.appendChild(locationCell);
        elements.tableBody.appendChild(row);
      }
    }

    for (const sortButton of elements.sortButtons) {
      sortButton.addEventListener('click', () => {
        const key = sortButton.getAttribute('data-sort-key');
        if (!key) {
          return;
        }

        if (state.sortKey === key) {
          state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDirection = 'asc';
        }

        updateSortIndicators();
        renderTable();
        renderGraph();
      });
    }

    if (elements.filterInput) {
      elements.filterInput.addEventListener('input', () => {
        state.filterQuery = elements.filterInput.value || '';
        renderTable();
        renderGraph();
        const filterText = state.filterQuery.trim();
        if (filterText.length > 0) {
          setStateLine('Filter active: "' + filterText + '"', 'info');
        } else {
          setStateLine('Ready. Use Enter or Space on graph nodes to open source.', 'info');
        }
      });
    }

    if (elements.clearFilter) {
      elements.clearFilter.addEventListener('click', () => {
        state.filterQuery = '';
        if (elements.filterInput) {
          elements.filterInput.value = '';
        }
        renderTable();
        renderGraph();
        setStateLine('Filters cleared.', 'success');
      });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'openNodeResult') {
        return;
      }

      if (message.status === 'success') {
        setStateLine('Opened symbol in editor.', 'success');
      } else {
        setStateLine(message.message || 'Unable to open selected symbol.', 'error');
      }
    });

    updateSortIndicators();
    renderTable();
    renderGraph();

    if ((graphData.nodes || []).length === 0) {
      setStateLine('No results to display for this analysis.', 'error');
    } else {
      setStateLine('Ready. Use Enter or Space on graph nodes to open source.', 'info');
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