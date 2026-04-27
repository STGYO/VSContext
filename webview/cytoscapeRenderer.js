// webview/cytoscapeRenderer.js
// Cytoscape.js-based renderer for VSContext file-tree graph visualization.
// Runs in VS Code webview browser context.

(function () {
  "use strict";

  const FILE_TREE_GAP_PX = 300;
  const LEVEL_GAP_PX = 170;
  const SIBLING_GAP_PX = 36;
  const NODE_WIDTH_FLOOR_PX = 72;
  const NODE_COLLISION_PADDING_PX = 16;
  const MAX_COLLISION_PASSES = 8;

  const NODE_COLORS = {
    file: "#1e3a5f",
    branch: "#334155",
    class: "#7c3aed",
    function: "#2563eb",
    method: "#0891b2",
    variable: "#059669",
    dependency: "#d97706",
    metadata: "#64748b",
    default: "#2563eb",
  };

  const BRANCH_COLORS = {
    metadata: "#64748b",
    dependencies: "#0f766e",
    "global-scope": "#15803d",
    definitions: "#1d4ed8",
    docstrings: "#475569",
    comments: "#6b7280",
    imports: "#0f766e",
    includes: "#0d9488",
    constants: "#84cc16",
    variables: "#22c55e",
    locals: "#10b981",
    classes: "#7c3aed",
    functions: "#2563eb",
    methods: "#0891b2",
    interfaces: "#a855f7",
    enums: "#f59e0b",
    modules: "#6366f1",
  };

  const EDGE_COLORS = {
    "file-branch": "#64748b",
    "branch-subbranch": "#64748b",
    "branch-leaf": "#64748b",
    "dependency-import": "#14b8a6",
    calls: "#3b82f6",
    implements: "#10b981",
    reads: "#f59e0b",
    writes: "#ef4444",
    "file-dependency": "#94a3b8",
    imports: "#22d3ee",
    covers: "#84cc16",
    documents: "#64748b",
    "related-to": "#94a3b8",
    "file-class": "#6d28d9",
    "file-method": "#0369a1",
    "file-function": "#1d4ed8",
    "file-variable": "#047857",
    "class-method": "#7e22ce",
    "function-variable": "#065f46",
    "method-variable": "#164e63",
    default: "#94a3b8",
  };

  const STRUCTURAL_RELATIONSHIPS = new Set([
    "file-branch",
    "branch-subbranch",
    "branch-leaf",
    "file-class",
    "file-method",
    "file-function",
    "file-variable",
    "class-method",
    "function-variable",
    "method-variable",
  ]);

  const layoutMath =
    typeof window !== "undefined" && window.VSContextLayoutMath
      ? window.VSContextLayoutMath
      : null;

  function fallbackEstimateNodeWidth(node, floorWidth) {
    const minimum = Number.isFinite(floorWidth) ? floorWidth : NODE_WIDTH_FLOOR_PX;
    const label = String(node?.label || node?.name || "");
    const size = Number(node?.size || 0);
    return Math.max(minimum, Math.round(size + 24 + label.length * 6.5));
  }

  function fallbackOrient(position, direction) {
    switch (direction) {
      case "BT":
        return { x: position.x, y: -position.y };
      case "LR":
        return { x: position.y, y: position.x };
      case "RL":
        return { x: -position.y, y: position.x };
      case "TB":
      default:
        return { x: position.x, y: position.y };
    }
  }

  function fallbackHashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return String(hash >>> 0);
  }

  function fallbackBuildLayoutSignature(input) {
    const visibleNodeIds = [...(input.visibleNodeIds || [])].sort();
    const hiddenEdgeTypes = [...(input.hiddenEdgeTypes || [])].sort();
    const raw = [
      input.layoutMode || "hierarchical",
      input.dagDirection || "TB",
      input.collapseGroupsEnabled ? "1" : "0",
      input.hideStructural ? "1" : "0",
      input.hideVariables ? "1" : "0",
      String(input.edgeBudget ?? ""),
      hiddenEdgeTypes.join("~"),
      visibleNodeIds.join("~"),
    ].join("|");
    return fallbackHashString(raw);
  }

  function fallbackPackFileTrees(fileTrees, options) {
    const fileGap = Number.isFinite(options?.fileGap) ? options.fileGap : FILE_TREE_GAP_PX;
    const levelGap = Number.isFinite(options?.levelGap) ? options.levelGap : LEVEL_GAP_PX;
    const siblingGap = Number.isFinite(options?.siblingGap)
      ? options.siblingGap
      : SIBLING_GAP_PX;
    const nodeWidthFloor = Number.isFinite(options?.nodeWidthFloor)
      ? options.nodeWidthFloor
      : NODE_WIDTH_FLOOR_PX;

    const normalizedTrees = fileTrees.map((tree) => {
      const levels = tree.levels
        .map((levelEntry) => {
          const nodes = [...levelEntry.nodes]
            .sort((left, right) => {
              return String(left.label || "").localeCompare(String(right.label || ""));
            })
            .map((node) => {
              const width = Number.isFinite(node.width)
                ? node.width
                : fallbackEstimateNodeWidth(node, nodeWidthFloor);
              return {
                id: node.id,
                label: String(node.label || ""),
                width,
              };
            });

          const levelWidth = nodes.reduce((sum, node, index) => {
            return sum + node.width + (index > 0 ? siblingGap : 0);
          }, 0);

          return {
            level: levelEntry.level,
            nodes,
            levelWidth,
          };
        })
        .sort((left, right) => left.level - right.level);

      const treeWidth = Math.max(
        nodeWidthFloor,
        ...levels.map((levelEntry) => levelEntry.levelWidth),
      );

      return {
        fileId: tree.fileId,
        levels,
        treeWidth,
      };
    });

    const totalWidth = normalizedTrees.reduce((sum, tree, index) => {
      return sum + tree.treeWidth + (index > 0 ? fileGap : 0);
    }, 0);

    const positions = {};
    let cursor = -totalWidth / 2;

    for (const tree of normalizedTrees) {
      const treeCenter = cursor + tree.treeWidth / 2;
      cursor += tree.treeWidth + fileGap;

      for (const levelEntry of tree.levels) {
        let xCursor = treeCenter - levelEntry.levelWidth / 2;
        for (const node of levelEntry.nodes) {
          positions[node.id] = {
            x: xCursor + node.width / 2,
            y: levelEntry.level * levelGap,
          };
          xCursor += node.width + siblingGap;
        }
      }
    }

    return {
      positions,
      diagnostics: {
        overlapAdjustments: 0,
        collisionPasses: 0,
        totalWidth,
        treeCount: normalizedTrees.length,
      },
    };
  }

  const estimateNodeWidth = layoutMath?.estimateNodeWidth || fallbackEstimateNodeWidth;
  const orientPosition = layoutMath?.orientPosition || fallbackOrient;
  const packFileTrees = layoutMath?.packFileTrees || fallbackPackFileTrees;
  const buildLayoutSignature =
    layoutMath?.buildLayoutSignature || fallbackBuildLayoutSignature;

  class CytoscapeRenderer {
    constructor(container) {
      this.container = container;
      this.cy = null;
      this.layoutMode = "hierarchical";
      this.dagDirection = "TB";
      this.filters = {
        hideStructural: false,
        hideVariables: false,
        hiddenEdgeTypes: new Set(),
      };
      this.edgeBudget = 22000;
      this.searchQuery = "";
      this.smartLabelsEnabled = true;
      this.edgeDeclutterEnabled = false;
      this.onOpenNode = null;
      this.onCameraUpdate = null;
      this.onHoverNode = null;
      this.onFocusNode = null;
      this.focusedNodeId = null;
      this.hoveredNodeId = null;
      this.collapseGroupsEnabled = false;
      this.currentPayload = { nodes: [], edges: [] };
      this.nodeLookup = new Map();
      this.edgeLookup = new Map();
      this.appendedNodeIds = new Set();
      this.previousVisiblePositions = new Map();
      this.incrementalLayoutPending = false;

      this.layoutFrameId = null;
      this.pendingFit = false;
      this.pendingCameraState = null;
      this.forceNextLayout = false;
      this.layoutInFlight = false;
      this.layoutRerunRequested = false;
      this.layoutRequestId = 0;
      this.lastLayoutSignature = "";
      this.needsInitialFit = true;
      this.layoutDiagnostics = {
        overlapAdjustments: 0,
        collisionPasses: 0,
        totalWidth: 0,
        treeCount: 0,
        lastReason: "",
      };

      this.elkWorkerUri =
        typeof window !== "undefined" && window.VSContextElkWorkerUri
          ? String(window.VSContextElkWorkerUri)
          : "";
      this.elk = null;
      this.elkInitPromise = this._initializeElk();
    }

    async _initializeElk() {
      if (typeof ELK === "undefined" || !this.elkWorkerUri) {
        return null;
      }

      try {
        const response = await fetch(this.elkWorkerUri);
        if (!response.ok) {
          throw new Error(`ELK worker fetch failed with ${response.status}`);
        }

        const workerSource = await response.text();
        const workerBlob = new Blob([workerSource], {
          type: "text/javascript",
        });
        const workerUrl = URL.createObjectURL(workerBlob);
        return new ELK({ workerUrl });
      } catch (error) {
        console.warn("[VSContext] Failed to initialize ELK layout.", error);
        return null;
      }
    }

    initialize() {
      if (typeof cytoscape === "undefined") {
        console.error("[VSContext] Cytoscape.js is not loaded.");
        return;
      }

      this.cy = cytoscape({
        container: this.container,
        elements: [],
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "background-color": "data(color)",
              width: "data(size)",
              height: "data(size)",
              shape: "round-rectangle",
              color: "#e2e8f0",
              "font-size": 10,
              "font-family": "monospace",
              "text-wrap": "ellipsis",
              "text-max-width": 220,
              "text-valign": "center",
              "text-halign": "center",
              "border-width": 1,
              "border-color": "#1f2937",
              "background-opacity": 0.95,
              "min-zoomed-font-size": 8,
            },
          },
          {
            selector: 'node[type = "file"]',
            style: {
              shape: "round-rectangle",
              "font-size": 11,
              "font-weight": 700,
              padding: 16,
              "text-max-width": 280,
            },
          },
          {
            selector: 'node[type = "branch"]',
            style: {
              "font-size": 10,
              "font-weight": 600,
              padding: 10,
              "text-max-width": 220,
            },
          },
          {
            selector: 'node[type = "metadata"], node[type = "dependency"]',
            style: {
              shape: "ellipse",
              "font-size": 9,
              "text-max-width": 180,
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "data(color)",
              "target-arrow-color": "data(color)",
              "target-arrow-shape": "triangle",
              width: "data(width)",
              opacity: 0.75,
            },
          },
          {
            selector: 'edge[isStructural = 1]',
            style: {
              "line-style": "dashed",
              "target-arrow-shape": "none",
              opacity: 0.5,
            },
          },
          {
            selector: ".hover-dim",
            style: {
              opacity: 0.14,
            },
          },
          {
            selector: "node.hover-highlight",
            style: {
              "border-width": 2,
              "border-color": "#f59e0b",
              opacity: 1,
              "z-index": 50,
            },
          },
          {
            selector: "edge.hover-highlight",
            style: {
              width: 2.2,
              opacity: 1,
              "z-index": 50,
            },
          },
          {
            selector: ".search-dim",
            style: {
              opacity: 0.2,
            },
          },
          {
            selector: "node.search-match",
            style: {
              "border-width": 2,
              "border-color": "#22d3ee",
              opacity: 1,
            },
          },
          {
            selector: "edge.search-match",
            style: {
              width: 2.1,
              opacity: 1,
            },
          },
          {
            selector: "node.focused",
            style: {
              "border-width": 3,
              "border-color": "#f97316",
              "z-index": 100,
            },
          },
          {
            selector: "node.label-hidden",
            style: {
              "text-opacity": 0,
            },
          },
          {
            selector: "node.label-faded",
            style: {
              "text-opacity": 0.45,
            },
          },
        ],
        wheelSensitivity: 0.18,
      });

      this.cy.on("tap", "node", (event) => {
        const node = event.target;
        this._focusNode(node.id(), false);
        const target = this._nodeTarget(node);
        const openWithModifier = Boolean(
          event?.originalEvent &&
            (event.originalEvent.ctrlKey || event.originalEvent.metaKey),
        );
        if (target && this.onOpenNode && openWithModifier) {
          this.onOpenNode(target);
        }
      });

      this.cy.on("tap", (event) => {
        if (event.target !== this.cy) {
          return;
        }

        this.clearFocus();
      });

      this.cy.on("mouseover", "node", (event) => {
        this.hoveredNodeId = event.target.id();
        this._highlightNeighborhood(this.hoveredNodeId);

        if (typeof this.onHoverNode === "function") {
          this.onHoverNode(this._nodePreview(event.target, event.renderedPosition));
        }
      });

      this.cy.on("mouseout", "node", () => {
        this.hoveredNodeId = null;
        this._clearHoverHighlight();

        if (typeof this.onHoverNode === "function") {
          this.onHoverNode(null);
        }
      });

      this.cy.on("zoom pan", () => {
        this._applySmartLabels();
        this._emitFocusPreview();

        if (typeof this.onCameraUpdate === "function") {
          this.onCameraUpdate(this.getZoomLevel());
        }
      });
    }

    setOpenNodeCallback(callback) {
      this.onOpenNode = callback;
    }

    setCameraUpdateCallback(callback) {
      this.onCameraUpdate = callback;
    }

    setHoverNodeCallback(callback) {
      this.onHoverNode = callback;
    }

    setFocusNodeCallback(callback) {
      this.onFocusNode = callback;
    }

    setSmartLabelsEnabled(enabled) {
      this.smartLabelsEnabled = Boolean(enabled);
      this._applySmartLabels();
    }

    setEdgeDeclutter(enabled) {
      this.edgeDeclutterEnabled = Boolean(enabled);
      this._applyEdgeDeclutter();
    }

    setData(nodes, edges) {
      this.currentPayload = {
        nodes: Array.isArray(nodes) ? [...nodes] : [],
        edges: Array.isArray(edges) ? [...edges] : [],
      };
      this.appendedNodeIds.clear();
      this.previousVisiblePositions.clear();
      this.incrementalLayoutPending = false;
      this.focusedNodeId = null;
      this.needsInitialFit = true;
      this.forceNextLayout = true;
      this._renderPayload({
        preserveCamera: false,
        reason: "setData",
        fit: true,
      });
    }

    appendData(nodes, edges, options) {
      if (options?.incrementalRelayout) {
        this.previousVisiblePositions = this._captureVisiblePositions();
        this.appendedNodeIds = new Set((nodes || []).map((node) => node.id));
        this.incrementalLayoutPending = this.appendedNodeIds.size > 0;
      } else {
        this.previousVisiblePositions.clear();
        this.appendedNodeIds.clear();
        this.incrementalLayoutPending = false;
      }

      const existingNodeIds = new Set(this.currentPayload.nodes.map((node) => node.id));
      for (const node of nodes || []) {
        if (!existingNodeIds.has(node.id)) {
          this.currentPayload.nodes.push(node);
          existingNodeIds.add(node.id);
        }
      }

      const existingEdgeIds = new Set(this.currentPayload.edges.map((edge) => edge.id));
      for (const edge of edges || []) {
        if (!existingEdgeIds.has(edge.id)) {
          this.currentPayload.edges.push(edge);
          existingEdgeIds.add(edge.id);
        }
      }

      this._renderPayload({
        preserveCamera: true,
        reason: "appendData",
        fit: false,
      });
    }

    relayout() {
      if (!this.cy) {
        return;
      }

      this.forceNextLayout = true;
      this._queueLayout("relayout", {
        fit: true,
        preserveCamera: false,
      });
    }

    setLayout(type) {
      const allowedModes = new Set(["hierarchical", "dependency", "radial"]);
      this.layoutMode = allowedModes.has(type) ? type : "hierarchical";
      this.forceNextLayout = true;
      this._queueLayout("setLayout", {
        fit: true,
        preserveCamera: false,
      });
    }

    setDagDirection(direction) {
      const allowed = new Set(["TB", "LR", "BT", "RL"]);
      if (!allowed.has(direction)) {
        return;
      }

      this.dagDirection = direction;
      if (
        this.layoutMode === "hierarchical" ||
        this.layoutMode === "dependency"
      ) {
        this.forceNextLayout = true;
        this._queueLayout("setDagDirection", {
          fit: true,
          preserveCamera: false,
        });
      }
    }

    setFilter(filterName, value) {
      if (filterName === "hideStructural") {
        this.filters.hideStructural = Boolean(value);
      }

      if (filterName === "hideVariables") {
        this.filters.hideVariables = Boolean(value);
      }

      this._applyVisibility();
      this._queueLayout("setFilter", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    toggleEdgeType(edgeType, visible) {
      if (visible) {
        this.filters.hiddenEdgeTypes.delete(edgeType);
      } else {
        this.filters.hiddenEdgeTypes.add(edgeType);
      }

      this._applyVisibility();
      this._queueLayout("toggleEdgeType", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    setEdgeBudget(budget) {
      const nextBudget = Number.isFinite(budget)
        ? Math.max(0, Math.floor(budget))
        : this.edgeBudget;
      this.edgeBudget = nextBudget;
      this._applyVisibility();
      this._queueLayout("setEdgeBudget", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    collapseAll() {
      this.collapseGroupsEnabled = true;
      this._applyVisibility();
      this.forceNextLayout = true;
      this._queueLayout("collapseAll", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    expandAll() {
      this.collapseGroupsEnabled = false;
      this._applyVisibility();
      this.forceNextLayout = true;
      this._queueLayout("expandAll", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    search(query) {
      this.searchQuery = String(query || "")
        .toLowerCase()
        .trim();
      this._applySearchHighlight();
      this._queueLayout("search", {
        preserveCamera: true,
        cameraState: this._captureCameraState(),
      });
    }

    zoomIn() {
      if (!this.cy) {
        return;
      }

      const zoom = this.cy.zoom();
      this.cy.zoom({
        level: Math.min(zoom * 1.2, this.cy.maxZoom()),
        renderedPosition: {
          x: this.container.clientWidth / 2,
          y: this.container.clientHeight / 2,
        },
      });
    }

    zoomOut() {
      if (!this.cy) {
        return;
      }

      const zoom = this.cy.zoom();
      this.cy.zoom({
        level: Math.max(zoom / 1.2, this.cy.minZoom()),
        renderedPosition: {
          x: this.container.clientWidth / 2,
          y: this.container.clientHeight / 2,
        },
      });
    }

    getZoomLevel() {
      if (!this.cy) {
        return 100;
      }

      return Math.max(1, Math.round(this.cy.zoom() * 100));
    }

    fitView() {
      if (!this.cy) {
        return;
      }

      const visible = this.cy.elements(":visible");
      if (visible.length > 0) {
        this.cy.fit(visible, 50);
      }
    }

    getGraphCounts() {
      if (!this.cy) {
        return { nodeCount: 0, edgeCount: 0 };
      }

      return {
        nodeCount: this.cy.nodes(":visible").length,
        edgeCount: this.cy.edges(":visible").length,
      };
    }

    getLastLayoutDiagnostics() {
      return {
        overlapAdjustments: this.layoutDiagnostics.overlapAdjustments,
        collisionPasses: this.layoutDiagnostics.collisionPasses,
        totalWidth: this.layoutDiagnostics.totalWidth,
        treeCount: this.layoutDiagnostics.treeCount,
        lastReason: this.layoutDiagnostics.lastReason,
      };
    }

    moveFocus(key) {
      if (!this.cy) {
        return;
      }

      const nodes = this.cy
        .nodes(":visible")
        .toArray()
        .sort((left, right) => {
          const yDiff = left.position("y") - right.position("y");
          if (Math.abs(yDiff) > 1) {
            return yDiff;
          }

          return left.position("x") - right.position("x");
        });

      if (nodes.length === 0) {
        return;
      }

      let index = this.focusedNodeId
        ? nodes.findIndex((node) => node.id() === this.focusedNodeId)
        : -1;

      if (index < 0) {
        this._focusNode(nodes[0].id(), true);
        return;
      }

      const forward = key === "ArrowRight" || key === "ArrowDown";
      index = (index + (forward ? 1 : -1) + nodes.length) % nodes.length;
      this._focusNode(nodes[index].id(), true);
    }

    activateFocusedNode() {
      if (!this.cy || !this.focusedNodeId) {
        return null;
      }

      const node = this.cy.getElementById(this.focusedNodeId);
      if (!node || node.empty()) {
        return null;
      }

      return this._nodeTarget(node);
    }

    clearFocus() {
      this.focusedNodeId = null;
      if (!this.cy) {
        return;
      }

      this.cy.nodes().removeClass("focused");

      if (typeof this.onFocusNode === "function") {
        this.onFocusNode(null);
      }
    }

    _nodeTarget(node) {
      const data = node.data();
      if (!data || typeof data.uriString !== "string") {
        return null;
      }

      return {
        uriString: data.uriString,
        line: data.line || 1,
        rangeStartLine: data.rangeStartLine || data.line || 1,
        rangeStartCharacter: data.rangeStartCharacter || 0,
        rangeEndLine: data.rangeEndLine || data.line || 1,
        rangeEndCharacter: data.rangeEndCharacter || 0,
      };
    }

    _focusNode(nodeId, panToNode) {
      if (!this.cy) {
        return;
      }

      const node = this.cy.getElementById(nodeId);
      if (!node || node.empty()) {
        return;
      }

      this.focusedNodeId = nodeId;
      this.cy.nodes().removeClass("focused");
      node.addClass("focused");

      if (typeof this.onFocusNode === "function") {
        this.onFocusNode(this._nodePreview(node, node.renderedPosition()));
      }

      if (panToNode) {
        this.cy.animate(
          {
            center: { eles: node },
          },
          {
            duration: 150,
          },
        );
      }
    }

    _highlightNeighborhood(nodeId) {
      if (!this.cy) {
        return;
      }

      this.cy.elements().removeClass("hover-highlight hover-dim");
      const node = this.cy.getElementById(nodeId);
      if (!node || node.empty() || !node.visible()) {
        return;
      }

      const visibleElements = this.cy.elements(":visible");
      visibleElements.addClass("hover-dim");

      const neighborhood = node.closedNeighborhood(":visible");
      neighborhood.removeClass("hover-dim").addClass("hover-highlight");
      node.removeClass("hover-dim").addClass("hover-highlight");
    }

    _clearHoverHighlight() {
      if (!this.cy) {
        return;
      }

      this.cy.elements().removeClass("hover-highlight hover-dim");
      this._applySearchHighlight();
      if (this.focusedNodeId) {
        this._focusNode(this.focusedNodeId, false);
      }
    }

    _renderPayload(options) {
      if (!this.cy) {
        return;
      }

      const preserveCamera = Boolean(options?.preserveCamera);
      const cameraState = preserveCamera ? this._captureCameraState() : null;

      this.nodeLookup = new Map();
      this.edgeLookup = new Map();
      for (const node of this.currentPayload.nodes) {
        this.nodeLookup.set(node.id, node);
      }
      for (const edge of this.currentPayload.edges) {
        this.edgeLookup.set(edge.id, edge);
      }

      const sortedNodes = [...this.currentPayload.nodes].sort((left, right) => {
        return this._nodeDepth(left.id) - this._nodeDepth(right.id);
      });

      this.cy.startBatch();
      this.cy.elements().remove();

      for (const node of sortedNodes) {
        const parent =
          node.parentId && this.nodeLookup.has(node.parentId)
            ? node.parentId
            : undefined;
        const level = this._nodeDepth(node.id);

        this.cy.add({
          group: "nodes",
          data: {
            id: node.id,
            label: node.name,
            type: node.type,
            branchKind: node.branchKind || "",
            filePath: node.filePath,
            uriString: node.uriString,
            line: node.line,
            rangeStartLine: node.rangeStartLine,
            rangeStartCharacter: node.rangeStartCharacter,
            rangeEndLine: node.rangeEndLine,
            rangeEndCharacter: node.rangeEndCharacter,
            parent,
            level,
            degree: Number(node.degree || 0),
            color: this._nodeColor(node),
            size: this._nodeSize(node),
          },
        });
      }

      for (const edge of this.currentPayload.edges) {
        if (!this.nodeLookup.has(edge.source) || !this.nodeLookup.has(edge.target)) {
          continue;
        }

        const structural = STRUCTURAL_RELATIONSHIPS.has(edge.relationship) ? 1 : 0;
        this.cy.add({
          group: "edges",
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            relationship: edge.relationship,
            isStructural: structural,
            color: EDGE_COLORS[edge.relationship] || EDGE_COLORS.default,
            width: structural ? 1 : 1.6,
          },
        });
      }

      this.cy.endBatch();

      this._applyVisibility();
      this._applySearchHighlight();
      if (this.focusedNodeId) {
        this._focusNode(this.focusedNodeId, false);
      }

      this._queueLayout(options?.reason || "render", {
        fit: Boolean(options?.fit),
        force: Boolean(options?.force),
        preserveCamera,
        cameraState,
      });
    }

    _nodeDepth(nodeId) {
      let depth = 0;
      let cursor = this.nodeLookup.get(nodeId);
      const guard = new Set();

      while (cursor && cursor.parentId && !guard.has(cursor.parentId)) {
        guard.add(cursor.parentId);
        depth += 1;
        cursor = this.nodeLookup.get(cursor.parentId);
      }

      return depth;
    }

    _nodeColor(node) {
      if (node.type === "branch" && node.branchKind) {
        return BRANCH_COLORS[node.branchKind] || NODE_COLORS.branch;
      }

      return NODE_COLORS[node.type] || NODE_COLORS.default;
    }

    _nodeSize(node) {
      switch (node.type) {
        case "file":
          return 66;
        case "branch":
          return 48;
        case "class":
          return 34;
        case "function":
        case "method":
          return 28;
        case "metadata":
        case "dependency":
          return 20;
        case "variable":
          return 18;
        default:
          return 22;
      }
    }

    _captureCameraState() {
      if (!this.cy) {
        return null;
      }

      return {
        zoom: this.cy.zoom(),
        pan: this.cy.pan(),
      };
    }

    _restoreCameraState(cameraState) {
      if (!this.cy || !cameraState) {
        return;
      }

      this.cy.zoom(cameraState.zoom);
      this.cy.pan(cameraState.pan);
    }

    _queueLayout(reason, options) {
      if (!this.cy) {
        return;
      }

      this.layoutRequestId += 1;
      this.layoutDiagnostics.lastReason = reason;
      this.pendingFit = this.pendingFit || Boolean(options?.fit);
      this.forceNextLayout = this.forceNextLayout || Boolean(options?.force);

      if (options?.preserveCamera && options?.cameraState) {
        this.pendingCameraState = options.cameraState;
      }

      if (this.layoutInFlight) {
        this.layoutRerunRequested = true;
        return;
      }

      if (this.layoutFrameId !== null) {
        return;
      }

      this.layoutFrameId = requestAnimationFrame(() => {
        this.layoutFrameId = null;
        void this._flushQueuedLayout();
      });
    }

    async _flushQueuedLayout() {
      if (!this.cy) {
        return;
      }

      if (this.layoutInFlight) {
        this.layoutRerunRequested = true;
        return;
      }

      this.layoutInFlight = true;
      const requestId = this.layoutRequestId;
      const nextSignature = this._computeLayoutSignature();
      const shouldApplyLayout =
        this.forceNextLayout || nextSignature !== this.lastLayoutSignature;

      try {
        if (shouldApplyLayout) {
          await this._applyLayout(requestId);
          if (requestId !== this.layoutRequestId) {
            return;
          }

          this.lastLayoutSignature = this._computeLayoutSignature();
        }

        if (requestId !== this.layoutRequestId) {
          return;
        }

        if (this.pendingCameraState) {
          this._restoreCameraState(this.pendingCameraState);
          this.pendingCameraState = null;
        } else if (this.pendingFit || this.needsInitialFit) {
          this.fitView();
          this.needsInitialFit = false;
        }

        this.pendingFit = false;
        this.forceNextLayout = false;
        this._applyEdgeDeclutter();
        this._applySmartLabels();
        this._emitFocusPreview();
        this.incrementalLayoutPending = false;
        this.appendedNodeIds.clear();
        this.previousVisiblePositions.clear();

        if (typeof this.onCameraUpdate === "function") {
          this.onCameraUpdate(this.getZoomLevel());
        }
      } finally {
        this.layoutInFlight = false;
        if (this.layoutRerunRequested) {
          this.layoutRerunRequested = false;
          this._queueLayout("layoutRerun", {
            preserveCamera: true,
            cameraState: this._captureCameraState(),
          });
        }
      }
    }

    _computeLayoutSignature() {
      if (!this.cy) {
        return "";
      }

      const visibleNodeIds = this.cy
        .nodes(":visible")
        .toArray()
        .map((node) => node.id());

      return buildLayoutSignature({
        layoutMode: this.layoutMode,
        dagDirection: this.dagDirection,
        collapseGroupsEnabled: this.collapseGroupsEnabled,
        hideStructural: this.filters.hideStructural,
        hideVariables: this.filters.hideVariables,
        edgeBudget: this.edgeBudget,
        hiddenEdgeTypes: [...this.filters.hiddenEdgeTypes],
        visibleNodeIds,
      });
    }

    async _applyLayout(requestId) {
      if (!this.cy) {
        return;
      }

      if (this.layoutMode === "dependency") {
        const usedElk = await this._applyElkLayout("dependency", requestId);
        if (usedElk) {
          return;
        }

        this._applyDependencyLayout();
        return;
      }

      if (this.layoutMode === "radial") {
        this._applyRadialLayout();
        return;
      }

      const usedElk = await this._applyElkLayout("hierarchical", requestId);
      if (usedElk) {
        return;
      }

      this._applyTreeLayout();
    }

    _canUseElkLayout() {
      return Boolean(this.elk && typeof this.elk.layout === "function");
    }

    async _applyElkLayout(mode, requestId) {
      if (!this.cy) {
        return false;
      }

      if (!this._canUseElkLayout()) {
        this.elk = await this.elkInitPromise;
      }

      if (!this._canUseElkLayout()) {
        return false;
      }

      const visibleNodes = this.cy.nodes(":visible").toArray();
      const visibleEdges = this.cy.edges(":visible").toArray();
      if (visibleNodes.length === 0) {
        return false;
      }

      const elkGraph = this._buildElkGraph(visibleNodes, visibleEdges, mode);
      const layoutOptions = this._elkLayoutOptions(mode);
      elkGraph.layoutOptions = layoutOptions;

      try {
        const laidOutGraph = await this.elk.layout(elkGraph, {
          layoutOptions,
        });

        if (!this.cy || requestId !== this.layoutRequestId) {
          return false;
        }

        this.layoutDiagnostics = {
          overlapAdjustments: 0,
          collisionPasses: 0,
          totalWidth: 0,
          treeCount: this.cy.nodes('node[type = "file"]:visible').length,
          lastReason: this.layoutDiagnostics.lastReason,
        };

        this._applyElkGraphPositions(laidOutGraph, 0, 0);
        return true;
      } catch (error) {
        console.warn("[VSContext] ELK layout failed; falling back.", error);
        return false;
      }
    }

    _buildElkGraph(visibleNodes, visibleEdges, mode) {
      const elkLookup = new Map();
      const elkNodes = visibleNodes
        .slice()
        .sort((left, right) => {
          const depthDiff = this._nodeDepth(left.id()) - this._nodeDepth(right.id());
          if (depthDiff !== 0) {
            return depthDiff;
          }

          return String(left.data("label") || "").localeCompare(
            String(right.data("label") || ""),
          );
        })
        .map((node) => {
          const dimensions = this._elkNodeDimensions(node, mode);
          const elkNode = {
            id: node.id(),
            width: dimensions.width,
            height: dimensions.height,
          };

          elkLookup.set(node.id(), elkNode);
          return elkNode;
        });

      const elkEdges = visibleEdges
        .slice()
        .sort((left, right) => {
          return String(left.data("relationship") || "").localeCompare(
            String(right.data("relationship") || ""),
          );
        })
        .map((edge) => ({
          id: edge.id(),
          sources: [String(edge.data("source") || "")],
          targets: [String(edge.data("target") || "")],
        }));

      const graph = {
        id: "root",
        children: [],
        edges: elkEdges,
      };

      for (const node of elkNodes) {
        const cyNode = this.cy.getElementById(node.id);
        const parent = cyNode.parent();
        if (parent && !parent.empty() && elkLookup.has(parent.id())) {
          const parentNode = elkLookup.get(parent.id());
          parentNode.children = parentNode.children || [];
          parentNode.children.push(node);
        } else {
          graph.children.push(node);
        }
      }

      return graph;
    }

    _elkNodeDimensions(node, mode) {
      const type = String(node.data("type") || "");
      const label = String(node.data("label") || node.data("id") || "");
      const size = Number(node.data("size") || 0);
      const widthFloor =
        type === "file"
          ? 240
          : type === "branch"
            ? 180
            : type === "class"
              ? 132
              : type === "function" || type === "method"
                ? 110
                : 92;
      const heightFloor =
        type === "file"
          ? 76
          : type === "branch"
            ? 58
            : type === "class"
              ? 44
              : type === "function" || type === "method"
                ? 34
                : 28;
      const width = Math.max(
        widthFloor,
        estimateNodeWidth({ label, size }, widthFloor),
      );
      const height = Math.max(heightFloor, Math.round(size + 8));

      if (mode === "dependency" && type === "file") {
        return {
          width: Math.max(width, 260),
          height: Math.max(height, 84),
        };
      }

      return { width, height };
    }

    _elkLayoutOptions(mode) {
      const direction = this._elkDirection();
      const dependencyMode = mode === "dependency";

      return {
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.edgeRouting": dependencyMode ? "ORTHOGONAL" : "POLYLINE",
        "elk.layered.mergeEdges": "true",
        "elk.spacing.nodeNode": dependencyMode ? "42" : "30",
        "elk.spacing.edgeNodeBetweenLayers": dependencyMode ? "44" : "30",
        "elk.layered.spacing.nodeNodeBetweenLayers": dependencyMode ? "72" : "56",
        "elk.layered.spacing.edgeNodeBetweenLayers": dependencyMode ? "42" : "28",
      };
    }

    _elkDirection() {
      switch (this.dagDirection) {
        case "BT":
          return "UP";
        case "LR":
          return "RIGHT";
        case "RL":
          return "LEFT";
        case "TB":
        default:
          return "DOWN";
      }
    }

    _applyElkGraphPositions(elkNode, offsetX, offsetY) {
      if (!elkNode) {
        return;
      }

      const childOffsetX = offsetX + Number(elkNode.x || 0);
      const childOffsetY = offsetY + Number(elkNode.y || 0);

      if (typeof elkNode.id === "string") {
        const cyNode = this.cy.getElementById(elkNode.id);
        if (cyNode && !cyNode.empty()) {
          const width = Number(elkNode.width || cyNode.width() || 0);
          const height = Number(elkNode.height || cyNode.height() || 0);
          cyNode.position({
            x: childOffsetX + width / 2,
            y: childOffsetY + height / 2,
          });
        }
      }

      for (const child of elkNode.children || []) {
        this._applyElkGraphPositions(child, childOffsetX, childOffsetY);
      }
    }

    _applyDependencyLayout() {
      if (!this.cy) {
        return;
      }

      const visible = this.cy.elements(":visible");
      if (visible.length === 0) {
        return;
      }

      const rootNodes = this.cy.nodes('node[type = "file"]:visible');
      this.layoutDiagnostics = {
        overlapAdjustments: 0,
        collisionPasses: 0,
        totalWidth: 0,
        treeCount: rootNodes.length,
        lastReason: this.layoutDiagnostics.lastReason,
      };

      const layout = visible.layout({
        name: "breadthfirst",
        directed: true,
        fit: false,
        padding: 20,
        animate: false,
        spacingFactor: 1.2,
        avoidOverlap: true,
        roots: rootNodes.length > 0 ? rootNodes : undefined,
      });
      layout.run();
      this._orientVisiblePositions();
    }

    _applyRadialLayout() {
      if (!this.cy) {
        return;
      }

      const visible = this.cy.elements(":visible");
      if (visible.length === 0) {
        return;
      }

      this.layoutDiagnostics = {
        overlapAdjustments: 0,
        collisionPasses: 0,
        totalWidth: 0,
        treeCount: this.cy.nodes('node[type = "file"]:visible').length,
        lastReason: this.layoutDiagnostics.lastReason,
      };

      const layout = visible.layout({
        name: "concentric",
        fit: false,
        padding: 20,
        animate: false,
        avoidOverlap: true,
        spacingFactor: 1.1,
        concentric: (node) => {
          const type = String(node.data("type") || "");
          const degree = Number(node.data("degree") || 0);
          const typeWeight =
            type === "file"
              ? 1000
              : type === "branch"
                ? 700
                : type === "class"
                  ? 450
                  : type === "function" || type === "method"
                    ? 320
                    : 180;
          return typeWeight + degree;
        },
        levelWidth: () => 1,
      });
      layout.run();
    }

    _orientVisiblePositions() {
      if (!this.cy) {
        return;
      }

      this.cy.nodes(":visible").forEach((node) => {
        const oriented = orientPosition(node.position(), this.dagDirection);
        node.position(oriented);
      });
    }

    _applyTreeLayout() {
      if (!this.cy) {
        return;
      }

      const visibleFiles = this.cy
        .nodes('node[type = "file"]:visible')
        .toArray()
        .sort((left, right) => {
          return String(left.data("label")).localeCompare(String(right.data("label")));
        });

      const fileTrees = visibleFiles.map((fileNode) => {
        const treeNodes = fileNode.add(fileNode.descendants(":visible")).toArray();
        const levels = new Map();

        for (const node of treeNodes) {
          const level = Number(node.data("level") || 0);
          const bucket = levels.get(level) || [];
          bucket.push({
            id: node.id(),
            label: String(node.data("label") || ""),
            size: Number(node.data("size") || 0),
            width: estimateNodeWidth(
              {
                label: String(node.data("label") || ""),
                size: Number(node.data("size") || 0),
              },
              NODE_WIDTH_FLOOR_PX,
            ),
          });
          levels.set(level, bucket);
        }

        return {
          fileId: fileNode.id(),
          levels: [...levels.entries()].map(([level, nodes]) => {
            return { level, nodes };
          }),
        };
      });

      const packed = packFileTrees(fileTrees, {
        fileGap: FILE_TREE_GAP_PX,
        levelGap: LEVEL_GAP_PX,
        siblingGap: SIBLING_GAP_PX,
        nodeWidthFloor: NODE_WIDTH_FLOOR_PX,
        collisionPadding: NODE_COLLISION_PADDING_PX,
        maxCollisionPasses: MAX_COLLISION_PASSES,
      });

      this.layoutDiagnostics = {
        overlapAdjustments: packed.diagnostics?.overlapAdjustments || 0,
        collisionPasses: packed.diagnostics?.collisionPasses || 0,
        totalWidth: packed.diagnostics?.totalWidth || 0,
        treeCount: packed.diagnostics?.treeCount || fileTrees.length,
        lastReason: this.layoutDiagnostics.lastReason,
      };

      for (const [nodeId, basePosition] of Object.entries(packed.positions || {})) {
        const node = this.cy.getElementById(nodeId);
        if (!node || node.empty()) {
          continue;
        }

        if (this.incrementalLayoutPending && !this.appendedNodeIds.has(nodeId)) {
          const previousPosition = this.previousVisiblePositions.get(nodeId);
          if (previousPosition) {
            node.position(previousPosition);
            continue;
          }
        }

        const oriented = orientPosition(basePosition, this.dagDirection);
        node.position(oriented);
      }
    }

    _applyVisibility() {
      if (!this.cy) {
        return;
      }

      const visibleNodeIds = new Set();

      this.cy.startBatch();
      this.cy.nodes().forEach((node) => {
        const type = String(node.data("type"));
        const level = Number(node.data("level") || 0);

        let visible = true;
        if (this.filters.hideVariables && type === "variable") {
          visible = false;
        }

        if (this.collapseGroupsEnabled && level > 1) {
          visible = false;
        }

        node.style("display", visible ? "element" : "none");
        if (visible) {
          visibleNodeIds.add(node.id());
        }
      });

      const edges = this.cy.edges().toArray().sort((left, right) => {
        const leftStructural = Number(left.data("isStructural") || 0);
        const rightStructural = Number(right.data("isStructural") || 0);
        return leftStructural - rightStructural;
      });

      let edgeCount = 0;
      for (const edge of edges) {
        const relationship = String(edge.data("relationship") || "");
        const sourceVisible = visibleNodeIds.has(String(edge.data("source")));
        const targetVisible = visibleNodeIds.has(String(edge.data("target")));
        const isStructural = Number(edge.data("isStructural") || 0) === 1;

        let visible = sourceVisible && targetVisible;
        if (visible && this.filters.hideStructural && isStructural) {
          visible = false;
        }
        if (visible && this.filters.hiddenEdgeTypes.has(relationship)) {
          visible = false;
        }
        if (visible && edgeCount >= this.edgeBudget) {
          visible = false;
        }

        edge.style("display", visible ? "element" : "none");
        if (visible) {
          edgeCount += 1;
        }
      }

      this.cy.endBatch();
      this._applySearchHighlight();
      this._applyEdgeDeclutter();
      this._applySmartLabels();
    }

    _applySearchHighlight() {
      if (!this.cy) {
        return;
      }

      this.cy.elements().removeClass("search-dim search-match");

      if (!this.searchQuery) {
        return;
      }

      const matches = [];
      this.cy.nodes(":visible").forEach((node) => {
        const label = String(node.data("label") || "").toLowerCase();
        const filePath = String(node.data("filePath") || "").toLowerCase();
        if (label.includes(this.searchQuery) || filePath.includes(this.searchQuery)) {
          matches.push(node);
        }
      });

      if (matches.length === 0) {
        return;
      }

      this.cy.elements(":visible").addClass("search-dim");
      for (const match of matches) {
        match.removeClass("search-dim").addClass("search-match");
        const neighborhood = match.closedNeighborhood(":visible");
        neighborhood.removeClass("search-dim").addClass("search-match");
      }

      if (this.focusedNodeId) {
        this._focusNode(this.focusedNodeId, false);
      }
    }

    _captureVisiblePositions() {
      const positions = new Map();
      if (!this.cy) {
        return positions;
      }

      this.cy.nodes(":visible").forEach((node) => {
        const position = node.position();
        positions.set(node.id(), {
          x: position.x,
          y: position.y,
        });
      });

      return positions;
    }

    _emitFocusPreview() {
      if (!this.cy || !this.focusedNodeId || typeof this.onFocusNode !== "function") {
        return;
      }

      const node = this.cy.getElementById(this.focusedNodeId);
      if (!node || node.empty() || !node.visible()) {
        return;
      }

      this.onFocusNode(this._nodePreview(node, node.renderedPosition()));
    }

    _nodePreview(node, renderedPosition) {
      const data = node.data();
      return {
        id: String(data.id || node.id()),
        label: String(data.label || ""),
        type: String(data.type || ""),
        branchKind: String(data.branchKind || ""),
        filePath: String(data.filePath || ""),
        line: Number(data.line || 1),
        renderedX: Number(renderedPosition?.x || 0),
        renderedY: Number(renderedPosition?.y || 0),
      };
    }

    _applySmartLabels() {
      if (!this.cy) {
        return;
      }

      const visibleNodes = this.cy.nodes(":visible");
      visibleNodes.removeClass("label-hidden label-faded");

      if (!this.smartLabelsEnabled) {
        return;
      }

      const zoom = this.cy.zoom();
      if (zoom < 0.35) {
        visibleNodes.addClass("label-hidden");
        return;
      }

      if (zoom < 0.6) {
        visibleNodes.forEach((node) => {
          const type = String(node.data("type") || "");
          if (type !== "file" && type !== "branch") {
            node.addClass("label-hidden");
          }
        });
        return;
      }

      if (zoom < 0.8) {
        visibleNodes.forEach((node) => {
          const type = String(node.data("type") || "");
          if (type !== "file") {
            node.addClass("label-faded");
          }
        });
      }
    }

    _applyEdgeDeclutter() {
      if (!this.cy) {
        return;
      }

      this.cy.edges().forEach((edge) => {
        if (!edge.visible()) {
          return;
        }

        const relationship = String(edge.data("relationship") || "");
        const isStructural = Number(edge.data("isStructural") || 0) === 1;
        const source = String(edge.data("source") || "");
        const target = String(edge.data("target") || "");
        const defaultColor = EDGE_COLORS[relationship] || EDGE_COLORS.default;

        edge.style("line-color", defaultColor);
        edge.style("target-arrow-color", defaultColor);

        if (!this.edgeDeclutterEnabled) {
          edge.style("curve-style", "bezier");
          edge.style("line-style", isStructural ? "dashed" : "solid");
          edge.style("target-arrow-shape", isStructural ? "none" : "triangle");
          edge.style("opacity", isStructural ? 0.5 : 0.75);
          edge.style("width", isStructural ? 1 : 1.6);
          return;
        }

        edge.style("curve-style", isStructural ? "taxi" : "bezier");
        edge.style("taxi-direction", "vertical");
        edge.style("line-style", "solid");
        edge.style("target-arrow-shape", isStructural ? "none" : "triangle");
        edge.style("opacity", this._edgeDeclutterOpacity(source, target, isStructural));
        edge.style("width", isStructural ? 1 : 1.2);
      });
    }

    _edgeDeclutterOpacity(sourceId, targetId, isStructural) {
      const sourceDegree = Number(this.nodeLookup.get(sourceId)?.degree || 0);
      const targetDegree = Number(this.nodeLookup.get(targetId)?.degree || 0);
      const combinedDegree = sourceDegree + targetDegree;
      const maxReduction = isStructural ? 0.22 : 0.45;
      const reduction = Math.min(maxReduction, combinedDegree / 120);
      const base = isStructural ? 0.45 : 0.78;
      return Math.max(0.18, base - reduction);
    }
  }

  window.CytoscapeRenderer = CytoscapeRenderer;
})();
