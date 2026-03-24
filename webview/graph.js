/* global cytoscape cytoscapeDagre acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const MAX_VISIBLE_EDGES = 22000;
const MIN_EDGE_BUDGET = 1500;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_LEVEL_STOPS = [
	0.1,
	0.125,
	0.15,
	0.2,
	0.25,
	0.33,
	0.5,
	0.67,
	0.75,
	0.9,
	1,
	1.1,
	1.25,
	1.5,
	1.75,
	2,
	2.5,
	3,
	4,
	5,
];
const WHEEL_ZOOM_SPEED = 0.0024;
const WHEEL_ZOOM_MAX_DELTA = 900;
const WHEEL_LINE_HEIGHT_PX = 16;
const SEARCH_INPUT_DEBOUNCE_MS = 150;
const LOW_DETAIL_ZOOM_THRESHOLD = 0.52;
const LOW_DETAIL_NODE_THRESHOLD = 180;
const LOW_DETAIL_EDGE_THRESHOLD = 420;
const LARGE_GRAPH_NODE_THRESHOLD = 1200;
const LARGE_GRAPH_EDGE_THRESHOLD = 4200;
const LARGE_GRAPH_INITIAL_EDGE_BUDGET = 6000;
const INTERACTION_EDGE_HIDE_IDLE_MS = 140;

let adaptiveDetailRafId = null;
let pendingAdaptiveDetailZoomLevel = null;

function scheduleAdaptiveDetailMode(zoomLevel) {
	pendingAdaptiveDetailZoomLevel = zoomLevel;

	if (adaptiveDetailRafId !== null) {
		return;
	}

	adaptiveDetailRafId = (typeof requestAnimationFrame === 'function'
		? requestAnimationFrame
		: (cb) => setTimeout(cb, 16))(() => {
		adaptiveDetailRafId = null;

		if (pendingAdaptiveDetailZoomLevel == null) {
			return;
		}

		updateZoomLevel(pendingAdaptiveDetailZoomLevel);
		applyAdaptiveDetailMode();

		pendingAdaptiveDetailZoomLevel = null;
	});
}

const STRUCTURAL_EDGE_TYPES = new Set([
	'file-class',
	'file-function',
	'file-method',
	'file-variable',
	'class-method',
	'function-variable',
	'method-variable',
]);

const EDGE_PRIORITY = {
	calls: 7,
	implements: 6,
	writes: 6,
	reads: 5,
	'file-dependency': 4,
	'class-method': 4,
	'function-variable': 3,
	'method-variable': 3,
	'file-class': 2,
	'file-method': 2,
	'file-function': 2,
	'file-variable': 2,
};

const LABEL_PREFIX = {
	file: 'File',
	class: 'Class',
	function: 'Fn',
	method: 'Method',
	variable: 'Var',
};

const state = {
	payload: undefined,
	cy: undefined,
	largeGraphMode: false,
	collapsedCompoundIds: new Set(),
	layoutDirection: 'TB',
	layoutMode: 'mindmap',
	dagreRegistered: false,
	topBarsVisible: true,
	theme: undefined,
	loadState: {
		remainingCount: 0,
		canLoadMore: false,
		wasTruncated: false,
	},
	totals: {
		totalNodeCount: 0,
		totalEdgeCount: 0,
	},
	view: {
		edgeBudget: MAX_VISIBLE_EDGES,
		legendVisible: true,
		hideStructuralEdges: false,
		hideVariables: false,
		smartLabels: true,
		searchQuery: '',
		edgeVisibility: {
			calls: true,
			implements: true,
			reads: true,
			writes: true,
			'file-dependency': true,
		},
	},
	viewStats: {
		visibleNodeCount: 0,
		visibleEdgeCount: 0,
		renderedEdgeCount: 0,
		truncatedByEdgeBudget: false,
	},
	keyboardNodeId: '',
	searchDebounceHandle: undefined,
	interactionEdgeHideTimeout: undefined,
	interactionEdgesHidden: false,
	activeLayoutKind: 'mindmap',
};

const elements = {
	app: document.getElementById('app'),
	graph: document.getElementById('graph'),
	summary: document.getElementById('summary'),
	menuToggle: document.getElementById('menu-toggle'),
	topBarsToggle: document.getElementById('top-bars-toggle'),
	overflowMenu: document.getElementById('overflow-menu'),
	notice: document.getElementById('notice'),
	densityControls: document.getElementById('density-controls'),
	searchInput: document.getElementById('graph-search'),
	edgeBudgetLabel: document.getElementById('edge-budget-label'),
	edgeBudget: document.getElementById('edge-budget'),
	edgeBudgetValue: document.getElementById('edge-budget-value'),
	toggleContainment: document.getElementById('toggle-containment'),
	toggleVariables: document.getElementById('toggle-variables'),
	toggleSmartLabels: document.getElementById('toggle-smart-labels'),
	toggleEdgeCalls: document.getElementById('toggle-edge-calls'),
	toggleEdgeImplements: document.getElementById('toggle-edge-implements'),
	toggleEdgeReads: document.getElementById('toggle-edge-reads'),
	toggleEdgeWrites: document.getElementById('toggle-edge-writes'),
	toggleEdgeFileDependency: document.getElementById('toggle-edge-file-dependency'),
	resetFilters: document.getElementById('reset-filters'),
	viewToggle: document.getElementById('view-toggle'),
	fitView: document.getElementById('fit-view'),
	relayout: document.getElementById('relayout'),
	loadMore: document.getElementById('load-more'),
	zoomIn: document.getElementById('zoom-in'),
	zoomOut: document.getElementById('zoom-out'),
	zoomLevel: document.getElementById('zoom-level'),
	directionToggle: document.getElementById('direction-toggle'),
	collapseAll: document.getElementById('collapse-all'),
	expandAll: document.getElementById('expand-all'),
	tooltip: document.getElementById('node-tooltip'),
	legend: document.getElementById('legend'),
	legendToggle: document.getElementById('legend-toggle'),
	legendContent: document.getElementById('legend-content'),
	legendSwatches: document.querySelectorAll('.legend-swatch'),
};

window.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || (message.type !== 'setGraphData' && message.type !== 'appendGraphData' && message.type !== 'openNodeResult')) {
		return;
	}

	if (message.type === 'openNodeResult') {
		handleOpenNodeResult(message);
		return;
	}

	if (message.type === 'setGraphData') {
		applyGraphPayload(message.payload, message);
		return;
	}

	appendGraphPayload(message.payload, message);
});

bindClick(elements.fitView, () => {
	if (!state.cy) {
		return;
	}

	state.cy.fit(undefined, 50);
});

bindClick(elements.relayout, () => {
	runLayout(true);
});

bindClick(elements.loadMore, () => {
	if (!state.payload || !state.loadState.canLoadMore) {
		return;
	}

	elements.loadMore.disabled = true;
	elements.loadMore.textContent = 'Loading...';
	vscode.postMessage({ type: 'requestLoadMore' });
});

bindClick(elements.menuToggle, () => {
	toggleOverflowMenu();
});

bindClick(elements.topBarsToggle, () => {
	toggleTopBarsVisibility();
});

bindClick(elements.zoomIn, () => {
	applyZoomStep(1);
});

bindClick(elements.zoomOut, () => {
	applyZoomStep(-1);
});

bindClick(elements.directionToggle, () => {
	if (state.layoutMode !== 'dag') {
		return;
	}

	state.layoutDirection = state.layoutDirection === 'TB' ? 'LR' : 'TB';
	updateDirectionButton();
	runLayout(true);
});

bindClick(elements.viewToggle, () => {
	state.layoutMode = state.layoutMode === 'mindmap' ? 'dag' : 'mindmap';
	updateViewToggleButton();
	updateDirectionButton();
	runLayout(true);
});

bindClick(elements.collapseAll, () => {
	if (!state.cy) {
		return;
	}

	state.collapsedCompoundIds.clear();
	state.cy.nodes(':parent').forEach((node) => {
		state.collapsedCompoundIds.add(node.id());
	});

	applyCollapsedState();
	runLayout(false);
	setNotice(buildRenderNotice(getBaseLoadNotice()));
});

bindClick(elements.expandAll, () => {
	state.collapsedCompoundIds.clear();
	applyCollapsedState();
	runLayout(false);
	setNotice(buildRenderNotice(getBaseLoadNotice()));
});

bindClick(elements.legendToggle, () => {
	state.view.legendVisible = !state.view.legendVisible;
	updateLegendVisibility();
});

bindClick(elements.toggleContainment, () => {
	state.view.hideStructuralEdges = !state.view.hideStructuralEdges;
	updateFilterControlStates();
	renderVisibleGraph({ refreshElements: false, relayout: false });
});

bindClick(elements.toggleVariables, () => {
	state.view.hideVariables = !state.view.hideVariables;
	updateFilterControlStates();
	renderVisibleGraph({ refreshElements: false, relayout: false });
});

bindClick(elements.toggleSmartLabels, () => {
	state.view.smartLabels = !state.view.smartLabels;
	updateFilterControlStates();
	applyAdaptiveDetailMode();
});

bindClick(elements.toggleEdgeCalls, () => {
	toggleEdgeVisibility('calls');
});

bindClick(elements.toggleEdgeImplements, () => {
	toggleEdgeVisibility('implements');
});

bindClick(elements.toggleEdgeReads, () => {
	toggleEdgeVisibility('reads');
});

bindClick(elements.toggleEdgeWrites, () => {
	toggleEdgeVisibility('writes');
});

bindClick(elements.toggleEdgeFileDependency, () => {
	toggleEdgeVisibility('file-dependency');
});

bindClick(elements.resetFilters, () => {
	resetClarityControls();
	renderVisibleGraph({ refreshElements: false, relayout: false });
});

if (elements.edgeBudget) {
	elements.edgeBudget.addEventListener('input', () => {
		const nextValue = Number(elements.edgeBudget.value);
		if (!Number.isFinite(nextValue)) {
			return;
		}

		state.view.edgeBudget = clamp(Math.round(nextValue), MIN_EDGE_BUDGET, MAX_VISIBLE_EDGES);
		updateEdgeBudgetLabel();
	});

	elements.edgeBudget.addEventListener('change', () => {
		const nextValue = Number(elements.edgeBudget.value);
		if (!Number.isFinite(nextValue)) {
			return;
		}

		state.view.edgeBudget = clamp(Math.round(nextValue), MIN_EDGE_BUDGET, MAX_VISIBLE_EDGES);
		updateEdgeBudgetLabel();
		renderVisibleGraph({ refreshElements: false, relayout: false });
	});
}

if (elements.searchInput) {
	elements.searchInput.addEventListener('input', () => {
		if (state.searchDebounceHandle) {
			window.clearTimeout(state.searchDebounceHandle);
		}

		state.searchDebounceHandle = window.setTimeout(() => {
			state.view.searchQuery = (elements.searchInput.value || '').trim();
			renderVisibleGraph({ refreshElements: false, relayout: false });
		}, SEARCH_INPUT_DEBOUNCE_MS);
	});
}

resetClarityControls();
updateFilterControlStates();
updateViewToggleButton();
updateDirectionButton();
bindOverflowMenuInteractions();
initKeyboardInteractions();
updateTopBarsToggleState();
updateLegendVisibility();
vscode.postMessage({ type: 'ready' });

function applyGraphPayload(payload, envelope) {
	if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
		setNotice('Unable to render graph payload.');
		return;
	}

	if (typeof cytoscape !== 'function') {
		setNotice('Cytoscape failed to load.');
		return;
	}

	registerDagreExtension();

	state.payload = {
		nodes: [...payload.nodes],
		edges: [...payload.edges],
		meta: payload.meta,
	};
	state.collapsedCompoundIds.clear();

	state.loadState = sanitizeLoadState(envelope && envelope.loadState);
	state.totals = sanitizeTotals(envelope && envelope.totals, state.payload);
	state.largeGraphMode = isLargeGraph(state.totals);
	if (state.interactionEdgeHideTimeout) {
		clearTimeout(state.interactionEdgeHideTimeout);
		state.interactionEdgeHideTimeout = undefined;
	}
	state.interactionEdgesHidden = false;
	resetClarityControls();
	applyLargeGraphDefaults();

	if (!state.cy) {
		state.cy = createGraphInstance();
		wireInteractions(state.cy);
		syncLegendColors();
	}

	renderVisibleGraph({ refreshElements: true, resetElements: true, relayout: true, forceFit: true });
	updateLoadMoreButton();
	updateZoomLevel(state.cy.zoom());
}

function appendGraphPayload(payload, envelope) {
	if (!state.payload || !payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
		return;
	}

	const existingNodeIds = new Set(state.payload.nodes.map((node) => node.id));
	for (const node of payload.nodes) {
		if (!existingNodeIds.has(node.id)) {
			state.payload.nodes.push(node);
			existingNodeIds.add(node.id);
		}
	}

	const existingEdgeIds = new Set(state.payload.edges.map((edge) => edge.id));
	for (const edge of payload.edges) {
		if (!existingEdgeIds.has(edge.id)) {
			state.payload.edges.push(edge);
			existingEdgeIds.add(edge.id);
		}
	}

	state.loadState = sanitizeLoadState(envelope && envelope.loadState);
	state.totals = sanitizeTotals(envelope && envelope.totals, state.payload);
	state.largeGraphMode = isLargeGraph(state.totals);

	renderVisibleGraph({ refreshElements: true, resetElements: false, relayout: true, forceFit: false });
	updateLoadMoreButton();

	const appendedNodeCount = Number.isFinite(envelope && envelope.appendedNodeCount)
		? Number(envelope.appendedNodeCount)
		: payload.nodes.length;
	if (appendedNodeCount > 0) {
		setNotice(buildRenderNotice(`Loaded ${appendedNodeCount} more nodes.`));
	} else if (!state.loadState.canLoadMore) {
		setNotice(buildRenderNotice('All available nodes are loaded.'));
	}
}

function registerDagreExtension() {
	if (state.dagreRegistered) {
		return;
	}

	if (typeof cytoscapeDagre === 'function') {
		cytoscape.use(cytoscapeDagre);
		state.dagreRegistered = true;
		return;
	}

	setNotice('DAG layout plugin did not load. Falling back to default layout.');
}

function createGraphInstance() {
	state.theme = readThemeTokens();

	const cy = cytoscape({
		container: elements.graph,
		elements: [],
		wheelSensitivity: 0.34,
		pixelRatio: state.largeGraphMode ? 1 : 'auto',
		selectionType: 'single',
		minZoom: MIN_ZOOM,
		maxZoom: MAX_ZOOM,
		style: [
			{
				selector: 'node',
				style: {
					label: 'data(label)',
					'font-size': 11,
					color: state.theme.text,
					'font-family': state.theme.fontFamily,
					'text-wrap': 'wrap',
					'text-max-width': 190,
					'background-color': state.theme.node.function.bg,
					width: 28,
					height: 28,
					'border-width': 1.2,
					'border-color': state.theme.node.function.border,
					'overlay-opacity': 0,
					'text-valign': 'center',
					'text-halign': 'center',
				},
			},
			{
				selector: 'node:parent',
				style: {
					shape: 'round-rectangle',
					'background-opacity': 0.13,
					'background-color': state.theme.compound.fill,
					'border-width': 1.6,
					'border-color': state.theme.compound.border,
					'border-style': 'dashed',
					'padding-top': 16,
					'padding-left': 12,
					'padding-right': 12,
					'padding-bottom': 12,
					'text-valign': 'top',
					'text-halign': 'left',
					'font-size': 10,
					color: state.theme.compound.label,
					'text-margin-x': 4,
					'text-margin-y': 3,
				},
			},
			{
				selector: 'node[type = "file"]',
				style: {
					shape: 'round-rectangle',
					'background-color': state.theme.node.file.bg,
					'border-color': state.theme.node.file.border,
					width: 82,
					height: 38,
				},
			},
			{
				selector: 'node[type = "class"]',
				style: {
					shape: 'round-rectangle',
					'background-color': state.theme.node.class.bg,
					'border-color': state.theme.node.class.border,
					width: 70,
					height: 34,
				},
			},
			{
				selector: 'node[type = "function"]',
				style: {
					shape: 'ellipse',
					'background-color': state.theme.node.function.bg,
					'border-color': state.theme.node.function.border,
					width: 62,
					height: 32,
				},
			},
			{
				selector: 'node[type = "method"]',
				style: {
					shape: 'diamond',
					'background-color': state.theme.node.method.bg,
					'border-color': state.theme.node.method.border,
					width: 58,
					height: 34,
					'font-size': 10,
				},
			},
			{
				selector: 'node[type = "variable"]',
				style: {
					shape: 'tag',
					'background-color': state.theme.node.variable.bg,
					'border-color': state.theme.node.variable.border,
					width: 52,
					height: 26,
					'font-size': 9,
				},
			},
			{
				selector: 'node[type = "file"]:parent',
				style: {
					'background-color': state.theme.node.file.bg,
					'background-opacity': 0.08,
					'border-color': state.theme.node.file.border,
				},
			},
			{
				selector: 'node[type = "class"]:parent',
				style: {
					'background-color': state.theme.node.class.bg,
					'background-opacity': 0.12,
					'border-color': state.theme.node.class.border,
				},
			},
			{
				selector: 'edge',
				style: {
					width: 1.25,
					'line-color': state.theme.edge.default,
					'target-arrow-color': state.theme.edge.default,
					'target-arrow-shape': 'triangle',
					'curve-style': 'bezier',
					opacity: 0.6,
				},
			},
			{
				selector: 'edge[edgeType = "calls"]',
				style: {
					width: 1.8,
					'line-color': state.theme.edge.calls,
					'target-arrow-color': state.theme.edge.calls,
					'line-style': 'solid',
				},
			},
			{
				selector: 'edge[edgeType = "implements"]',
				style: {
					width: 1.8,
					'line-color': state.theme.edge.implements,
					'target-arrow-color': state.theme.edge.implements,
					'line-style': 'dotted',
				},
			},
			{
				selector: 'edge[edgeType = "reads"]',
				style: {
					width: 1.5,
					'line-color': state.theme.edge.reads,
					'target-arrow-color': state.theme.edge.reads,
					'line-style': 'dashed',
				},
			},
			{
				selector: 'edge[edgeType = "writes"]',
				style: {
					width: 2,
					'line-color': state.theme.edge.writes,
					'target-arrow-color': state.theme.edge.writes,
					'line-style': 'solid',
				},
			},
			{
				selector: 'edge[edgeType = "file-dependency"]',
				style: {
					width: 1.7,
					'line-color': state.theme.edge.fileDependency,
					'target-arrow-color': state.theme.edge.fileDependency,
					'line-style': 'dashed',
				},
			},
			{
				selector: 'edge[edgeType = "class-method"], edge[edgeType = "function-variable"], edge[edgeType = "method-variable"]',
				style: {
					width: 1.2,
					'line-color': state.theme.edge.containment,
					'target-arrow-color': state.theme.edge.containment,
					'line-style': 'dotted',
					opacity: 0.4,
				},
			},
			{
				selector: '.is-focused',
				style: {
					opacity: 1,
					'border-width': 2.2,
					'line-color': state.theme.focus,
					'target-arrow-color': state.theme.focus,
				},
			},
			{
				selector: '.is-dimmed',
				style: {
					opacity: 0.1,
				},
			},
			{
				selector: 'node.label-hidden',
				style: {
					label: '',
				},
			},
			{
				selector: 'edge.edge-low-detail',
				style: {
					opacity: 0.24,
					width: 1,
					'target-arrow-shape': 'none',
				},
			},
			{
				selector: 'node.compound-collapsed',
				style: {
					'background-opacity': 0.04,
					'padding-top': 8,
					'padding-left': 8,
					'padding-right': 8,
					'padding-bottom': 8,
					width: 94,
					height: 40,
				},
			},
			{
				selector: '.compound-collapsed-hidden, .hidden-by-collapse, .hidden-by-filter, .hidden-by-edge-budget, .hidden-by-viewport',
				style: {
					display: 'none',
				},
			},
		],
	});

	if (!cy.zoomingEnabled()) {
		cy.zoomingEnabled(true);
	}

	if (cy.userZoomingEnabled()) {
		cy.userZoomingEnabled(false);
	}

	return cy;
}

function wireInteractions(cy) {
	cy.on('tap', 'node', (event) => {
		const node = event.target;
		const data = node.data();
		const originalEvent = event.originalEvent;
		const isModifiedOpen = Boolean(originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey || originalEvent.altKey));

		state.keyboardNodeId = node.id();
		applyTraceFocus(node);

		if (!isModifiedOpen || !data.uriString) {
			return;
		}

		postOpenNodeTarget(data);
	});

	cy.on('dbltap', 'node:parent', (event) => {
		const node = event.target;
		const nodeId = node.id();

		if (state.collapsedCompoundIds.has(nodeId)) {
			state.collapsedCompoundIds.delete(nodeId);
		} else {
			state.collapsedCompoundIds.add(nodeId);
		}

		applyCollapsedState();
		runLayout(false);
		setNotice(buildRenderNotice(getBaseLoadNotice()));
	});

	cy.on('mouseover', 'node', (event) => {
		const node = event.target;
		applyTraceFocus(node);
		showTooltip(node, event);
	});

	cy.on('mousemove', 'node', (event) => {
		moveTooltip(event);
	});

	cy.on('mouseout', 'node', () => {
		clearTraceFocus();
		hideTooltip();
	});

	cy.on('tap', (event) => {
		if (event.target === cy) {
			clearTraceFocus();
			hideTooltip();
			state.keyboardNodeId = '';
		}
	});

	cy.on('zoom', () => {
		scheduleAdaptiveDetailMode(cy.zoom());
		hideTooltip();
		scheduleViewportInteractionEdgeHiding();
	});

	cy.on('pan', () => {
		hideTooltip();
		scheduleViewportInteractionEdgeHiding();
	});

	bindWheelZoomBehavior();
}

function initKeyboardInteractions() {
	if (!elements.graph) {
		return;
	}

	elements.graph.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space / + - F V D L Escape');

	elements.graph.addEventListener('keydown', (event) => {
		if (!state.cy) {
			return;
		}

		const key = event.key;
		const lowerKey = key.toLowerCase();
		const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
		if (hasModifier) {
			return;
		}

		if (lowerKey === '/') {
			event.preventDefault();
			if (elements.searchInput) {
				elements.searchInput.focus();
				elements.searchInput.select();
			}
			return;
		}

		if (lowerKey === 'f') {
			event.preventDefault();
			if (state.cy) {
				state.cy.fit(undefined, 50);
			}
			return;
		}

		if (lowerKey === 'v') {
			event.preventDefault();
			if (elements.viewToggle) {
				elements.viewToggle.click();
			}
			return;
		}

		if (lowerKey === 'd') {
			event.preventDefault();
			if (elements.directionToggle && !elements.directionToggle.disabled) {
				elements.directionToggle.click();
			}
			return;
		}

		if (lowerKey === 'l') {
			event.preventDefault();
			if (elements.loadMore && !elements.loadMore.disabled) {
				elements.loadMore.click();
			}
			return;
		}

		if (key === '+' || key === '=') {
			event.preventDefault();
			applyZoomStep(1);
			return;
		}

		if (key === '-' || key === '_') {
			event.preventDefault();
			applyZoomStep(-1);
			return;
		}

		if (key === 'Escape') {
			event.preventDefault();
			clearTraceFocus();
			hideTooltip();
			state.keyboardNodeId = '';
			return;
		}

		if (key === 'Enter' || key === ' ') {
			event.preventDefault();
			activateKeyboardFocusedNode();
			return;
		}

		if (key.startsWith('Arrow')) {
			event.preventDefault();
			moveKeyboardFocusByDirection(key);
		}
	});
}

function postOpenNodeTarget(nodeData) {
	if (!nodeData || !nodeData.uriString) {
		setNotice('Unable to open symbol location for this node.');
		return;
	}

	setNotice('Opening symbol in editor...');

	vscode.postMessage({
		type: 'openNode',
		target: {
			uriString: nodeData.uriString,
			line: nodeData.line,
			rangeStartLine: nodeData.rangeStartLine,
			rangeStartCharacter: nodeData.rangeStartCharacter,
			rangeEndLine: nodeData.rangeEndLine,
			rangeEndCharacter: nodeData.rangeEndCharacter,
		},
	});
}

function handleOpenNodeResult(message) {
	if (!message || typeof message !== 'object') {
		return;
	}

	if (message.status === 'success') {
		setNotice('Opened symbol in editor.');
		return;
	}

	const errorMessage = typeof message.message === 'string' && message.message.trim().length > 0
		? message.message.trim()
		: 'Unable to open selected symbol.';
	setNotice(errorMessage);
}

function activateKeyboardFocusedNode() {
	if (!state.cy) {
		return;
	}

	let node = state.keyboardNodeId ? state.cy.getElementById(state.keyboardNodeId) : undefined;
	if (!node || !node.isNode || !node.isNode()) {
		node = state.cy.nodes(':visible').first();
	}

	if (!node || !node.isNode || !node.isNode()) {
		return;
	}

	state.keyboardNodeId = node.id();
	applyTraceFocus(node);
	postOpenNodeTarget(node.data());
}

function moveKeyboardFocusByDirection(directionKey) {
	if (!state.cy) {
		return;
	}

	const visibleNodes = state.cy.nodes(':visible').filter((node) => !node.hasClass('compound-collapsed-hidden'));
	if (visibleNodes.length === 0) {
		return;
	}

	let current = state.keyboardNodeId ? state.cy.getElementById(state.keyboardNodeId) : undefined;
	if (!current || !current.isNode || !current.isNode() || !current.visible()) {
		current = visibleNodes.first();
		state.keyboardNodeId = current.id();
		applyTraceFocus(current);
		return;
	}

	const currentPosition = current.position();
	let bestCandidate;
	let bestScore = Number.POSITIVE_INFINITY;

	visibleNodes.forEach((candidate) => {
		if (candidate.id() === current.id()) {
			return;
		}

		const position = candidate.position();
		const dx = position.x - currentPosition.x;
		const dy = position.y - currentPosition.y;

		if (directionKey === 'ArrowRight' && dx <= 0) {
			return;
		}
		if (directionKey === 'ArrowLeft' && dx >= 0) {
			return;
		}
		if (directionKey === 'ArrowDown' && dy <= 0) {
			return;
		}
		if (directionKey === 'ArrowUp' && dy >= 0) {
			return;
		}

		const primaryDistance = (directionKey === 'ArrowLeft' || directionKey === 'ArrowRight') ? Math.abs(dx) : Math.abs(dy);
		const secondaryDistance = (directionKey === 'ArrowLeft' || directionKey === 'ArrowRight') ? Math.abs(dy) : Math.abs(dx);
		const score = (primaryDistance * 4) + secondaryDistance;

		if (score < bestScore) {
			bestScore = score;
			bestCandidate = candidate;
		}
	});

	if (!bestCandidate) {
		return;
	}

	state.keyboardNodeId = bestCandidate.id();
	applyTraceFocus(bestCandidate);
	if (state.cy) {
		state.cy.animate({
			center: { eles: bestCandidate },
			duration: 120,
		});
	}
}

function renderVisibleGraph(options = {}) {
	if (!state.payload || !state.cy) {
		return;
	}

	const refreshElements = Boolean(options.refreshElements);
	const resetElements = Boolean(options.resetElements);
	const relayout = Boolean(options.relayout);
	const forceFit = Boolean(options.forceFit);

	if (refreshElements) {
		synchronizeCytoscapeElements(resetElements);
	}

	const filtered = computeFilteredGraphSnapshot();
	state.viewStats = {
		visibleNodeCount: filtered.visibleNodes.length,
		visibleEdgeCount: filtered.visibleEdges.length,
		renderedEdgeCount: filtered.renderedEdges.length,
		truncatedByEdgeBudget: filtered.visibleEdges.length > filtered.renderedEdges.length,
	};

	applyVisibilityToElements(filtered);

	updateSummary();
	updateFilterControlStates();
	setNotice(buildRenderNotice(getBaseLoadNotice()));
	applyCollapsedState();
	ensureKeyboardFocusNode();

	if (relayout) {
		runLayout(forceFit);
		return;
	}

	applyAdaptiveDetailMode();
}

function synchronizeCytoscapeElements(resetElements) {
	if (!state.payload || !state.cy) {
		return;
	}

	const degreeByNodeId = buildNodeDegreeMap(state.payload.edges);
	const compoundNodes = buildCompoundNodeDefinitions(state.payload.nodes, state.payload.edges);
	const nodeById = new Map(compoundNodes.map((node) => [node.id, node]));

	const nodeElements = compoundNodes.map((node) => toCytoscapeNodeElement(node, nodeById, degreeByNodeId));
	const edgeElements = state.payload.edges.map((edge) => toCytoscapeEdgeElement(edge));

	state.cy.batch(() => {
		if (resetElements) {
			state.cy.elements().remove();
			state.cy.add([...nodeElements, ...edgeElements]);
			return;
		}

		const existingNodeIds = new Set(state.cy.nodes().map((node) => node.id()));
		const existingEdgeIds = new Set(state.cy.edges().map((edge) => edge.id()));
		const nodesToAdd = nodeElements.filter((entry) => !existingNodeIds.has(entry.data.id));
		const edgesToAdd = edgeElements.filter((entry) => !existingEdgeIds.has(entry.data.id));

		if (nodesToAdd.length > 0 || edgesToAdd.length > 0) {
			state.cy.add([...nodesToAdd, ...edgesToAdd]);
		}
	});
}

function toCytoscapeNodeElement(node, nodeById, degreeByNodeId) {
	const parentId = node.parentId && nodeById.has(node.parentId) && node.parentId !== node.id
		? node.parentId
		: undefined;

	return {
		data: {
			id: node.id,
			parent: parentId,
			label: buildNodeLabel(node),
			degree: degreeByNodeId.get(node.id) || node.degree || 0,
			type: node.type,
			filePath: node.filePath,
			uriString: node.uriString,
			line: node.line,
			rangeStartLine: node.rangeStartLine,
			rangeStartCharacter: node.rangeStartCharacter,
			rangeEndLine: node.rangeEndLine,
			rangeEndCharacter: node.rangeEndCharacter,
			fullName: node.name,
		},
	};
}

function toCytoscapeEdgeElement(edge) {
	return {
		data: {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			relationship: edge.relationship,
			edgeType: edge.edgeType || edge.relationship,
		},
	};
}

function applyVisibilityToElements(filtered) {
	if (!state.cy) {
		return;
	}

	state.cy.batch(() => {
		state.cy.nodes().forEach((node) => {
			const isVisible = filtered.visibleNodeIds.has(node.id());
			node.toggleClass('hidden-by-filter', !isVisible);
		});

		state.cy.edges().forEach((edge) => {
			const edgeId = edge.id();
			const isVisible = filtered.visibleEdgeIds.has(edgeId);
			const isRendered = filtered.renderedEdgeIds.has(edgeId);
			const hiddenByFilter = !isVisible;
			const hiddenByBudget = isVisible && !isRendered;

			edge.toggleClass('hidden-by-filter', hiddenByFilter);
			edge.toggleClass('hidden-by-edge-budget', hiddenByBudget);
			edge.toggleClass('hidden-by-viewport', state.interactionEdgesHidden);
		});
	});
}

function computeFilteredGraphSnapshot() {
	if (!state.payload) {
		return {
			visibleNodes: [],
			visibleEdges: [],
			renderedEdges: [],
		};
	}

	const query = state.view.searchQuery.trim().toLowerCase();
	const filteredNodes = state.payload.nodes.filter((node) => !state.view.hideVariables || node.type !== 'variable');
	const allowedNodeIds = new Set(filteredNodes.map((node) => node.id));

	let filteredEdges = state.payload.edges.filter((edge) => {
		const edgeType = edge.edgeType || edge.relationship;
		if (Object.prototype.hasOwnProperty.call(state.view.edgeVisibility, edgeType) && !state.view.edgeVisibility[edgeType]) {
			return false;
		}

		if (state.view.hideStructuralEdges && STRUCTURAL_EDGE_TYPES.has(edgeType)) {
			return false;
		}

		return allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target);
	});

	let visibleNodes = filteredNodes;
	if (query) {
		const matchedNodeIds = new Set(
			filteredNodes
				.filter((node) => matchesSearchQuery(node, query))
				.map((node) => node.id)
		);

		if (matchedNodeIds.size === 0) {
			visibleNodes = [];
			filteredEdges = [];
		} else {
			const neighborhoodNodeIds = new Set(matchedNodeIds);
			for (const edge of filteredEdges) {
				if (matchedNodeIds.has(edge.source) || matchedNodeIds.has(edge.target)) {
					neighborhoodNodeIds.add(edge.source);
					neighborhoodNodeIds.add(edge.target);
				}
			}

			visibleNodes = filteredNodes.filter((node) => neighborhoodNodeIds.has(node.id));
			filteredEdges = filteredEdges.filter((edge) => neighborhoodNodeIds.has(edge.source) && neighborhoodNodeIds.has(edge.target));
		}
	}

	const renderedEdges = prioritizeEdges(filteredEdges, state.view.edgeBudget);
	const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
	const visibleEdgeIds = new Set(filteredEdges.map((edge) => edge.id));
	const renderedEdgeIds = new Set(renderedEdges.map((edge) => edge.id));

	return {
		visibleNodes,
		visibleEdges: filteredEdges,
		renderedEdges,
		visibleNodeIds,
		visibleEdgeIds,
		renderedEdgeIds,
	};
}

function buildNodeDegreeMap(edges) {
	const degreeByNodeId = new Map();

	for (const edge of edges) {
		degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) || 0) + 1);
		degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) || 0) + 1);
	}

	return degreeByNodeId;
}

function matchesSearchQuery(node, query) {
	const name = String(node.name || '').toLowerCase();
	const filePath = String(node.filePath || '').toLowerCase();
	const type = String(node.type || '').toLowerCase();
	return name.includes(query) || filePath.includes(query) || type.includes(query);
}

function buildCompoundNodeDefinitions(nodes, edges) {
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const classByMethod = new Map();
	const methodByVariable = new Map();
	const functionByVariable = new Map();

	for (const edge of edges) {
		if (edge.relationship === 'class-method') {
			classByMethod.set(edge.target, edge.source);
			continue;
		}

		if (edge.relationship === 'method-variable') {
			methodByVariable.set(edge.target, edge.source);
			continue;
		}

		if (edge.relationship === 'function-variable') {
			functionByVariable.set(edge.target, edge.source);
		}
	}

	return nodes.map((node) => {
		let resolvedParentId = node.parentId;

		if (node.type === 'method') {
			resolvedParentId = classByMethod.get(node.id) || node.parentId;
		}

		if (node.type === 'variable') {
			resolvedParentId = methodByVariable.get(node.id)
				|| functionByVariable.get(node.id)
				|| node.parentId;
		}

		if (resolvedParentId && !nodeById.has(resolvedParentId)) {
			resolvedParentId = undefined;
		}

		if (resolvedParentId === node.id) {
			resolvedParentId = undefined;
		}

		return {
			...node,
			parentId: resolvedParentId,
		};
	});
}

function runLayout(forceFit) {
	if (!state.cy) {
		return;
	}

	const layoutEles = state.cy.elements(':visible').not('.compound-collapsed-hidden');
	const layoutNodes = layoutEles.nodes();
	const nodeCount = layoutNodes.length;
	if (nodeCount === 0) {
		return;
	}

	const collapsedCount = state.collapsedCompoundIds.size;
	const hasCollapsedGroups = collapsedCount > 0;
	const shouldAnimate = nodeCount < 2200;
	let layoutOptions;
	let layoutTarget = layoutNodes;

	if (state.layoutMode === 'dag' && state.dagreRegistered) {
		state.activeLayoutKind = 'dag';
		layoutOptions = {
			name: 'dagre',
			rankDir: state.layoutDirection,
			animate: shouldAnimate,
			animationDuration: 320,
			fit: forceFit || nodeCount < 1000,
			padding: 56,
			nodeSep: 34,
			rankSep: 82,
			edgeSep: 16,
			acyclicer: 'greedy',
			ranker: 'network-simplex',
		};
		layoutTarget = layoutEles;
	} else if (state.layoutMode === 'mindmap' && hasCollapsedGroups) {
		state.activeLayoutKind = 'collapsed-grid';
		const topLevelNodes = layoutNodes.filter((node) => !node.data('parent'));
		layoutTarget = topLevelNodes.length > 0 ? topLevelNodes : layoutNodes;
		const compactNodeCount = layoutTarget.length;
		const gridColumns = Math.max(2, Math.ceil(Math.sqrt(compactNodeCount)));
		layoutOptions = {
			name: 'grid',
			animate: false,
			animationDuration: 0,
			fit: true,
			padding: 22,
			avoidOverlap: true,
			avoidOverlapPadding: 8,
			nodeDimensionsIncludeLabels: true,
			spacingFactor: 0.62,
			condense: true,
			rows: Math.ceil(compactNodeCount / gridColumns),
			cols: gridColumns,
			sort: (left, right) => {
				const keyCompare = buildLayoutSortKey(left).localeCompare(buildLayoutSortKey(right));
				if (keyCompare !== 0) {
					return keyCompare;
				}

				return left.id().localeCompare(right.id());
			},
		};
	} else {
		state.activeLayoutKind = 'mindmap';
		layoutOptions = {
			name: 'concentric',
			animate: shouldAnimate,
			animationDuration: 320,
			fit: forceFit || nodeCount < 1400,
			padding: 52,
			startAngle: (3 * Math.PI) / 2,
			clockwise: true,
			avoidOverlap: true,
			spacingFactor: nodeCount > 1400 ? 0.95 : 1.12,
			concentric: (node) => {
				const degree = Number(node.data('degree') || 0);
				return degree + getMindMapTypeWeight(node.data('type'));
			},
			levelWidth: () => 4,
		};
	}

	const layout = layoutTarget.layout(layoutOptions);

	layout.run();
	applyAdaptiveDetailMode();
	setNotice(buildRenderNotice(getBaseLoadNotice()));
}

function buildLayoutSortKey(node) {
	const data = node.data();
	return String(data.filePath || data.fullName || data.label || node.id()).toLowerCase();
}

function applyCollapsedState() {
	if (!state.cy) {
		return;
	}

	const cy = state.cy;
	cy.batch(() => {
		cy.elements().removeClass('compound-collapsed compound-collapsed-hidden hidden-by-collapse');

		cy.nodes(':parent').forEach((node) => {
			const nodeId = node.id();
			if (!state.collapsedCompoundIds.has(nodeId)) {
				return;
			}

			const descendants = node.descendants();
			const parentPosition = node.position();

			// Compaction step: stack descendants onto the parent before hiding so
			// compound bounds do not remain stretched by old descendant geometry.
			descendants.nodes().forEach((descendant) => {
				descendant.position({
					x: parentPosition.x,
					y: parentPosition.y,
				});
			});

			node.addClass('compound-collapsed');
			descendants.addClass('compound-collapsed-hidden');
			descendants.connectedEdges().addClass('hidden-by-collapse');
		});
	});
}

function applyTraceFocus(node) {
	if (!state.cy) {
		return;
	}

	const cy = state.cy;
	const focusEdges = node.isParent()
		? node.descendants().nodes().connectedEdges()
		: node.incomers('edge').union(node.outgoers('edge'));
	const focusNodes = focusEdges.connectedNodes().union(node);
	const allFocused = focusNodes.union(focusEdges);

	cy.elements().addClass('is-dimmed').removeClass('is-focused');
	allFocused.removeClass('is-dimmed').addClass('is-focused');
	applyAdaptiveDetailMode();
}

function clearTraceFocus() {
	if (!state.cy) {
		return;
	}

	state.cy.elements().removeClass('is-dimmed is-focused');
	applyAdaptiveDetailMode();
}

function prioritizeEdges(edges, maxEdges) {
	if (edges.length <= maxEdges) {
		return edges;
	}

	return [...edges]
		.sort((left, right) => {
			const leftType = left.edgeType || left.relationship;
			const rightType = right.edgeType || right.relationship;
			return (EDGE_PRIORITY[rightType] || 0) - (EDGE_PRIORITY[leftType] || 0);
		})
		.slice(0, maxEdges);
}

function updateSummary() {
	if (!elements.summary || !state.payload) {
		return;
	}

	const visibleNodeCount = state.viewStats.visibleNodeCount;
	const visibleEdgeCount = state.viewStats.visibleEdgeCount;
	const renderedEdgeCount = state.viewStats.renderedEdgeCount;
	const totalNodeCount = state.totals.totalNodeCount;
	const totalEdgeCount = state.totals.totalEdgeCount;

	let text = `Nodes ${visibleNodeCount}/${totalNodeCount} | Edges ${visibleEdgeCount}/${totalEdgeCount}`;
	if (renderedEdgeCount < visibleEdgeCount) {
		text += ` | Rendered ${renderedEdgeCount}`;
	}

	if (state.view.searchQuery) {
		text += ` | Search "${state.view.searchQuery}"`;
	}

	elements.summary.textContent = text;
}

function getBaseLoadNotice() {
	if (state.loadState.canLoadMore) {
		return state.largeGraphMode
			? 'Large graph mode is active. Showing behavior-focused edges by default. Use Load More to fetch additional nodes.'
			: 'Large graph detected. Use Load More to fetch additional nodes.';
	}

	if (state.loadState.wasTruncated) {
		return 'All available nodes are loaded.';
	}

	return 'Graph loaded.';
}

function buildRenderNotice(baseMessage) {
	const notes = [];

	if (state.activeLayoutKind === 'collapsed-grid') {
		notes.push('Collapsed grid layout active.');
	}

	if (state.viewStats.truncatedByEdgeBudget) {
		notes.push(`Edge budget rendered ${state.viewStats.renderedEdgeCount}/${state.viewStats.visibleEdgeCount}.`);
	}

	if (state.view.hideStructuralEdges) {
		notes.push('Structural edges hidden.');
	}

	if (state.view.hideVariables) {
		notes.push('Variables hidden.');
	}

	if (state.view.searchQuery) {
		notes.push(`Search filter active for "${state.view.searchQuery}".`);
	}

	const hiddenEdgeTypes = Object.entries(state.view.edgeVisibility)
		.filter(([, isVisible]) => !isVisible)
		.map(([edgeType]) => edgeType);
	if (hiddenEdgeTypes.length > 0) {
		notes.push(`Hidden edge types: ${hiddenEdgeTypes.join(', ')}.`);
	}

	if (notes.length === 0) {
		return baseMessage;
	}

	return `${baseMessage} ${notes.join(' ')}`;
}

function updateFilterControlStates() {
	if (elements.toggleContainment) {
		elements.toggleContainment.dataset.active = state.view.hideStructuralEdges ? 'true' : 'false';
		elements.toggleContainment.textContent = state.view.hideStructuralEdges ? 'Structural Hidden' : 'Hide Structural Edges';
		elements.toggleContainment.setAttribute('aria-checked', state.view.hideStructuralEdges ? 'true' : 'false');
	}

	if (elements.toggleVariables) {
		elements.toggleVariables.dataset.active = state.view.hideVariables ? 'true' : 'false';
		elements.toggleVariables.textContent = state.view.hideVariables ? 'Variables Hidden' : 'Hide Variables';
		elements.toggleVariables.setAttribute('aria-checked', state.view.hideVariables ? 'true' : 'false');
	}

	if (elements.toggleSmartLabels) {
		elements.toggleSmartLabels.dataset.active = state.view.smartLabels ? 'true' : 'false';
		elements.toggleSmartLabels.textContent = `Smart Labels: ${state.view.smartLabels ? 'On' : 'Off'}`;
		elements.toggleSmartLabels.setAttribute('aria-checked', state.view.smartLabels ? 'true' : 'false');
	}

	updateEdgeToggleButton(elements.toggleEdgeCalls, 'Calls', 'calls');
	updateEdgeToggleButton(elements.toggleEdgeImplements, 'Implements', 'implements');
	updateEdgeToggleButton(elements.toggleEdgeReads, 'Reads', 'reads');
	updateEdgeToggleButton(elements.toggleEdgeWrites, 'Writes', 'writes');
	updateEdgeToggleButton(elements.toggleEdgeFileDependency, 'File Deps', 'file-dependency');

	if (elements.edgeBudget) {
		elements.edgeBudget.value = String(state.view.edgeBudget);
	}

	updateEdgeBudgetLabel();
}

function updateLegendVisibility() {
	const isVisible = state.view.legendVisible;

	if (elements.legend) {
		elements.legend.dataset.collapsed = isVisible ? 'false' : 'true';
	}

	if (elements.legendContent) {
		elements.legendContent.hidden = !isVisible;
	}

	if (elements.legendToggle) {
		elements.legendToggle.textContent = isVisible ? 'Hide Legend' : 'Show Legend';
		elements.legendToggle.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
		elements.legendToggle.title = isVisible ? 'Hide legend' : 'Show legend';
	}
}

function updateEdgeBudgetLabel() {
	if (!elements.edgeBudgetValue) {
		return;
	}

	elements.edgeBudgetValue.textContent = `${state.view.edgeBudget.toLocaleString()}`;
	updateEdgeBudgetTooltip();
}

function buildEdgeBudgetTooltipText(edgeBudget) {
	return `Edge Budget sets the maximum number of edges rendered (${MIN_EDGE_BUDGET.toLocaleString()}-${MAX_VISIBLE_EDGES.toLocaleString()}). Lower values improve readability and performance. Current: ${edgeBudget.toLocaleString()}.`;
}

function updateEdgeBudgetTooltip() {
	const tooltipText = buildEdgeBudgetTooltipText(state.view.edgeBudget);

	if (elements.edgeBudget) {
		elements.edgeBudget.title = tooltipText;
	}

	if (elements.edgeBudgetLabel) {
		elements.edgeBudgetLabel.title = tooltipText;
	}

	if (elements.edgeBudgetValue) {
		elements.edgeBudgetValue.title = `Current edge budget: ${state.view.edgeBudget.toLocaleString()}`;
	}
}

function resetClarityControls() {
	// Cancel any pending debounced search so it doesn't run after reset
	if (state.searchDebounceHandle) {
		clearTimeout(state.searchDebounceHandle);
		state.searchDebounceHandle = undefined;
	}

	state.view.edgeBudget = MAX_VISIBLE_EDGES;
	state.view.hideStructuralEdges = false;
	state.view.hideVariables = false;
	state.view.smartLabels = true;
	state.view.searchQuery = '';
	state.view.edgeVisibility.calls = true;
	state.view.edgeVisibility.implements = true;
	state.view.edgeVisibility.reads = true;
	state.view.edgeVisibility.writes = true;
	state.view.edgeVisibility['file-dependency'] = true;

	if (elements.searchInput) {
		elements.searchInput.value = '';
	}

	if (elements.edgeBudget) {
		elements.edgeBudget.value = String(MAX_VISIBLE_EDGES);
	}

	updateFilterControlStates();
}

function applyLargeGraphDefaults() {
	if (!state.largeGraphMode) {
		return;
	}

	state.view.edgeBudget = Math.max(MIN_EDGE_BUDGET, Math.min(MAX_VISIBLE_EDGES, LARGE_GRAPH_INITIAL_EDGE_BUDGET));
	state.view.smartLabels = true;
	state.view.edgeVisibility.calls = true;
	state.view.edgeVisibility.implements = true;
	state.view.edgeVisibility.reads = false;
	state.view.edgeVisibility.writes = false;
	state.view.edgeVisibility['file-dependency'] = false;
	updateFilterControlStates();
}

function toggleEdgeVisibility(edgeType) {
	if (!Object.prototype.hasOwnProperty.call(state.view.edgeVisibility, edgeType)) {
		return;
	}

	state.view.edgeVisibility[edgeType] = !state.view.edgeVisibility[edgeType];
	updateFilterControlStates();
	renderVisibleGraph({ refreshElements: false, relayout: false });
}

function updateEdgeToggleButton(button, label, edgeType) {
	if (!button) {
		return;
	}

	const isVisible = state.view.edgeVisibility[edgeType] !== false;
	button.dataset.active = isVisible ? 'true' : 'false';
	button.textContent = `${label}: ${isVisible ? 'On' : 'Off'}`;
	button.setAttribute('aria-checked', isVisible ? 'true' : 'false');
}

function applyAdaptiveDetailMode() {
	if (!state.cy) {
		return;
	}

	const cy = state.cy;
	const nodes = cy.nodes();
	const edges = cy.edges();

	if (!state.view.smartLabels) {
		nodes.removeClass('label-hidden');
		edges.removeClass('edge-low-detail');
		return;
	}

	const zoomThreshold = state.largeGraphMode ? 0.72 : LOW_DETAIL_ZOOM_THRESHOLD;
	const nodeThreshold = state.largeGraphMode ? 120 : LOW_DETAIL_NODE_THRESHOLD;
	const edgeThreshold = state.largeGraphMode ? 300 : LOW_DETAIL_EDGE_THRESHOLD;
	const emphasisDegreeThreshold = state.largeGraphMode ? 12 : 8;

	const shouldReduceDetail = cy.zoom() < zoomThreshold && nodes.length > nodeThreshold;
	if (!shouldReduceDetail) {
		nodes.removeClass('label-hidden');
		edges.removeClass('edge-low-detail');
		return;
	}

	const emphasizedNodes = nodes
		.filter((node) => node.isParent() || Number(node.data('degree') || 0) >= emphasisDegreeThreshold)
		.union(cy.$('.is-focused').nodes());

	nodes.addClass('label-hidden');
	emphasizedNodes.removeClass('label-hidden');

	if (edges.length > edgeThreshold) {
		edges.addClass('edge-low-detail');
	} else {
		edges.removeClass('edge-low-detail');
	}
}

function ensureKeyboardFocusNode() {
	if (!state.cy) {
		return;
	}

	const current = state.keyboardNodeId ? state.cy.getElementById(state.keyboardNodeId) : undefined;
	if (current && current.isNode && current.isNode() && current.visible()) {
		return;
	}

	const firstVisible = state.cy.nodes(':visible').first();
	if (!firstVisible || !firstVisible.isNode || !firstVisible.isNode()) {
		state.keyboardNodeId = '';
		return;
	}

	state.keyboardNodeId = firstVisible.id();
}

function updateLoadMoreButton() {
	if (!elements.loadMore) {
		return;
	}

	const remaining = state.loadState.remainingCount;
	const canLoadMore = state.loadState.canLoadMore;

	elements.loadMore.disabled = !canLoadMore;
	elements.loadMore.textContent = canLoadMore ? `Load More (${remaining})` : 'All Nodes Loaded';
}

function sanitizeLoadState(loadState) {
	const remainingCount = Number.isFinite(loadState && loadState.remainingCount)
		? Math.max(0, Number(loadState.remainingCount))
		: 0;

	return {
		remainingCount,
		canLoadMore: Boolean(loadState && loadState.canLoadMore && remainingCount > 0),
		wasTruncated: Boolean(loadState && loadState.wasTruncated),
	};
}

function sanitizeTotals(totals, payload) {
	const fallbackNodeCount = payload && Array.isArray(payload.nodes) ? payload.nodes.length : 0;
	const fallbackEdgeCount = payload && Array.isArray(payload.edges) ? payload.edges.length : 0;

	const totalNodeCount = Number.isFinite(totals && totals.totalNodeCount)
		? Math.max(0, Number(totals.totalNodeCount))
		: fallbackNodeCount;
	const totalEdgeCount = Number.isFinite(totals && totals.totalEdgeCount)
		? Math.max(0, Number(totals.totalEdgeCount))
		: fallbackEdgeCount;

	return {
		totalNodeCount,
		totalEdgeCount,
	};
}

function isLargeGraph(totals) {
	if (!totals) {
		return false;
	}

	return totals.totalNodeCount >= LARGE_GRAPH_NODE_THRESHOLD || totals.totalEdgeCount >= LARGE_GRAPH_EDGE_THRESHOLD;
}

function scheduleViewportInteractionEdgeHiding() {
	if (!state.cy || !state.largeGraphMode) {
		return;
	}

	if (!state.interactionEdgesHidden) {
		state.interactionEdgesHidden = true;
		state.cy.edges().addClass('hidden-by-viewport');
	}

	if (state.interactionEdgeHideTimeout) {
		clearTimeout(state.interactionEdgeHideTimeout);
	}

	state.interactionEdgeHideTimeout = window.setTimeout(() => {
		state.interactionEdgeHideTimeout = undefined;
		state.interactionEdgesHidden = false;

		if (!state.cy) {
			return;
		}

		state.cy.edges().removeClass('hidden-by-viewport');
		applyAdaptiveDetailMode();
	}, INTERACTION_EDGE_HIDE_IDLE_MS);
}

function bindOverflowMenuInteractions() {
	if (!elements.menuToggle || !elements.overflowMenu) {
		return;
	}

	document.addEventListener('click', (event) => {
		if (!isOverflowMenuOpen()) {
			return;
		}

		const target = event.target;
		if (!(target instanceof Node)) {
			return;
		}

		if (elements.menuToggle.contains(target) || elements.overflowMenu.contains(target)) {
			return;
		}

		setOverflowMenuOpen(false);
	});

	document.addEventListener('keydown', (event) => {
		if (!isOverflowMenuOpen()) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			setOverflowMenuOpen(false);
			elements.menuToggle.focus();
		}
	});

	elements.menuToggle.addEventListener('keydown', (event) => {
		if (event.key !== 'ArrowDown') {
			return;
		}

		event.preventDefault();
		setOverflowMenuOpen(true);
		focusFirstMenuButton();
	});
}

function isOverflowMenuOpen() {
	return Boolean(elements.overflowMenu && !elements.overflowMenu.hidden);
}

function toggleOverflowMenu() {
	setOverflowMenuOpen(!isOverflowMenuOpen());

	if (isOverflowMenuOpen()) {
		focusFirstMenuButton();
	}
}

function setOverflowMenuOpen(isOpen) {
	if (!elements.menuToggle || !elements.overflowMenu) {
		return;
	}

	elements.overflowMenu.hidden = !isOpen;
	elements.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function focusFirstMenuButton() {
	if (!elements.overflowMenu) {
		return;
	}

	const firstButton = elements.overflowMenu.querySelector('button');
	if (firstButton instanceof HTMLElement) {
		firstButton.focus();
	}
}

function toggleTopBarsVisibility() {
	setTopBarsVisibility(!state.topBarsVisible);
}

function setTopBarsVisibility(isVisible) {
	state.topBarsVisible = Boolean(isVisible);

	if (!state.topBarsVisible && isOverflowMenuOpen()) {
		setOverflowMenuOpen(false);
	}

	if (elements.app) {
		elements.app.classList.toggle('top-bars-hidden', !state.topBarsVisible);
	}

	const activeElement = document.activeElement;
	if (!state.topBarsVisible
		&& activeElement instanceof HTMLElement
		&& ((elements.densityControls && elements.densityControls.contains(activeElement))
			|| (elements.menuToggle && elements.menuToggle.contains(activeElement))
			|| (elements.overflowMenu && elements.overflowMenu.contains(activeElement)))) {
		if (elements.topBarsToggle) {
			elements.topBarsToggle.focus();
		}
	}

	updateTopBarsToggleState();
}

function updateTopBarsToggleState() {
	if (!elements.topBarsToggle) {
		return;
	}

	const isVisible = state.topBarsVisible;
	elements.topBarsToggle.innerHTML = isVisible ? '&#9650;' : '&#9660;';
	elements.topBarsToggle.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
	elements.topBarsToggle.setAttribute('aria-label', isVisible ? 'Hide top bars' : 'Show top bars');
	elements.topBarsToggle.title = isVisible ? 'Hide top bars' : 'Show top bars';
	elements.topBarsToggle.dataset.active = isVisible ? 'false' : 'true';
}

function bindWheelZoomBehavior() {
	if (!elements.graph) {
		return;
	}

	elements.graph.addEventListener('wheel', (event) => {
		if (!state.cy) {
			return;
		}

		event.preventDefault();

		const nextZoom = computeWheelZoomTarget(state.cy.zoom(), event);
		if (Math.abs(nextZoom - state.cy.zoom()) < 0.0001) {
			return;
		}

		applyZoomAtRenderedPosition(nextZoom, getRenderedPositionFromPointer(event));
	}, { passive: false });
}

function computeWheelZoomTarget(currentZoom, event) {
	let delta = Number(event.deltaY) || 0;

	if (event.deltaMode === 1) {
		delta *= WHEEL_LINE_HEIGHT_PX;
	} else if (event.deltaMode === 2) {
		delta *= window.innerHeight;
	}

	const boundedDelta = clamp(delta, -WHEEL_ZOOM_MAX_DELTA, WHEEL_ZOOM_MAX_DELTA);
	const zoomFactor = Math.exp(-boundedDelta * WHEEL_ZOOM_SPEED);
	const targetZoom = currentZoom * zoomFactor;
	return clamp(targetZoom, MIN_ZOOM, MAX_ZOOM);
}

function getRenderedPositionFromPointer(event) {
	if (!elements.graph) {
		return { x: 0, y: 0 };
	}

	const rect = elements.graph.getBoundingClientRect();
	return {
		x: event.clientX - rect.left,
		y: event.clientY - rect.top,
	};
}

function getMindMapTypeWeight(type) {
	if (type === 'file') {
		return 18;
	}

	if (type === 'class') {
		return 10;
	}

	if (type === 'function') {
		return 7;
	}

	if (type === 'method') {
		return 5;
	}

	return 2;
}

function setNotice(message) {
	if (elements.notice) {
		elements.notice.textContent = message;
	}
}

function applyZoomStep(direction) {
	if (!state.cy) {
		return;
	}

	const current = state.cy.zoom();
	const target = direction > 0
		? findNextZoomStop(current)
		: findPreviousZoomStop(current);

	if (Math.abs(target - current) < 0.0001) {
		return;
	}

	applyZoomAtRenderedPosition(target, getViewportCenter());
}

function findNextZoomStop(currentZoom) {
	for (const stop of ZOOM_LEVEL_STOPS) {
		if (stop > (currentZoom + 0.0001)) {
			return stop;
		}
	}

	return MAX_ZOOM;
}

function findPreviousZoomStop(currentZoom) {
	for (let index = ZOOM_LEVEL_STOPS.length - 1; index >= 0; index -= 1) {
		const stop = ZOOM_LEVEL_STOPS[index];
		if (stop < (currentZoom - 0.0001)) {
			return stop;
		}
	}

	return MIN_ZOOM;
}

function applyZoomAtRenderedPosition(targetZoom, renderedPosition) {
	if (!state.cy) {
		return;
	}

	state.cy.zoom({
		level: clamp(targetZoom, MIN_ZOOM, MAX_ZOOM),
		renderedPosition,
	});
}

function getViewportCenter() {
	if (!elements.graph) {
		return { x: 0, y: 0 };
	}

	const rect = elements.graph.getBoundingClientRect();
	return {
		x: rect.width / 2,
		y: rect.height / 2,
	};
}

function updateZoomLevel(zoomValue) {
	if (elements.zoomLevel) {
		elements.zoomLevel.textContent = `${Math.round(zoomValue * 100)}%`;
	}
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function bindClick(element, callback) {
	if (!element) {
		return;
	}

	element.addEventListener('click', callback);
}

function buildNodeLabel(node) {
	const prefix = LABEL_PREFIX[node.type] || 'Symbol';
	return `${prefix}: ${node.name}`;
}

function updateDirectionButton() {
	if (!elements.directionToggle) {
		return;
	}

	const isTopToBottom = state.layoutDirection === 'TB';
	elements.directionToggle.textContent = `Direction: ${isTopToBottom ? 'TB' : 'LR'}`;
	elements.directionToggle.dataset.active = isTopToBottom ? 'false' : 'true';
	elements.directionToggle.disabled = state.layoutMode !== 'dag';
	elements.directionToggle.setAttribute('aria-pressed', isTopToBottom ? 'false' : 'true');
	elements.directionToggle.title = state.layoutMode === 'dag'
		? 'Set DAG rank direction'
		: 'Direction applies to DAG view only';
}

function updateViewToggleButton() {
	if (!elements.viewToggle) {
		return;
	}

	const isMindMap = state.layoutMode === 'mindmap';
	elements.viewToggle.textContent = `View: ${isMindMap ? 'Mind Map' : 'DAG'}`;
	elements.viewToggle.dataset.active = isMindMap ? 'false' : 'true';
	elements.viewToggle.setAttribute('aria-pressed', isMindMap ? 'false' : 'true');
}

function readThemeTokens() {
	const styles = getComputedStyle(document.documentElement);
	const valueOrFallback = (name, fallback) => {
		const value = styles.getPropertyValue(name).trim();
		return value || fallback;
	};

	return {
		fontFamily: valueOrFallback('--vscode-font-family', 'sans-serif'),
		text: valueOrFallback('--vscode-editor-foreground', '#d4d4d4'),
		focus: valueOrFallback('--vscode-focusBorder', '#60a5fa'),
		compound: {
			fill: valueOrFallback('--vscode-panelTitle-activeForeground', '#60a5fa'),
			border: valueOrFallback('--vscode-editorInfo-foreground', '#3b82f6'),
			label: valueOrFallback('--vscode-descriptionForeground', '#94a3b8'),
		},
		node: {
			file: {
				bg: valueOrFallback('--vscode-symbolIcon-fileForeground', '#0f766e'),
				border: valueOrFallback('--vscode-symbolIcon-moduleForeground', '#2dd4bf'),
			},
			class: {
				bg: valueOrFallback('--vscode-symbolIcon-classForeground', '#0284c7'),
				border: valueOrFallback('--vscode-symbolIcon-interfaceForeground', '#38bdf8'),
			},
			function: {
				bg: valueOrFallback('--vscode-symbolIcon-functionForeground', '#2563eb'),
				border: valueOrFallback('--vscode-symbolIcon-methodForeground', '#60a5fa'),
			},
			method: {
				bg: valueOrFallback('--vscode-symbolIcon-methodForeground', '#7c3aed'),
				border: valueOrFallback('--vscode-symbolIcon-constructorForeground', '#a78bfa'),
			},
			variable: {
				bg: valueOrFallback('--vscode-symbolIcon-variableForeground', '#a16207'),
				border: valueOrFallback('--vscode-symbolIcon-fieldForeground', '#f59e0b'),
			},
		},
		edge: {
			default: valueOrFallback('--vscode-descriptionForeground', '#6b7280'),
			calls: valueOrFallback('--vscode-editorInfo-foreground', '#38bdf8'),
			implements: valueOrFallback('--vscode-symbolIcon-interfaceForeground', '#f59e0b'),
			reads: valueOrFallback('--vscode-terminal-ansiGreen', '#22c55e'),
			writes: valueOrFallback('--vscode-editorError-foreground', '#ef4444'),
			fileDependency: valueOrFallback('--vscode-terminal-ansiCyan', '#14b8a6'),
			containment: valueOrFallback('--vscode-disabledForeground', '#94a3b8'),
		},
	};
}

function syncLegendColors() {
	if (!state.theme) {
		return;
	}

	const styles = {
		file: state.theme.node.file,
		class: state.theme.node.class,
		function: state.theme.node.function,
		method: state.theme.node.method,
		variable: state.theme.node.variable,
	};

	for (const swatch of elements.legendSwatches) {
		const type = swatch.getAttribute('data-node-type');
		const style = type ? styles[type] : undefined;
		if (!style) {
			continue;
		}

		swatch.style.backgroundColor = style.bg;
		swatch.style.borderColor = style.border;
	}
}

function showTooltip(node, event) {
	if (!elements.tooltip) {
		return;
	}

	const data = node.data();
	const lineLabel = Number.isFinite(data.line) ? data.line : '-';
	elements.tooltip.innerHTML = [
		`<strong>${escapeHtml(data.fullName || data.label || node.id())}</strong>`,
		`<div class="tooltip-meta">${escapeHtml(data.filePath || 'Unknown file')}</div>`,
		`<div class="tooltip-meta">Line: ${escapeHtml(String(lineLabel))}</div>`,
		`<div class="tooltip-hint"><i>${escapeHtml(getOpenHintText())}</i></div>`,
	].join('');
	elements.tooltip.hidden = false;
	moveTooltip(event);
}

function getOpenHintText() {
	const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
	return `${isMac ? 'Cmd' : 'Ctrl'}+Click or Alt+Click to open code`;
}

function moveTooltip(event) {
	if (!elements.tooltip || elements.tooltip.hidden) {
		return;
	}

	const offset = 16;
	const tooltipRect = elements.tooltip.getBoundingClientRect();
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	let x = 0;
	let y = 0;
	if (event && event.originalEvent) {
		x = event.originalEvent.clientX;
		y = event.originalEvent.clientY;
	}

	if (!x && !y && event && event.renderedPosition && elements.graph) {
		const graphRect = elements.graph.getBoundingClientRect();
		x = graphRect.left + event.renderedPosition.x;
		y = graphRect.top + event.renderedPosition.y;
	}

	let left = x + offset;
	let top = y + offset;

	if (left + tooltipRect.width + 8 > viewportWidth) {
		left = x - tooltipRect.width - offset;
	}

	if (top + tooltipRect.height + 8 > viewportHeight) {
		top = y - tooltipRect.height - offset;
	}

	elements.tooltip.style.left = `${Math.max(8, left)}px`;
	elements.tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
	if (!elements.tooltip) {
		return;
	}

	elements.tooltip.hidden = true;
}

function escapeHtml(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
