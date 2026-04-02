// webview/sigmaRenderer.js
// Sigma.js + Graphology-based graph renderer for VSContext
// Runs in the VS Code webview browser context
// Dependencies: window.Sigma, window.graphology, window.dagre

(function () {
  "use strict";

  const NODE_COLORS = {
    file: "#1e3a5f",
    class: "#7c3aed",
    function: "#2563eb",
    method: "#0891b2",
    variable: "#059669",
    interface: "#a855f7",
    enum: "#d97706",
    namespace: "#64748b",
    module: "#0f766e",
    typeAlias: "#8b5cf6",
    constant: "#ea580c",
    field: "#06b6d4",
    property: "#14b8a6",
    default: "#2563eb",
  };

  const EDGE_COLORS = {
    calls: "#3b82f6",
    implements: "#10b981",
    reads: "#f59e0b",
    writes: "#ef4444",
    "file-dependency": "#94a3b8",
    "file-class": "#6d28d9",
    "file-method": "#0369a1",
    "file-function": "#1d4ed8",
    "file-variable": "#047857",
    "class-method": "#7e22ce",
    "function-variable": "#065f46",
    "method-variable": "#164e63",
    imports: "#94a3b8",
    covers: "#84cc16",
    documents: "#64748b",
    "related-to": "#94a3b8",
  };

  const NODE_SIZES = {
    file: 18,
    class: 14,
    function: 10,
    method: 10,
    variable: 7,
    interface: 13,
    enum: 13,
    namespace: 12,
    module: 12,
    typeAlias: 11,
    constant: 8,
    field: 8,
    property: 8,
    default: 10,
  };

  const STRUCTURAL_EDGE_TYPES = new Set([
    "file-class",
    "file-method",
    "file-function",
    "file-variable",
    "class-method",
    "function-variable",
    "method-variable",
  ]);

  const CLARITY_EDGE_TYPES = new Set([
    "calls",
    "implements",
    "reads",
    "writes",
    "file-dependency",
    "imports",
    "covers",
    "documents",
    "related-to",
    "file-class",
    "file-method",
    "file-function",
    "file-variable",
    "class-method",
    "function-variable",
    "method-variable",
  ]);

  class SigmaRenderer {
    constructor(container) {
      this.container = container;
      this.sigma = null;
      this.graph = null;
      this.layoutMode = "hierarchical";
      this.dagDirection = "TB";
      this.filters = {
        hideStructural: false,
        hideVariables: false,
        hiddenEdgeTypes: new Set(),
      };
      this.edgeBudget = 22000;
      this.searchQuery = "";
      this.highlightedNodes = new Set();
      this.currentPayload = null;
      this.onOpenNode = null;
      this.onCameraUpdate = null;
      this._focusedNodeId = null;
      this._lastAppliedNodeCount = 0;
      this._resizeObserver = null;
    }

    initialize() {
      if (typeof graphology === "undefined") {
        console.error("[VSContext] graphology is not loaded.");
        return;
      }
      if (typeof Sigma === "undefined") {
        console.error("[VSContext] Sigma is not loaded.");
        return;
      }

      const GraphClass = graphology.Graph || graphology.default || graphology;
      this.graph = new GraphClass({
        multi: false,
        type: "directed",
        allowSelfLoops: false,
      });

      try {
        this.sigma = new Sigma(this.graph, this.container, {
          renderEdgeLabels: false,
          allowInvalidContainer: true,
          defaultEdgeType: "arrow",
          labelFont: "monospace",
          labelSize: 11,
          labelWeight: "normal",
          labelColor: { color: "#e2e8f0" },
          edgeLabelFont: "monospace",
          edgeLabelSize: 9,
          stagePadding: 60,
          zoomingRatio: 1.15,
          minCameraRatio: 0.05,
          maxCameraRatio: 10,
          defaultNodeColor: "#2563eb",
          defaultEdgeColor: "#94a3b8",
          itemSizesReference: "positions",
          zoomToSizeRatioFunction: (x) => x,
        });
      } catch (err) {
        console.error("[VSContext] Failed to create Sigma instance:", err);
        return;
      }

      this.sigma.on("clickNode", ({ node }) => {
        this._focusedNodeId = node;
        const attrs = this.graph.getNodeAttributes(node);
        if (this.onOpenNode && attrs.uriString) {
          this.onOpenNode({
            uriString: attrs.uriString,
            line: attrs.line || 1,
            rangeStartLine: attrs.rangeStartLine || 1,
            rangeStartCharacter: attrs.rangeStartCharacter || 0,
            rangeEndLine: attrs.rangeEndLine || 1,
            rangeEndCharacter: attrs.rangeEndCharacter || 0,
          });
        }
      });

      this.sigma.on("enterNode", ({ node }) => {
        this.highlightNeighborhood(node);
      });

      this.sigma.on("leaveNode", () => {
        this.clearHighlight();
      });

      this.sigma.on("doubleClickNode", ({ node }) => {
        this._focusedNodeId = node;
        this.focusNode(node);
      });

      this.sigma.getCamera().on("updated", () => {
        if (typeof this.onCameraUpdate === "function") {
          this.onCameraUpdate(this.getZoomLevel());
        }
      });

      this._ensureResizeObserver();
    }

    setData(nodes, edges) {
      this.currentPayload = { nodes, edges };
      this._focusedNodeId = null;
      this._rebuildGraph(nodes, edges);
      this._applyLayout();
      this.fitView();
    }

    appendData(nodes, edges) {
      if (!this.graph) return;
      this._addNodesToGraph(nodes);
      this._addEdgesToGraph(edges);
      this._applyLayout();
      this._applyVisibility();
      this._fitIfNeeded(nodes.length, edges.length);
    }

    setLayout(type) {
      this.layoutMode = type === "force" ? "force" : "hierarchical";
      this._applyLayout();
    }

    setDagDirection(direction) {
      const allowed = new Set(["TB", "LR", "BT", "RL"]);
      if (allowed.has(direction)) {
        this.dagDirection = direction;
      }
      if (this.layoutMode === "hierarchical") {
        this._applyLayout();
      }
    }

    setFilter(filterName, value) {
      if (filterName === "hideStructural") {
        this.filters.hideStructural = Boolean(value);
      } else if (filterName === "hideVariables") {
        this.filters.hideVariables = Boolean(value);
      }
      this._applyVisibility();
    }

    toggleEdgeType(edgeType, visible) {
      if (visible) {
        this.filters.hiddenEdgeTypes.delete(edgeType);
      } else {
        this.filters.hiddenEdgeTypes.add(edgeType);
      }
      this._applyVisibility();
    }

    setEdgeBudget(budget) {
      const nextBudget = Number.isFinite(budget)
        ? Math.max(0, Math.floor(budget))
        : this.edgeBudget;
      this.edgeBudget = nextBudget;
      this._applyVisibility();
    }

    search(query) {
      this.searchQuery = String(query || "")
        .toLowerCase()
        .trim();
      this.highlightedNodes.clear();

      if (this.searchQuery && this.graph) {
        this.graph.forEachNode((node, attrs) => {
          const label = String(attrs.label || "").toLowerCase();
          const filePath = String(attrs.filePath || "").toLowerCase();
          const nodeType = String(attrs.nodeType || "").toLowerCase();
          if (
            label.includes(this.searchQuery) ||
            filePath.includes(this.searchQuery) ||
            nodeType.includes(this.searchQuery)
          ) {
            this.highlightedNodes.add(node);
          }
        });
      }

      this._applyVisibility();
    }

    fitView() {
      if (!this.sigma) return;
      this.sigma.getCamera().animatedReset({ duration: 300 });
    }

    zoomIn() {
      if (!this.sigma) return;
      const cam = this.sigma.getCamera();
      cam.animatedZoom({ ratio: cam.ratio / 1.5, duration: 200 });
    }

    zoomOut() {
      if (!this.sigma) return;
      const cam = this.sigma.getCamera();
      cam.animatedZoom({ ratio: cam.ratio * 1.5, duration: 200 });
    }

    getZoomLevel() {
      if (!this.sigma) return 100;
      return Math.max(1, Math.round((1 / this.sigma.getCamera().ratio) * 100));
    }

    moveFocus(direction) {
      if (!this.graph || this.graph.order === 0) return null;

      if (!this._focusedNodeId || !this.graph.hasNode(this._focusedNodeId)) {
        const first = this._getFirstVisibleNode();
        if (first) {
          this._focusedNodeId = first;
          this._highlightFocusedNode(first);
          this._panToNode(first);
        }
        return this._buildNavigationTarget(this._focusedNodeId);
      }

      const currentAttrs = this.graph.getNodeAttributes(this._focusedNodeId);
      let bestNode = null;
      let bestScore = Infinity;

      this.graph.forEachNode((node, attrs) => {
        if (node === this._focusedNodeId || attrs.hidden) return;
        if (typeof attrs.x !== "number" || typeof attrs.y !== "number") return;
        if (
          typeof currentAttrs.x !== "number" ||
          typeof currentAttrs.y !== "number"
        ) {
          return;
        }

        const dx = attrs.x - currentAttrs.x;
        const dy = attrs.y - currentAttrs.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return;

        let primaryComponent;
        let secondaryComponent;
        switch (direction) {
          case "ArrowRight":
            primaryComponent = dx;
            secondaryComponent = Math.abs(dy);
            break;
          case "ArrowLeft":
            primaryComponent = -dx;
            secondaryComponent = Math.abs(dy);
            break;
          case "ArrowDown":
            primaryComponent = dy;
            secondaryComponent = Math.abs(dx);
            break;
          case "ArrowUp":
            primaryComponent = -dy;
            secondaryComponent = Math.abs(dx);
            break;
          default:
            return;
        }

        if (primaryComponent <= 0) return;

        const score = dist * 0.7 + secondaryComponent * 0.5;
        if (score < bestScore) {
          bestScore = score;
          bestNode = node;
        }
      });

      if (bestNode) {
        this._focusedNodeId = bestNode;
        this._highlightFocusedNode(bestNode);
        this._panToNode(bestNode);
      }

      return this._buildNavigationTarget(this._focusedNodeId);
    }

    activateFocusedNode() {
      if (!this._focusedNodeId || !this.graph) return null;
      if (!this.graph.hasNode(this._focusedNodeId)) return null;
      return this._buildNavigationTarget(this._focusedNodeId);
    }

    clearFocus() {
      this._focusedNodeId = null;
      this.clearHighlight();
    }

    highlightNeighborhood(nodeId) {
      if (!this.graph || !this.sigma) return;
      const neighbors = this._getNeighborhood(nodeId, 1);
      neighbors.add(nodeId);
      this.graph.forEachNode((node) => {
        this.graph.setNodeAttribute(node, "highlighted", neighbors.has(node));
      });
      this._applyHighlightRendering(neighbors);
    }

    clearHighlight() {
      if (!this.graph || !this.sigma) return;
      this.graph.forEachNode((node) => {
        this.graph.setNodeAttribute(node, "highlighted", false);
      });
      this._clearHighlightRendering();
    }

    focusNode(nodeId) {
      if (!this.sigma || !this.graph) return;
      if (!this.graph.hasNode(nodeId)) return;
      const pos = this.graph.getNodeAttributes(nodeId);
      this._focusedNodeId = nodeId;
      this.sigma.getCamera().animate(
        {
          x: typeof pos.x === "number" ? pos.x : 0,
          y: typeof pos.y === "number" ? pos.y : 0,
          ratio: Math.min(this.sigma.getCamera().ratio, 0.8),
        },
        { duration: 400 },
      );
      this.highlightNeighborhood(nodeId);
    }

    setOpenNodeCallback(fn) {
      this.onOpenNode = fn;
    }

    setCameraUpdateCallback(fn) {
      this.onCameraUpdate = fn;
    }

    dispose() {
      if (this._resizeObserver) {
        try {
          this._resizeObserver.disconnect();
        } catch (_) {}
        this._resizeObserver = null;
      }

      if (this.sigma) {
        try {
          this.sigma.kill();
        } catch (_) {}
        this.sigma = null;
      }
      if (this.graph) {
        try {
          this.graph.clear();
        } catch (_) {}
        this.graph = null;
      }
      this._focusedNodeId = null;
      this.highlightedNodes.clear();
      this.currentPayload = null;
    }

    _rebuildGraph(nodes, edges) {
      if (!this.graph) return;
      this.graph.clear();
      this._addNodesToGraph(nodes);
      this._addEdgesToGraph(edges);
      this._lastAppliedNodeCount = this.graph.order;
    }

    _addNodesToGraph(nodes) {
      if (!this.graph) return;
      for (const node of nodes || []) {
        if (!node || !node.id || this.graph.hasNode(node.id)) continue;
        const nodeType = this._normalizeNodeType(node.type);
        this.graph.addNode(node.id, {
          label: node.name || node.symbolName || node.id,
          color: NODE_COLORS[nodeType] || NODE_COLORS.default,
          size: NODE_SIZES[nodeType] || NODE_SIZES.default,
          x: Math.random() * 1000 - 500,
          y: Math.random() * 1000 - 500,
          uriString: node.uriString || "",
          line: node.line || 1,
          rangeStartLine: node.rangeStartLine || 1,
          rangeStartCharacter: node.rangeStartCharacter || 0,
          rangeEndLine: node.rangeEndLine || 1,
          rangeEndCharacter: node.rangeEndCharacter || 0,
          nodeType,
          filePath: node.filePath || "",
          degree: node.degree || 0,
          hidden: false,
          highlighted: false,
          dimmed: false,
        });
      }
    }

    _addEdgesToGraph(edges) {
      if (!this.graph) return;
      for (const edge of edges || []) {
        if (!edge || !edge.source || !edge.target) continue;
        if (
          !this.graph.hasNode(edge.source) ||
          !this.graph.hasNode(edge.target)
        ) {
          continue;
        }

        const relationship = this._normalizeRelationship(edge.relationship);
        const edgeKey =
          edge.id || `${edge.source}=>${edge.target}::${relationship}`;
        if (this.graph.hasEdge(edgeKey)) continue;

        try {
          this.graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
            color: EDGE_COLORS[relationship] || EDGE_COLORS["related-to"],
            relationship,
            size: 1.5,
            hidden: false,
          });
        } catch (_) {}
      }
    }

    _applyLayout() {
      if (!this.graph || !this.sigma) return;
      if (this.graph.order === 0) return;

      if (this.layoutMode === "hierarchical") {
        this._applyDagreLayout();
      } else {
        this._applyForceLayout();
      }

      this._applyVisibility();
      this.sigma.refresh();
    }

    _applyDagreLayout() {
      if (typeof dagre === "undefined" || !this.graph) {
        this._applyCircularLayout();
        return;
      }

      try {
        const layoutGraph = new dagre.graphlib.Graph();
        layoutGraph.setGraph({
          rankdir: this.dagDirection,
          nodesep: 50,
          ranksep: 90,
          marginx: 20,
          marginy: 20,
        });
        layoutGraph.setDefaultEdgeLabel(() => ({}));

        this.graph.forEachNode((node, attrs) => {
          if (!attrs.hidden) {
            const labelWidth = Math.max(
              60,
              attrs.label ? attrs.label.length * 7 : 60,
            );
            layoutGraph.setNode(node, { width: labelWidth, height: 30 });
          }
        });

        this.graph.forEachEdge((edge, attrs, source, target) => {
          if (
            !attrs.hidden &&
            layoutGraph.hasNode(source) &&
            layoutGraph.hasNode(target)
          ) {
            layoutGraph.setEdge(source, target);
          }
        });

        dagre.layout(layoutGraph);

        layoutGraph.nodes().forEach((node) => {
          if (this.graph.hasNode(node)) {
            const pos = layoutGraph.node(node);
            if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
              this.graph.setNodeAttribute(node, "x", pos.x);
              this.graph.setNodeAttribute(node, "y", pos.y);
            }
          }
        });

        this.graph.forEachNode((node, attrs) => {
          if (attrs.hidden && !layoutGraph.hasNode(node)) {
            this.graph.setNodeAttribute(node, "x", -99999);
            this.graph.setNodeAttribute(node, "y", -99999);
          }
        });
      } catch (err) {
        console.warn(
          "[VSContext] Dagre layout failed, falling back to circular:",
          err,
        );
        this._applyCircularLayout();
      }
    }

    _applyForceLayout() {
      if (!this.graph) return;
      const nodeCount = this.graph.order;
      if (nodeCount === 0) return;

      const area = nodeCount * 15000;
      const k = Math.sqrt(area / nodeCount);
      const pos = {};

      this.graph.forEachNode((node, attrs) => {
        pos[node] = {
          x:
            typeof attrs.x === "number" && Math.abs(attrs.x) < 500000
              ? attrs.x
              : (Math.random() - 0.5) * k * 10,
          y:
            typeof attrs.y === "number" && Math.abs(attrs.y) < 500000
              ? attrs.y
              : (Math.random() - 0.5) * k * 10,
          vx: 0,
          vy: 0,
        };
      });

      const iterations = Math.min(
        100,
        Math.max(30, Math.floor(5000 / nodeCount)),
      );
      let temperature = k * 2;
      const cooling = temperature / (iterations + 1);
      const nodeIds = Object.keys(pos);

      for (let iter = 0; iter < iterations; iter++) {
        for (const u of nodeIds) {
          pos[u].vx = 0;
          pos[u].vy = 0;
        }

        for (let i = 0; i < nodeIds.length; i++) {
          const u = nodeIds[i];
          for (let j = i + 1; j < nodeIds.length; j++) {
            const v = nodeIds[j];
            const dx = pos[u].x - pos[v].x;
            const dy = pos[u].y - pos[v].y;
            const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
            const repulsion = (k * k) / dist;
            const fx = (dx / dist) * repulsion;
            const fy = (dy / dist) * repulsion;
            pos[u].vx += fx;
            pos[u].vy += fy;
            pos[v].vx -= fx;
            pos[v].vy -= fy;
          }
        }

        this.graph.forEachEdge((edge, attrs, source, target) => {
          if (!pos[source] || !pos[target]) return;
          const dx = pos[source].x - pos[target].x;
          const dy = pos[source].y - pos[target].y;
          const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
          const attraction = (dist * dist) / k;
          const fx = (dx / dist) * attraction;
          const fy = (dy / dist) * attraction;
          pos[source].vx -= fx;
          pos[source].vy -= fy;
          pos[target].vx += fx;
          pos[target].vy += fy;
        });

        for (const nodeId of nodeIds) {
          const magnitude = Math.sqrt(
            pos[nodeId].vx ** 2 + pos[nodeId].vy ** 2,
          );
          if (magnitude > 0) {
            pos[nodeId].x +=
              (pos[nodeId].vx / magnitude) * Math.min(magnitude, temperature);
            pos[nodeId].y +=
              (pos[nodeId].vy / magnitude) * Math.min(magnitude, temperature);
          }
        }

        temperature = Math.max(0.1, temperature - cooling);
      }

      for (const [node, p] of Object.entries(pos)) {
        if (this.graph.hasNode(node)) {
          this.graph.setNodeAttribute(node, "x", p.x);
          this.graph.setNodeAttribute(node, "y", p.y);
        }
      }
    }

    _applyCircularLayout() {
      if (!this.graph) return;
      let i = 0;
      const count = this.graph.order;
      if (count === 0) return;
      const radius = Math.max(200, count * 30);
      this.graph.forEachNode((node) => {
        const angle = (2 * Math.PI * i) / count;
        this.graph.setNodeAttribute(node, "x", radius * Math.cos(angle));
        this.graph.setNodeAttribute(node, "y", radius * Math.sin(angle));
        i += 1;
      });
    }

    _applyVisibility() {
      if (!this.graph || !this.sigma) return;

      const visibleEdgeTypes = CLARITY_EDGE_TYPES;
      let visibleEdgeCount = 0;

      this.graph.forEachEdge((edge, attrs) => {
        const relationship = String(attrs.relationship || "");
        let shouldHide = false;

        if (
          this.filters.hideStructural &&
          STRUCTURAL_EDGE_TYPES.has(relationship)
        ) {
          shouldHide = true;
        }

        if (this.filters.hiddenEdgeTypes.has(relationship)) {
          shouldHide = true;
        }

        if (!visibleEdgeTypes.has(relationship)) {
          shouldHide = false;
        }

        const overBudget = !shouldHide && visibleEdgeCount >= this.edgeBudget;
        const hidden = shouldHide || overBudget;
        this.graph.setEdgeAttribute(edge, "hidden", hidden);
        this.graph.setEdgeAttribute(
          edge,
          "color",
          hidden
            ? this._dimColor(
                EDGE_COLORS[relationship] || EDGE_COLORS["related-to"],
                0.35,
              )
            : EDGE_COLORS[relationship] || EDGE_COLORS["related-to"],
        );
        if (!hidden) {
          visibleEdgeCount += 1;
        }
      });

      this.graph.forEachNode((node, attrs) => {
        let shouldHide = false;

        if (this.filters.hideVariables && attrs.nodeType === "variable") {
          shouldHide = true;
        }

        if (this.searchQuery && this.highlightedNodes.size > 0) {
          shouldHide = shouldHide || !this.highlightedNodes.has(node);
        }

        this.graph.setNodeAttribute(node, "hidden", shouldHide);
        this.graph.setNodeAttribute(
          node,
          "color",
          shouldHide
            ? this._dimColor(
                NODE_COLORS[attrs.nodeType] || NODE_COLORS.default,
                0.3,
              )
            : NODE_COLORS[attrs.nodeType] || NODE_COLORS.default,
        );
      });

      this._updateAccessibilityState();
      this.sigma.refresh();
    }

    _applyHighlightRendering(neighborSet) {
      if (!this.graph || !this.sigma) return;
      this.graph.forEachNode((node, attrs) => {
        if (attrs.hidden) return;
        const baseColor = NODE_COLORS[attrs.nodeType] || NODE_COLORS.default;
        this.graph.setNodeAttribute(
          node,
          "color",
          neighborSet.has(node) ? baseColor : this._dimColor(baseColor, 0.18),
        );
        this.graph.setNodeAttribute(
          node,
          "dimmed",
          !neighborSet.has(node) && node !== this._focusedNodeId,
        );
      });
      this.graph.forEachEdge((edge, attrs, source, target) => {
        if (attrs.hidden) return;
        const relationship = String(attrs.relationship || "related-to");
        const connected = neighborSet.has(source) && neighborSet.has(target);
        const baseColor =
          EDGE_COLORS[relationship] || EDGE_COLORS["related-to"];
        this.graph.setEdgeAttribute(
          edge,
          "color",
          connected ? baseColor : this._dimColor(baseColor, 0.15),
        );
      });
      this.sigma.refresh();
    }

    _clearHighlightRendering() {
      if (!this.graph || !this.sigma) return;
      this.graph.forEachNode((node, attrs) => {
        if (attrs.hidden) return;
        const baseColor = NODE_COLORS[attrs.nodeType] || NODE_COLORS.default;
        this.graph.setNodeAttribute(node, "color", baseColor);
        this.graph.setNodeAttribute(node, "dimmed", false);
      });
      this.graph.forEachEdge((edge, attrs) => {
        if (attrs.hidden) return;
        const relationship = String(attrs.relationship || "related-to");
        this.graph.setEdgeAttribute(
          edge,
          "color",
          EDGE_COLORS[relationship] || EDGE_COLORS["related-to"],
        );
      });
      this.sigma.refresh();
    }

    _highlightFocusedNode(nodeId) {
      if (!this.graph || !this.sigma) return;
      const neighbors = this._getNeighborhood(nodeId, 1);
      neighbors.add(nodeId);
      this._applyHighlightRendering(neighbors);
    }

    _panToNode(nodeId) {
      if (!this.sigma || !this.graph) return;
      if (!this.graph.hasNode(nodeId)) return;
      const attrs = this.graph.getNodeAttributes(nodeId);
      this.sigma.getCamera().animate(
        {
          x: typeof attrs.x === "number" ? attrs.x : 0,
          y: typeof attrs.y === "number" ? attrs.y : 0,
          ratio: Math.min(this.sigma.getCamera().ratio, 0.8),
        },
        { duration: 300 },
      );
    }

    _getFirstVisibleNode() {
      if (!this.graph) return null;
      let firstNode = null;
      this.graph.forEachNode((node, attrs) => {
        if (!firstNode && !attrs.hidden) {
          firstNode = node;
        }
      });
      return firstNode;
    }

    _getNeighborhood(nodeId, depth = 1) {
      const neighbors = new Set();
      if (!this.graph || !nodeId || depth < 0) {
        return neighbors;
      }

      const visited = new Set([nodeId]);
      let frontier = [nodeId];

      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const current of frontier) {
          if (!this.graph.hasNode(current)) continue;
          const adjacent = new Set(this.graph.neighbors(current));
          this.graph.forEachInboundNeighbor(current, (neighbor) =>
            adjacent.add(neighbor),
          );
          this.graph.forEachOutboundNeighbor(current, (neighbor) =>
            adjacent.add(neighbor),
          );
          for (const neighbor of adjacent) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              neighbors.add(neighbor);
              next.push(neighbor);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }

      return neighbors;
    }

    _buildNavigationTarget(nodeId) {
      if (!nodeId || !this.graph || !this.graph.hasNode(nodeId)) return null;
      const attrs = this.graph.getNodeAttributes(nodeId);
      if (!attrs.uriString) return null;
      return {
        uriString: attrs.uriString,
        line: attrs.line || 1,
        rangeStartLine: attrs.rangeStartLine || 1,
        rangeStartCharacter: attrs.rangeStartCharacter || 0,
        rangeEndLine: attrs.rangeEndLine || 1,
        rangeEndCharacter: attrs.rangeEndCharacter || 0,
      };
    }

    _normalizeNodeType(nodeType) {
      const normalized = String(nodeType || "").trim();
      if (!normalized) return "default";
      return Object.prototype.hasOwnProperty.call(NODE_COLORS, normalized)
        ? normalized
        : "default";
    }

    _normalizeRelationship(relationship) {
      const normalized = String(relationship || "").trim();
      if (!normalized) return "related-to";
      return Object.prototype.hasOwnProperty.call(EDGE_COLORS, normalized)
        ? normalized
        : "related-to";
    }

    _dimColor(hex, factor = 0.3) {
      try {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const dr = Math.round(r * factor + 40 * (1 - factor));
        const dg = Math.round(g * factor + 40 * (1 - factor));
        const db = Math.round(b * factor + 40 * (1 - factor));
        return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
      } catch (_) {
        return "#2d3748";
      }
    }

    _ensureResizeObserver() {
      if (typeof ResizeObserver === "undefined" || !this.container) {
        return;
      }

      this._resizeObserver = new ResizeObserver(() => {
        if (this.sigma) {
          try {
            this.sigma.refresh();
          } catch (_) {}
        }
      });

      try {
        this._resizeObserver.observe(this.container);
      } catch (_) {}
    }

    _fitIfNeeded(appendedNodesCount, appendedEdgesCount) {
      if (!this.sigma) return;
      if (appendedNodesCount <= 0 && appendedEdgesCount <= 0) return;
      if (this.graph && this.graph.order <= 30) {
        this.fitView();
      }
    }

    _updateAccessibilityState() {
      if (!this.container || !this.graph) return;
      const nodeCount = this.graph.order;
      const edgeCount = this.graph.size;
      this.container.setAttribute(
        "aria-label",
        `VSContext code graph with ${nodeCount} nodes and ${edgeCount} edges`,
      );
      this.container.setAttribute("tabindex", "0");
    }

    _clearGraphVisibility() {
      if (!this.graph) return;
      this.graph.forEachNode((node) => {
        this.graph.setNodeAttribute(node, "hidden", false);
        this.graph.setNodeAttribute(
          node,
          "color",
          NODE_COLORS[
            this._normalizeNodeType(this.graph.getNodeAttributes(node).nodeType)
          ] || NODE_COLORS.default,
        );
      });
      this.graph.forEachEdge((edge, attrs) => {
        this.graph.setEdgeAttribute(edge, "hidden", false);
        this.graph.setEdgeAttribute(
          edge,
          "color",
          EDGE_COLORS[this._normalizeRelationship(attrs.relationship)] ||
            EDGE_COLORS["related-to"],
        );
      });
    }
  }

  window.SigmaRenderer = SigmaRenderer;
})();
