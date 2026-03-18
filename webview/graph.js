/* global cytoscape cytoscapeDagre acquireVsCodeApi */

const vscode = acquireVsCodeApi();

const MAX_VISIBLE_EDGES = 22000;
const MIN_EDGE_BUDGET = 1500;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP_FACTOR = 1.1;
const ZOOM_ANIMATION_MS = 180;
const SEARCH_INPUT_DEBOUNCE_MS = 150;
const LOW_DETAIL_ZOOM_THRESHOLD = 0.52;
const LOW_DETAIL_NODE_THRESHOLD = 180;
const LOW_DETAIL_EDGE_THRESHOLD = 420;

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
	collapsedCompoundIds: new Set(),
	layoutDirection: 'TB',
	layoutMode: 'mindmap',
	dagreRegistered: false,
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
		hideStructuralEdges: false,
		hideVariables: false,
		smartLabels: true,
		searchQuery: '',
	},
	viewStats: {
		visibleNodeCount: 0,
		visibleEdgeCount: 0,
		renderedEdgeCount: 0,
		truncatedByEdgeBudget: false,
	},
	searchDebounceHandle: undefined,
};

const elements = {
	graph: document.getElementById('graph'),
	summary: document.getElementById('summary'),
	notice: document.getElementById('notice'),
	searchInput: document.getElementById('graph-search'),
	edgeBudget: document.getElementById('edge-budget'),
	edgeBudgetValue: document.getElementById('edge-budget-value'),
	toggleContainment: document.getElementById('toggle-containment'),
	toggleVariables: document.getElementById('toggle-variables'),
	toggleSmartLabels: document.getElementById('toggle-smart-labels'),
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
	legendSwatches: document.querySelectorAll('.legend-swatch'),
};

window.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || (message.type !== 'setGraphData' && message.type !== 'appendGraphData')) {
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
});

bindClick(elements.expandAll, () => {
	state.collapsedCompoundIds.clear();
	applyCollapsedState();
	runLayout(false);
});

bindClick(elements.toggleContainment, () => {
	state.view.hideStructuralEdges = !state.view.hideStructuralEdges;
	updateFilterControlStates();
	renderVisibleGraph();
});

bindClick(elements.toggleVariables, () => {
	state.view.hideVariables = !state.view.hideVariables;
	updateFilterControlStates();
	renderVisibleGraph();
});

bindClick(elements.toggleSmartLabels, () => {
	state.view.smartLabels = !state.view.smartLabels;
	updateFilterControlStates();
	applyAdaptiveDetailMode();
});

bindClick(elements.resetFilters, () => {
	resetClarityControls();
	renderVisibleGraph();
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
		renderVisibleGraph();
	});
}

if (elements.searchInput) {
	elements.searchInput.addEventListener('input', () => {
		if (state.searchDebounceHandle) {
			window.clearTimeout(state.searchDebounceHandle);
		}

		state.searchDebounceHandle = window.setTimeout(() => {
			state.view.searchQuery = (elements.searchInput.value || '').trim();
			renderVisibleGraph();
		}, SEARCH_INPUT_DEBOUNCE_MS);
	});
}

resetClarityControls();
updateFilterControlStates();
updateViewToggleButton();
updateDirectionButton();
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

	if (!state.cy) {
		state.cy = createGraphInstance();
		wireInteractions(state.cy);
		syncLegendColors();
	}

	renderVisibleGraph();
	updateLoadMoreButton();
	updateZoomLevel(state.cy.zoom());
	setNotice(buildRenderNotice(getBaseLoadNotice()));
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

	renderVisibleGraph();
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
				selector: '.compound-collapsed-hidden, .hidden-by-collapse',
				style: {
					display: 'none',
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
		const originalEvent = event.originalEvent;
		const isModifiedOpen = Boolean(originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey || originalEvent.altKey));

		applyTraceFocus(node);

		if (!isModifiedOpen || !data.uriString) {
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
		}
	});

	cy.on('zoom', () => {
		scheduleAdaptiveDetailMode(cy.zoom());
		hideTooltip();
	});

	cy.on('pan', () => {
		hideTooltip();
	});
}

