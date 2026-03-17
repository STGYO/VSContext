/* global cytoscape acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const LARGE_GRAPH_THRESHOLD = 1400;
const INITIAL_NODE_LIMIT = 1200;
const LOAD_MORE_NODE_CHUNK = 600;
const MAX_VISIBLE_EDGES = 20000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP_FACTOR = 1.1;
const ZOOM_ANIMATION_MS = 180;

const NODE_STYLE = {
  file: { bg: '#0f766e', border: '#5eead4' },
  class: { bg: '#0284c7', border: '#7dd3fc' },
  function: { bg: '#4f46e5', border: '#a5b4fc' },
  method: { bg: '#7c3aed', border: '#c4b5fd' },
  variable: { bg: '#b45309', border: '#fcd34d' },
};

const state = {
  payload: undefined,
  cy: undefined,
  visibleNodeIds: new Set(),
  remainingNodes: [],
};

const elements = {
  graph: document.getElementById('graph'),
  summary: document.getElementById('summary'),
  notice: document.getElementById('notice'),
  fitView: document.getElementById('fit-view'),
  relayout: document.getElementById('relayout'),
  loadMore: document.getElementById('load-more'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomLevel: document.getElementById('zoom-level'),
  legendSwatches: document.querySelectorAll('.legend-swatch'),
};

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'setGraphData') {
    return;
  }

  applyGraphPayload(message.payload);
});

elements.fitView.addEventListener('click', () => {
  if (!state.cy) {
    return;
  }

  state.cy.fit(undefined, 50);
});

elements.relayout.addEventListener('click', () => {
  if (!state.cy) {
    return;
  }

  runLayout(true);
});

elements.loadMore.addEventListener('click', () => {
  if (!state.payload) {
    return;
  }

  const nextNodes = state.remainingNodes.splice(0, LOAD_MORE_NODE_CHUNK);
  for (const node of nextNodes) {
    state.visibleNodeIds.add(node.id);
  }

  renderVisibleGraph();
  updateLoadMoreButton();
  if (nextNodes.length > 0) {
    setNotice(`Loaded ${nextNodes.length} more nodes.`);
  }
});

elements.zoomIn.addEventListener('click', () => {
  if (!state.cy) {
    return;
  }

  applyZoomStep(1);
});

elements.zoomOut.addEventListener('click', () => {
  if (!state.cy) {
    return;
  }

  applyZoomStep(-1);
});

vscode.postMessage({ type: 'ready' });

function applyGraphPayload(payload) {
  if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    setNotice('Unable to render graph payload.');
    return;
  }

  if (typeof cytoscape !== 'function') {
    setNotice('Cytoscape failed to load.');
    return;
  }

  state.payload = payload;
  state.visibleNodeIds = new Set();
  state.remainingNodes = [];

  const nodeCount = payload.nodes.length;
  const edgeCount = payload.edges.length;
  const isLarge = nodeCount > LARGE_GRAPH_THRESHOLD;

  const sortedNodes = [...payload.nodes].sort((left, right) => {
    const degreeDiff = (right.degree || 0) - (left.degree || 0);
    if (degreeDiff !== 0) {
      return degreeDiff;
    }

    return left.name.localeCompare(right.name);
  });

  if (!isLarge) {
    for (const node of sortedNodes) {
      state.visibleNodeIds.add(node.id);
    }
    state.remainingNodes = [];
  } else {
    const fileNodes = sortedNodes.filter((node) => node.type === 'file');
    const nonFileNodes = sortedNodes.filter((node) => node.type !== 'file');

    for (const fileNode of fileNodes) {
      state.visibleNodeIds.add(fileNode.id);
    }

    const symbolSlots = Math.max(0, INITIAL_NODE_LIMIT - fileNodes.length);
    const initiallyVisible = nonFileNodes.slice(0, symbolSlots);
    for (const node of initiallyVisible) {
      state.visibleNodeIds.add(node.id);
    }

    state.remainingNodes = nonFileNodes.slice(symbolSlots);
    setNotice('Large graph detected. Rendering a prioritized subset first; use Load More to expand.');
  }

  if (!state.cy) {
    state.cy = createGraphInstance();
    wireInteractions(state.cy);
    syncLegendColors();
  }

  renderVisibleGraph();
  updateSummary(nodeCount, edgeCount);
  updateLoadMoreButton();
  updateZoomLevel(state.cy.zoom());
}

function createGraphInstance() {
  const cy = cytoscape({
    container: elements.graph,
    elements: [],
    wheelSensitivity: 0.34,
    selectionType: 'single',
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': 10,
          color: '#d4d4d4',
          'text-wrap': 'wrap',
          'text-max-width': 140,
          'background-color': '#4b5563',
          width: 26,
          height: 26,
          'border-width': 1,
          'border-color': '#9ca3af',
          'overlay-opacity': 0,
          'text-valign': 'center',
          'text-halign': 'center',
        },
      },
      {
        selector: 'node[type = "file"]',
        style: {
          shape: 'round-rectangle',
          'background-color': NODE_STYLE.file.bg,
          'border-color': NODE_STYLE.file.border,
          width: 56,
          height: 34,
          'font-size': 9,
          'text-max-width': 200,
          'text-valign': 'bottom',
          'text-margin-y': 18,
        },
      },
      {
        selector: 'node[type = "class"]',
        style: {
          'background-color': NODE_STYLE.class.bg,
          'border-color': NODE_STYLE.class.border,
        },
      },
      {
        selector: 'node[type = "function"]',
        style: {
          'background-color': NODE_STYLE.function.bg,
          'border-color': NODE_STYLE.function.border,
        },
      },
      {
        selector: 'node[type = "method"]',
        style: {
          'background-color': NODE_STYLE.method.bg,
          'border-color': NODE_STYLE.method.border,
        },
      },
      {
        selector: 'node[type = "variable"]',
        style: {
          'background-color': NODE_STYLE.variable.bg,
          'border-color': NODE_STYLE.variable.border,
          width: 22,
          height: 22,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1,
          'line-color': '#6b7280',
          'target-arrow-color': '#6b7280',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          opacity: 0.45,
        },
      },
      {
        selector: 'edge[relationship = "calls"]',
        style: {
          width: 1.5,
          'line-color': '#38bdf8',
          'target-arrow-color': '#38bdf8',
          opacity: 0.7,
        },
      },
      {
        selector: 'edge[relationship = "implements"]',
        style: {
          width: 1.8,
          'line-color': '#f59e0b',
          'target-arrow-color': '#f59e0b',
          opacity: 0.72,
        },
      },
      {
        selector: 'edge[relationship = "reads"]',
        style: {
          width: 1.35,
          'line-color': '#22c55e',
          'target-arrow-color': '#22c55e',
          opacity: 0.66,
        },
      },
      {
        selector: 'edge[relationship = "writes"]',
        style: {
          width: 1.7,
          'line-color': '#ef4444',
          'target-arrow-color': '#ef4444',
          opacity: 0.78,
        },
      },
      {
        selector: 'edge[relationship = "file-dependency"]',
        style: {
          width: 2,
          'line-color': '#14b8a6',
          'target-arrow-color': '#14b8a6',
          opacity: 0.6,
        },
      },
      {
        selector: '.hovered',
        style: {
          'border-width': 2,
          'border-color': '#f8fafc',
          opacity: 1,
        },
      },
      {
        selector: 'edge.hovered',
        style: {
          width: 2.5,
          opacity: 0.95,
        },
      },
      {
        selector: '.muted',
        style: {
          opacity: 0.15,
        },
      },
    ],
  });

  if (!cy.zoomingEnabled()) {
    cy.zoomingEnabled(true);
  }

  return cy;
}

function wireInteractions(cy) {
  cy.on('tap', 'node', (event) => {
    const node = event.target;
    const data = node.data();
    if (!data.uriString) {
      return;
    }

    vscode.postMessage({
      type: 'openNode',
      target: {
        uriString: data.uriString,
        line: data.line,
        rangeStartLine: data.rangeStartLine,
        rangeStartCharacter: data.rangeStartCharacter,
        rangeEndLine: data.rangeEndLine,
        rangeEndCharacter: data.rangeEndCharacter,
      },
    });
  });

  cy.on('mouseover', 'node', (event) => {
    const node = event.target;
    const related = node.closedNeighborhood();

    cy.elements().addClass('muted');
    related.removeClass('muted');
    node.addClass('hovered');
    node.connectedEdges().addClass('hovered');
  });

  cy.on('mouseout', 'node', () => {
    cy.elements().removeClass('muted hovered');
  });

  cy.on('zoom', () => {
    updateZoomLevel(cy.zoom());
  });
}

function renderVisibleGraph() {
  if (!state.payload || !state.cy) {
    return;
  }

  const visibleNodes = state.payload.nodes.filter((node) => state.visibleNodeIds.has(node.id));

  const visibleEdges = state.payload.edges.filter((edge) => {
    return state.visibleNodeIds.has(edge.source) && state.visibleNodeIds.has(edge.target);
  });

  const limitedEdges = prioritizeEdges(visibleEdges, MAX_VISIBLE_EDGES);
  if (visibleEdges.length > limitedEdges.length) {
    setNotice(`Rendered ${limitedEdges.length} of ${visibleEdges.length} visible edges for performance.`);
  }

  const cytoscapeElements = [
    ...visibleNodes.map((node) => ({
      data: {
        id: node.id,
        label: node.name,
        type: node.type,
        relationship: undefined,
        filePath: node.filePath,
        uriString: node.uriString,
        line: node.line,
        rangeStartLine: node.rangeStartLine,
        rangeStartCharacter: node.rangeStartCharacter,
        rangeEndLine: node.rangeEndLine,
        rangeEndCharacter: node.rangeEndCharacter,
      },
    })),
    ...limitedEdges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relationship: edge.relationship,
      },
    })),
  ];

  state.cy.batch(() => {
    state.cy.elements().remove();
    state.cy.add(cytoscapeElements);
  });

  runLayout(false);
}

function runLayout(forceFit) {
  if (!state.cy) {
    return;
  }

  const nodeCount = state.cy.nodes().length;
  const layout = state.cy.layout({
    name: nodeCount > 1600 ? 'concentric' : 'cose',
    animate: nodeCount < 1800,
    animationDuration: 240,
    randomize: true,
    fit: forceFit || nodeCount < 400,
    padding: 42,
    nodeRepulsion: 180000,
    idealEdgeLength: 90,
    edgeElasticity: 120,
    nestingFactor: 0.75,
    gravity: 0.28,
    numIter: nodeCount > 1200 ? 300 : 800,
  });

  layout.run();
}

function prioritizeEdges(edges, maxEdges) {
  if (edges.length <= maxEdges) {
    return edges;
  }

  const score = {
    calls: 5,
    implements: 5,
    writes: 5,
    reads: 4,
    'file-dependency': 4,
    'class-method': 4,
    'function-variable': 3,
    'method-variable': 3,
    'file-class': 2,
    'file-method': 2,
    'file-function': 2,
    'file-variable': 1,
  };

  return [...edges]
    .sort((left, right) => (score[right.relationship] || 0) - (score[left.relationship] || 0))
    .slice(0, maxEdges);
}

function updateSummary(nodeCount, edgeCount) {
  const visibleNodeCount = state.visibleNodeIds.size;
  const visibleEdgeCount = state.payload.edges.filter((edge) => {
    return state.visibleNodeIds.has(edge.source) && state.visibleNodeIds.has(edge.target);
  }).length;

  elements.summary.textContent = `Nodes ${visibleNodeCount}/${nodeCount} | Edges ${visibleEdgeCount}/${edgeCount}`;
}

function updateLoadMoreButton() {
  const remaining = state.remainingNodes.length;
  elements.loadMore.disabled = remaining === 0;
  elements.loadMore.textContent = remaining > 0 ? `Load More (${remaining})` : 'All Nodes Loaded';
}

function setNotice(message) {
  elements.notice.textContent = message;
}

function applyZoomStep(direction) {
  if (!state.cy) {
    return;
  }

  const current = state.cy.zoom();
  const factor = direction > 0 ? ZOOM_STEP_FACTOR : (1 / ZOOM_STEP_FACTOR);
  const target = clamp(current * factor, MIN_ZOOM, MAX_ZOOM);

  if (Math.abs(target - current) < 0.0001) {
    return;
  }

  animateZoomTo(target);
}

function animateZoomTo(targetZoom) {
  if (!state.cy) {
    return;
  }

  const cy = state.cy;
  const center = getViewportCenter();
  const startZoom = cy.zoom();
  const startTime = performance.now();

  const tick = (timestamp) => {
    const elapsed = timestamp - startTime;
    const t = Math.min(1, elapsed / ZOOM_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const nextZoom = startZoom + ((targetZoom - startZoom) * eased);

    cy.zoom({
      level: clamp(nextZoom, MIN_ZOOM, MAX_ZOOM),
      renderedPosition: center,
    });

    if (t < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

function getViewportCenter() {
  const rect = elements.graph.getBoundingClientRect();
  return {
    x: rect.width / 2,
    y: rect.height / 2,
  };
}

function updateZoomLevel(zoomValue) {
  elements.zoomLevel.textContent = `${Math.round(zoomValue * 100)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function syncLegendColors() {
  for (const swatch of elements.legendSwatches) {
    const type = swatch.getAttribute('data-node-type');
    const style = type ? NODE_STYLE[type] : undefined;
    if (!style) {
      continue;
    }

    swatch.style.backgroundColor = style.bg;
    swatch.style.borderColor = style.border;
  }
}