function renderVisibleGraph() {
	if (!state.payload || !state.cy) {
		return;
	}

	const filtered = computeFilteredGraphSnapshot();
	const degreeByNodeId = buildNodeDegreeMap(filtered.visibleEdges);
	state.viewStats = {
		visibleNodeCount: filtered.visibleNodes.length,
		visibleEdgeCount: filtered.visibleEdges.length,
		renderedEdgeCount: filtered.renderedEdges.length,
		truncatedByEdgeBudget: filtered.visibleEdges.length > filtered.renderedEdges.length,
	};

	const compoundNodes = buildCompoundNodeDefinitions(filtered.visibleNodes, state.payload.edges);
	const nodeById = new Map(compoundNodes.map((node) => [node.id, node]));

	const cytoscapeElements = [
		...compoundNodes.map((node) => {
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
		}),
		...filtered.renderedEdges.map((edge) => ({
			data: {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				relationship: edge.relationship,
				edgeType: edge.edgeType || edge.relationship,
			},
		})),
	];

	state.cy.batch(() => {
		state.cy.elements().remove();
		state.cy.add(cytoscapeElements);
	});

	updateSummary();
	updateFilterControlStates();
	setNotice(buildRenderNotice(getBaseLoadNotice()));
	applyCollapsedState();
	runLayout(false);
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

	return {
		visibleNodes,
		visibleEdges: filteredEdges,
		renderedEdges,
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

	const nodeCount = state.cy.nodes(':visible').length;
	if (nodeCount === 0) {
		return;
	}

	const shouldAnimate = nodeCount < 2200;
	let layoutOptions;

	if (state.layoutMode === 'dag' && state.dagreRegistered) {
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
	} else {
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

	const layout = state.cy.layout(layoutOptions);

	layout.run();
	applyAdaptiveDetailMode();
}

function applyCollapsedState() {
	if (!state.cy) {
		return;
	}

	const cy = state.cy;
	cy.elements().removeClass('compound-collapsed compound-collapsed-hidden hidden-by-collapse');

	cy.nodes(':parent').forEach((node) => {
		const nodeId = node.id();
		if (!state.collapsedCompoundIds.has(nodeId)) {
			return;
		}

		const descendants = node.descendants();
		node.addClass('compound-collapsed');
		descendants.addClass('compound-collapsed-hidden');
		descendants.connectedEdges().addClass('hidden-by-collapse');
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
		return 'Large graph detected. Use Load More to fetch additional nodes.';
	}

	if (state.loadState.wasTruncated) {
		return 'All available nodes are loaded.';
	}

	return 'Graph loaded.';
}

function buildRenderNotice(baseMessage) {
	const notes = [];

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

	if (notes.length === 0) {
		return baseMessage;
	}

	return `${baseMessage} ${notes.join(' ')}`;
}

function updateFilterControlStates() {
	if (elements.toggleContainment) {
		elements.toggleContainment.dataset.active = state.view.hideStructuralEdges ? 'true' : 'false';
		elements.toggleContainment.textContent = state.view.hideStructuralEdges ? 'Structural Hidden' : 'Hide Structural Edges';
	}

	if (elements.toggleVariables) {
		elements.toggleVariables.dataset.active = state.view.hideVariables ? 'true' : 'false';
		elements.toggleVariables.textContent = state.view.hideVariables ? 'Variables Hidden' : 'Hide Variables';
	}

	if (elements.toggleSmartLabels) {
		elements.toggleSmartLabels.dataset.active = state.view.smartLabels ? 'true' : 'false';
		elements.toggleSmartLabels.textContent = `Smart Labels: ${state.view.smartLabels ? 'On' : 'Off'}`;
	}

	if (elements.edgeBudget) {
		elements.edgeBudget.value = String(state.view.edgeBudget);
	}

	updateEdgeBudgetLabel();
}

function updateEdgeBudgetLabel() {
	if (!elements.edgeBudgetValue) {
		return;
	}

	elements.edgeBudgetValue.textContent = `${state.view.edgeBudget.toLocaleString()}`;
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

	if (elements.searchInput) {
		elements.searchInput.value = '';
	}

	if (elements.edgeBudget) {
		elements.edgeBudget.value = String(MAX_VISIBLE_EDGES);
	}

	updateFilterControlStates();
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

	const shouldReduceDetail = cy.zoom() < LOW_DETAIL_ZOOM_THRESHOLD && nodes.length > LOW_DETAIL_NODE_THRESHOLD;
	if (!shouldReduceDetail) {
		nodes.removeClass('label-hidden');
		edges.removeClass('edge-low-detail');
		return;
	}

	const emphasizedNodes = nodes
		.filter((node) => node.isParent() || Number(node.data('degree') || 0) >= 8)
		.union(cy.$('.is-focused').nodes());

	nodes.addClass('label-hidden');
	emphasizedNodes.removeClass('label-hidden');

	if (edges.length > LOW_DETAIL_EDGE_THRESHOLD) {
		edges.addClass('edge-low-detail');
	} else {
		edges.removeClass('edge-low-detail');
	}
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
