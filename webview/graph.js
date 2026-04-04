/* global acquireVsCodeApi CytoscapeRenderer VSContextGraphKeyboard */
// webview/graph.js
// Main controller for the VSContext graph webview.
// Depends on cytoscapeRenderer.js (window.CytoscapeRenderer) loaded before this script.

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {CytoscapeRenderer|null} */
  let renderer = null;

  let loadState = {
    remainingCount: 0,
    canLoadMore: false,
    wasTruncated: false,
  };
  let totals = { totalNodeCount: 0, totalEdgeCount: 0 };

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const graphContainer = document.getElementById("graph");
  const summaryEl = document.getElementById("summary");
  const noticeEl = document.getElementById("notice");
  const loadMoreBtn = document.getElementById("load-more");
  const viewToggleBtn = document.getElementById("view-toggle");
  const directionToggleBtn = document.getElementById("direction-toggle");
  const fitViewBtn = document.getElementById("fit-view");
  const relayoutBtn = document.getElementById("relayout");
  const zoomInBtn = document.getElementById("zoom-in");
  const zoomOutBtn = document.getElementById("zoom-out");
  const zoomLevelEl = document.getElementById("zoom-level");
  const graphSearchInput = document.getElementById("graph-search");
  const edgeBudgetInput = document.getElementById("edge-budget");
  const edgeBudgetValueEl = document.getElementById("edge-budget-value");
  const toggleContainmentBtn = document.getElementById("toggle-containment");
  const toggleVariablesBtn = document.getElementById("toggle-variables");
  const toggleSmartLabelsBtn = document.getElementById("toggle-smart-labels");
  const toggleCallsBtn = document.getElementById("toggle-edge-calls");
  const toggleImplementsBtn = document.getElementById("toggle-edge-implements");
  const toggleReadsBtn = document.getElementById("toggle-edge-reads");
  const toggleWritesBtn = document.getElementById("toggle-edge-writes");
  const toggleFileDepsBtn = document.getElementById(
    "toggle-edge-file-dependency",
  );
  const resetFiltersBtn = document.getElementById("reset-filters");
  const legendToggleBtn = document.getElementById("legend-toggle");
  const legendContentEl = document.getElementById("legend-content");
  const menuToggleBtn = document.getElementById("menu-toggle");
  const overflowMenuEl = document.getElementById("overflow-menu");
  const topBarsToggleBtn = document.getElementById("top-bars-toggle");
  const noticeSection = document.getElementById("notice");
  const densitySection = document.getElementById("density-controls");
  const appEl = document.getElementById("app");
  const tooltipEl = document.getElementById("node-tooltip");
  const collapseAllBtn = document.getElementById("collapse-all");
  const expandAllBtn = document.getElementById("expand-all");
  const toggleEdgeDeclutterBtn = document.getElementById(
    "toggle-edge-declutter",
  );

  const keyboardUtils =
    typeof VSContextGraphKeyboard !== "undefined" ? VSContextGraphKeyboard : null;

  const LAYOUT_MODES = [
    { id: "hierarchical", label: "Mind Map" },
    { id: "dependency", label: "Dependency Flow" },
    { id: "radial", label: "Radial" },
  ];

  // ─── View state ────────────────────────────────────────────────────────────
  let viewMode = "hierarchical";
  let dagDirection = "TB";
  const DIRECTIONS = ["TB", "LR", "BT", "RL"];
  let directionIndex = 0;
  let legendVisible = true;
  let topBarsVisible = true;
  let smartLabelsEnabled = true;
  let edgeDeclutterEnabled = false;
  let focusedTooltipPreview = null;

  // Edge-type active set
  const activeEdgeTypes = new Set([
    "calls",
    "implements",
    "reads",
    "writes",
    "file-dependency",
  ]);
  let hideStructural = false;
  let hideVariables = false;

  // Notice auto-clear timer
  let noticeTimer = null;

  // Zoom update debounce
  let zoomUpdateRaf = null;

  // ─── Edge-type button descriptors ─────────────────────────────────────────
  const EDGE_TYPE_BTNS = [
    { btn: toggleCallsBtn, type: "calls", label: "Calls" },
    { btn: toggleImplementsBtn, type: "implements", label: "Implements" },
    { btn: toggleReadsBtn, type: "reads", label: "Reads" },
    { btn: toggleWritesBtn, type: "writes", label: "Writes" },
    { btn: toggleFileDepsBtn, type: "file-dependency", label: "File Deps" },
  ];

  // ─── Boot ──────────────────────────────────────────────────────────────────

  function init() {
    if (typeof CytoscapeRenderer === "undefined") {
      showNotice(
        "Cytoscape renderer failed to load. Please reload the webview.",
      );
      return;
    }

    renderer = new CytoscapeRenderer(graphContainer);
    renderer.initialize();

    renderer.setOpenNodeCallback((target) => {
      showNotice("Opening symbol in editor…");
      vscode.postMessage({ type: "openNode", target });
    });

    renderer.setCameraUpdateCallback(() => {
      scheduleZoomDisplayUpdate();
    });

    renderer.setHoverNodeCallback((preview) => {
      if (preview) {
        showTooltip(preview, false);
        return;
      }

      if (focusedTooltipPreview) {
        showTooltip(focusedTooltipPreview, true);
      } else {
        hideTooltip();
      }
    });

    renderer.setFocusNodeCallback((preview) => {
      focusedTooltipPreview = preview || null;
      if (focusedTooltipPreview) {
        showTooltip(focusedTooltipPreview, true);
      } else {
        hideTooltip();
      }
    });

    renderer.setSmartLabelsEnabled(smartLabelsEnabled);
    renderer.setEdgeDeclutter(edgeDeclutterEnabled);

    setupEventListeners();
    updateZoomDisplay();
    syncFilterButtonStates();
    updateViewToggleBtn();
    updateDirectionBtn();
    updateLegendVisibility();
    updateLoadMoreButton();

    // Tell extension we are ready
    vscode.postMessage({ type: "ready" });
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  function setupEventListeners() {
    graphContainer?.addEventListener("pointerdown", () => {
      graphContainer.focus();
    });

    // ── Layout ────────────────────────────────────────────────────────────────
    viewToggleBtn?.addEventListener("click", () => {
      cycleViewMode();
    });

    directionToggleBtn?.addEventListener("click", () => {
      if (!modeSupportsDirection(viewMode)) return;
      directionIndex = (directionIndex + 1) % DIRECTIONS.length;
      dagDirection = DIRECTIONS[directionIndex];
      updateDirectionBtn();
      renderer.setDagDirection(dagDirection);
    });

    fitViewBtn?.addEventListener("click", () => {
      renderer.fitView();
    });

    relayoutBtn?.addEventListener("click", () => {
      renderer.relayout();
      maybeEmitLayoutDebugNotice();
    });

    collapseAllBtn?.addEventListener("click", () => {
      renderer.collapseAll();
      maybeEmitLayoutDebugNotice();
      showNotice("Collapsed tree groups.");
    });
    expandAllBtn?.addEventListener("click", () => {
      renderer.expandAll();
      maybeEmitLayoutDebugNotice();
      showNotice("Expanded tree groups.");
    });

    // ── Zoom ──────────────────────────────────────────────────────────────────
    zoomInBtn?.addEventListener("click", () => {
      renderer.zoomIn();
      scheduleZoomDisplayUpdate();
    });
    zoomOutBtn?.addEventListener("click", () => {
      renderer.zoomOut();
      scheduleZoomDisplayUpdate();
    });

    // ── Search ────────────────────────────────────────────────────────────────
    let searchTimer = null;
    graphSearchInput?.addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        renderer.search(e.target.value || "");
      }, 150);
    });

    // ── Edge budget ───────────────────────────────────────────────────────────
    edgeBudgetInput?.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      if (!Number.isFinite(val)) return;
      if (edgeBudgetValueEl) edgeBudgetValueEl.textContent = String(val);
      renderer.setEdgeBudget(val);
    });

    // ── Visibility filters ────────────────────────────────────────────────────
    toggleContainmentBtn?.addEventListener("click", () => {
      hideStructural = !hideStructural;
      toggleContainmentBtn.setAttribute("data-active", String(hideStructural));
      toggleContainmentBtn.setAttribute("aria-pressed", String(hideStructural));
      toggleContainmentBtn.textContent = hideStructural
        ? "Show Structural Edges"
        : "Hide Structural Edges";
      renderer.setFilter("hideStructural", hideStructural);
    });

    toggleVariablesBtn?.addEventListener("click", () => {
      hideVariables = !hideVariables;
      toggleVariablesBtn.setAttribute("data-active", String(hideVariables));
      toggleVariablesBtn.setAttribute("aria-pressed", String(hideVariables));
      toggleVariablesBtn.textContent = hideVariables
        ? "Show Variables"
        : "Hide Variables";
      renderer.setFilter("hideVariables", hideVariables);
    });

    toggleSmartLabelsBtn?.addEventListener("click", () => {
      smartLabelsEnabled = !smartLabelsEnabled;
      toggleSmartLabelsBtn.setAttribute("data-active", String(smartLabelsEnabled));
      toggleSmartLabelsBtn.setAttribute("aria-pressed", String(smartLabelsEnabled));
      toggleSmartLabelsBtn.textContent = smartLabelsEnabled
        ? "Smart Labels: On"
        : "Smart Labels: Off";
      renderer.setSmartLabelsEnabled(smartLabelsEnabled);
    });

    toggleEdgeDeclutterBtn?.addEventListener("click", () => {
      edgeDeclutterEnabled = !edgeDeclutterEnabled;
      toggleEdgeDeclutterBtn.setAttribute(
        "data-active",
        String(edgeDeclutterEnabled),
      );
      toggleEdgeDeclutterBtn.setAttribute(
        "aria-pressed",
        String(edgeDeclutterEnabled),
      );
      toggleEdgeDeclutterBtn.textContent = edgeDeclutterEnabled
        ? "Edge De-clutter: On"
        : "Edge De-clutter: Off";
      renderer.setEdgeDeclutter(edgeDeclutterEnabled);
    });

    // ── Edge type toggles ─────────────────────────────────────────────────────
    for (const { btn, type, label } of EDGE_TYPE_BTNS) {
      if (!btn) continue;
      btn.addEventListener("click", () => {
        const isActive = activeEdgeTypes.has(type);
        if (isActive) {
          activeEdgeTypes.delete(type);
          btn.setAttribute("data-active", "false");
          btn.setAttribute("aria-pressed", "false");
          btn.textContent = `${label}: Off`;
          renderer.toggleEdgeType(type, false);
        } else {
          activeEdgeTypes.add(type);
          btn.setAttribute("data-active", "true");
          btn.setAttribute("aria-pressed", "true");
          btn.textContent = `${label}: On`;
          renderer.toggleEdgeType(type, true);
        }
      });
    }

    // ── Reset filters ─────────────────────────────────────────────────────────
    resetFiltersBtn?.addEventListener("click", () => {
      resetFilters();
    });

    // ── Legend ────────────────────────────────────────────────────────────────
    legendToggleBtn?.addEventListener("click", () => {
      legendVisible = !legendVisible;
      updateLegendVisibility();
    });

    // ── Overflow menu ─────────────────────────────────────────────────────────
    menuToggleBtn?.addEventListener("click", () => {
      toggleOverflowMenu();
    });

    // Close overflow menu when clicking outside it
    document.addEventListener("click", (e) => {
      if (!overflowMenuEl || overflowMenuEl.hidden) return;
      if (menuToggleBtn && menuToggleBtn.contains(e.target)) return;
      if (overflowMenuEl.contains(e.target)) return;
      setOverflowMenuOpen(false);
    });

    // ── Top bars toggle ───────────────────────────────────────────────────────
    topBarsToggleBtn?.addEventListener("click", () => {
      topBarsVisible = !topBarsVisible;
      setTopBarsVisible(topBarsVisible);
    });

    // ── Load more ─────────────────────────────────────────────────────────────
    loadMoreBtn?.addEventListener("click", () => {
      if (!loadState.canLoadMore) return;
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "Loading…";
      vscode.postMessage({ type: "requestLoadMore" });
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    document.addEventListener("keydown", handleKeydown);

    // Ensure the graph canvas can receive keyboard focus
    graphContainer?.setAttribute(
      "aria-keyshortcuts",
      "ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space Escape + - F V D L /",
    );
  }

  // ─── Keyboard handler ──────────────────────────────────────────────────────

  function handleKeydown(e) {
    if (!renderer) return;

    const targetElement = e.target instanceof Element ? e.target : null;
    const activeElement =
      document.activeElement instanceof Element ? document.activeElement : null;
    const activeWithinGraph = Boolean(
      graphContainer &&
        activeElement &&
        (activeElement === graphContainer ||
          graphContainer.contains(activeElement)),
    );

    const shouldHandleShortcut = keyboardUtils
      ? keyboardUtils.shouldHandleGraphShortcut({
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          activeWithinGraph,
          targetTagName: targetElement?.tagName,
          targetRole: targetElement?.getAttribute("role") || "",
          activeTagName: activeElement?.tagName,
          activeRole: activeElement?.getAttribute("role") || "",
          isContentEditable: Boolean(targetElement?.isContentEditable),
        })
      : activeWithinGraph && !e.ctrlKey && !e.metaKey && !e.altKey;

    if (!shouldHandleShortcut) {
      return;
    }

    const key = e.key;

    switch (key) {
      // ── Zoom ────────────────────────────────────────────────────────────────
      case "+":
      case "=":
        e.preventDefault();
        renderer.zoomIn();
        scheduleZoomDisplayUpdate();
        break;

      case "-":
      case "_":
        e.preventDefault();
        renderer.zoomOut();
        scheduleZoomDisplayUpdate();
        break;

      // ── Fit view ─────────────────────────────────────────────────────────────
      case "f":
      case "F":
        e.preventDefault();
        renderer.fitView();
        break;

      // ── Toggle layout mode ───────────────────────────────────────────────────
      case "v":
      case "V":
        e.preventDefault();
        cycleViewMode();
        break;

      // ── Cycle dag direction ───────────────────────────────────────────────────
      case "d":
      case "D":
        e.preventDefault();
        if (modeSupportsDirection(viewMode)) {
          directionIndex = (directionIndex + 1) % DIRECTIONS.length;
          dagDirection = DIRECTIONS[directionIndex];
          updateDirectionBtn();
          renderer.setDagDirection(dagDirection);
        }
        break;

      // ── Load more ─────────────────────────────────────────────────────────────
      case "l":
      case "L":
        e.preventDefault();
        if (loadState.canLoadMore && loadMoreBtn && !loadMoreBtn.disabled) {
          loadMoreBtn.click();
        }
        break;

      // ── Focus search ─────────────────────────────────────────────────────────
      case "/":
        e.preventDefault();
        if (graphSearchInput) {
          graphSearchInput.focus();
          graphSearchInput.select();
        }
        break;

      // ── Arrow navigation ──────────────────────────────────────────────────────
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        e.preventDefault();
        renderer.moveFocus(key);
        scheduleZoomDisplayUpdate();
        break;

      // ── Activate focused node (open in editor) ────────────────────────────────
      case "Enter":
      case " ":
        e.preventDefault();
        {
          const target = renderer.activateFocusedNode();
          if (target) {
            showNotice("Opening symbol in editor…");
            vscode.postMessage({ type: "openNode", target });
          }
        }
        break;

      // ── Escape: clear focus / highlight ──────────────────────────────────────
      case "Escape":
        e.preventDefault();
        renderer.clearFocus();
        hideTooltip();
        if (overflowMenuEl && !overflowMenuEl.hidden) {
          setOverflowMenuOpen(false);
          menuToggleBtn?.focus();
        }
        break;

      default:
        break;
    }
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "setGraphData":
        handleSetGraphData(msg);
        break;
      case "appendGraphData":
        handleAppendGraphData(msg);
        break;
      case "openNodeResult":
        handleOpenNodeResult(msg);
        break;
      default:
        break;
    }
  });

  function handleSetGraphData(msg) {
    if (
      !msg.payload ||
      !Array.isArray(msg.payload.nodes) ||
      !Array.isArray(msg.payload.edges)
    ) {
      showNotice("Unable to render graph: invalid payload.");
      return;
    }
    if (!renderer) {
      showNotice("Renderer not initialized.");
      return;
    }

    loadState = sanitizeLoadState(msg.loadState);
    totals = sanitizeTotals(msg.totals, msg.payload);
    focusedTooltipPreview = null;

    renderer.setData(msg.payload.nodes, msg.payload.edges);

    const counts = renderer.getGraphCounts();

    updateSummary(counts.nodeCount, counts.edgeCount);
    updateLoadMoreButton();
    scheduleZoomDisplayUpdate();
    maybeEmitLayoutDebugNotice();

    if (loadState.wasTruncated) {
      showNotice(
        `Showing ${msg.payload.nodes.length} of ${totals.totalNodeCount} nodes. ` +
          `Use "Load More" to show additional nodes.`,
      );
    }
  }

  function handleAppendGraphData(msg) {
    if (
      !msg.payload ||
      !Array.isArray(msg.payload.nodes) ||
      !Array.isArray(msg.payload.edges)
    )
      return;
    if (!renderer) return;

    loadState = sanitizeLoadState(msg.loadState);
    totals = sanitizeTotals(msg.totals, msg.payload);

    renderer.appendData(msg.payload.nodes, msg.payload.edges, msg.layoutHint);

    const counts = renderer.getGraphCounts();
    updateSummary(counts.nodeCount, counts.edgeCount);
    updateLoadMoreButton();
    scheduleZoomDisplayUpdate();
    maybeEmitLayoutDebugNotice();

    const appendedCount = Number.isFinite(msg.appendedNodeCount)
      ? msg.appendedNodeCount
      : msg.payload.nodes.length;
    if (appendedCount > 0) {
      showNotice(`Loaded ${appendedCount} more nodes.`);
    } else if (!loadState.canLoadMore) {
      showNotice("All available nodes are loaded.");
    }
  }

  function handleOpenNodeResult(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.status === "success") {
      showNotice("Opened symbol in editor.");
    } else {
      const errorText =
        typeof msg.message === "string" && msg.message.trim()
          ? msg.message.trim()
          : "Unable to open selected symbol.";
      showNotice(`Error: ${errorText}`);
    }
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function updateSummary(nodeCount, edgeCount) {
    if (!summaryEl) return;
    const truncNote = loadState.wasTruncated
      ? ` (${loadState.remainingCount} more available)`
      : "";
    summaryEl.textContent = `${nodeCount} nodes, ${edgeCount} edges${truncNote}`;
  }

  function showNotice(msg) {
    if (!noticeEl) return;
    noticeEl.textContent = msg;
    clearTimeout(noticeTimer);
    if (msg) {
      noticeTimer = setTimeout(() => {
        if (noticeEl) noticeEl.textContent = "";
      }, 4000);
    }
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.hidden = true;
    tooltipEl.textContent = "";
  }

  function showTooltip(preview, fromFocus) {
    if (!tooltipEl || !graphContainer || !preview) {
      return;
    }

    const type = String(preview.type || "symbol");
    const branchKind = preview.branchKind ? ` • ${preview.branchKind}` : "";
    const line = Number.isFinite(preview.line) ? preview.line : 1;
    const hint = fromFocus
      ? "Press Enter to open in editor."
      : "Ctrl/Cmd+Click to open in editor.";

    tooltipEl.innerHTML =
      `<strong>${escapeHtml(preview.label || "(unknown)")}</strong>` +
      `<div class="tooltip-meta">${escapeHtml(type)}${escapeHtml(branchKind)}</div>` +
      `<div class="tooltip-meta">${escapeHtml(preview.filePath || "")}:` +
      `${line}</div>` +
      `<div class="tooltip-hint">${escapeHtml(hint)}</div>`;

    tooltipEl.hidden = false;

    const rect = graphContainer.getBoundingClientRect();
    const renderedX = Number.isFinite(preview.renderedX)
      ? preview.renderedX
      : rect.width / 2;
    const renderedY = Number.isFinite(preview.renderedY)
      ? preview.renderedY
      : rect.height / 2;

    const targetX = rect.left + renderedX + 14;
    const targetY = rect.top + renderedY + 14;
    const width = tooltipEl.offsetWidth || 260;
    const height = tooltipEl.offsetHeight || 120;
    const x = Math.max(8, Math.min(targetX, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(targetY, window.innerHeight - height - 8));

    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function updateLoadMoreButton() {
    if (!loadMoreBtn) return;
    const can = loadState.canLoadMore;
    loadMoreBtn.disabled = !can;
    if (can) {
      loadMoreBtn.textContent = `Load More (${loadState.remainingCount} remaining)`;
    } else {
      loadMoreBtn.textContent = "Load More";
    }
  }

  function scheduleZoomDisplayUpdate() {
    if (zoomUpdateRaf !== null) return;
    zoomUpdateRaf = requestAnimationFrame(() => {
      zoomUpdateRaf = null;
      updateZoomDisplay();
    });
  }

  function updateZoomDisplay() {
    if (!zoomLevelEl || !renderer) return;
    zoomLevelEl.textContent = renderer.getZoomLevel() + "%";
  }

  function maybeEmitLayoutDebugNotice() {
    if (!window.__VSCONTEXT_DEBUG_LAYOUT__ || !renderer) {
      return;
    }

    if (typeof renderer.getLastLayoutDiagnostics !== "function") {
      return;
    }

    const diagnostics = renderer.getLastLayoutDiagnostics();
    if (!diagnostics || diagnostics.overlapAdjustments <= 0) {
      return;
    }

    showNotice(
      `Layout overlap guard: ${diagnostics.overlapAdjustments} adjustments across ${diagnostics.treeCount} trees.`,
    );
  }

  // ── Filter state ──────────────────────────────────────────────────────────

  function syncFilterButtonStates() {
    if (toggleContainmentBtn) {
      toggleContainmentBtn.setAttribute("data-active", String(hideStructural));
      toggleContainmentBtn.setAttribute("aria-pressed", String(hideStructural));
      toggleContainmentBtn.textContent = hideStructural
        ? "Show Structural Edges"
        : "Hide Structural Edges";
    }
    if (toggleVariablesBtn) {
      toggleVariablesBtn.setAttribute("data-active", String(hideVariables));
      toggleVariablesBtn.setAttribute("aria-pressed", String(hideVariables));
      toggleVariablesBtn.textContent = hideVariables
        ? "Show Variables"
        : "Hide Variables";
    }
    if (toggleSmartLabelsBtn) {
      toggleSmartLabelsBtn.setAttribute("data-active", String(smartLabelsEnabled));
      toggleSmartLabelsBtn.setAttribute("aria-pressed", String(smartLabelsEnabled));
      toggleSmartLabelsBtn.textContent = smartLabelsEnabled
        ? "Smart Labels: On"
        : "Smart Labels: Off";
    }
    if (toggleEdgeDeclutterBtn) {
      toggleEdgeDeclutterBtn.setAttribute(
        "data-active",
        String(edgeDeclutterEnabled),
      );
      toggleEdgeDeclutterBtn.setAttribute(
        "aria-pressed",
        String(edgeDeclutterEnabled),
      );
      toggleEdgeDeclutterBtn.textContent = edgeDeclutterEnabled
        ? "Edge De-clutter: On"
        : "Edge De-clutter: Off";
    }
    for (const { btn, type, label } of EDGE_TYPE_BTNS) {
      if (!btn) continue;
      const on = activeEdgeTypes.has(type);
      btn.setAttribute("data-active", String(on));
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = `${label}: ${on ? "On" : "Off"}`;
    }
  }

  function resetFilters() {
    hideStructural = false;
    hideVariables = false;
    smartLabelsEnabled = true;
    edgeDeclutterEnabled = false;
    activeEdgeTypes.clear();
    ["calls", "implements", "reads", "writes", "file-dependency"].forEach((t) =>
      activeEdgeTypes.add(t),
    );

    if (renderer) {
      renderer.setFilter("hideStructural", false);
      renderer.setFilter("hideVariables", false);
      renderer.setSmartLabelsEnabled(true);
      renderer.setEdgeDeclutter(false);
      for (const { type } of EDGE_TYPE_BTNS) {
        renderer.toggleEdgeType(type, true);
      }
    }

    syncFilterButtonStates();
    showNotice("Filters reset.");
  }

  // ── Layout button labels ───────────────────────────────────────────────────

  function cycleViewMode() {
    const currentIndex = LAYOUT_MODES.findIndex((mode) => mode.id === viewMode);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % LAYOUT_MODES.length;
    viewMode = LAYOUT_MODES[nextIndex].id;
    updateViewToggleBtn();
    updateDirectionBtn();
    renderer.setLayout(viewMode);
  }

  function modeSupportsDirection(mode) {
    return mode === "hierarchical" || mode === "dependency";
  }

  function updateViewToggleBtn() {
    if (!viewToggleBtn) return;
    const activeMode = LAYOUT_MODES.find((mode) => mode.id === viewMode);
    viewToggleBtn.textContent = `View: ${activeMode?.label || "Mind Map"}`;
  }

  function updateDirectionBtn() {
    if (!directionToggleBtn) return;
    if (!modeSupportsDirection(viewMode)) {
      directionToggleBtn.disabled = true;
      directionToggleBtn.textContent = "Direction: N/A";
    } else {
      directionToggleBtn.disabled = false;
      directionToggleBtn.textContent = `Direction: ${dagDirection}`;
    }
  }

  // ── Legend ─────────────────────────────────────────────────────────────────

  function updateLegendVisibility() {
    if (!legendContentEl || !legendToggleBtn) return;
    legendContentEl.hidden = !legendVisible;
    legendToggleBtn.textContent = legendVisible ? "Hide Legend" : "Show Legend";
    legendToggleBtn.setAttribute("aria-expanded", String(legendVisible));
  }

  // ── Overflow menu ──────────────────────────────────────────────────────────

  function toggleOverflowMenu() {
    const isOpen = !overflowMenuEl?.hidden;
    setOverflowMenuOpen(!isOpen);
  }

  function setOverflowMenuOpen(open) {
    if (!overflowMenuEl || !menuToggleBtn) return;
    overflowMenuEl.hidden = !open;
    menuToggleBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const firstBtn = overflowMenuEl.querySelector("button");
      if (firstBtn) firstBtn.focus();
    }
  }

  // ── Top bars ───────────────────────────────────────────────────────────────

  function setTopBarsVisible(visible) {
    if (!appEl) return;
    topBarsVisible = visible;
    if (visible) {
      appEl.classList.remove("top-bars-hidden");
      if (noticeSection) noticeSection.hidden = false;
      if (densitySection) densitySection.hidden = false;
      if (topBarsToggleBtn) {
        topBarsToggleBtn.innerHTML = "&#9650;";
        topBarsToggleBtn.setAttribute("aria-expanded", "true");
        topBarsToggleBtn.title = "Hide top bars";
      }
    } else {
      appEl.classList.add("top-bars-hidden");
      if (noticeSection) noticeSection.hidden = true;
      if (densitySection) densitySection.hidden = true;
      if (topBarsToggleBtn) {
        topBarsToggleBtn.innerHTML = "&#9660;";
        topBarsToggleBtn.setAttribute("aria-expanded", "false");
        topBarsToggleBtn.title = "Show top bars";
      }
    }
  }

  // ─── Sanitise helpers ───────────────────────────────────────────────────────

  function sanitizeLoadState(raw) {
    if (!raw || typeof raw !== "object") {
      return { remainingCount: 0, canLoadMore: false, wasTruncated: false };
    }
    const remainingCount = Number.isFinite(raw.remainingCount)
      ? raw.remainingCount
      : 0;
    return {
      remainingCount,
      canLoadMore: !!raw.canLoadMore,
      wasTruncated: !!raw.wasTruncated,
    };
  }

  function sanitizeTotals(raw, payload) {
    const fallbackNodes = payload?.nodes?.length ?? 0;
    const fallbackEdges = payload?.edges?.length ?? 0;
    if (!raw || typeof raw !== "object") {
      return { totalNodeCount: fallbackNodes, totalEdgeCount: fallbackEdges };
    }
    return {
      totalNodeCount: Number.isFinite(raw.totalNodeCount)
        ? raw.totalNodeCount
        : fallbackNodes,
      totalEdgeCount: Number.isFinite(raw.totalEdgeCount)
        ? raw.totalEdgeCount
        : fallbackEdges,
    };
  }

  // ─── Start ──────────────────────────────────────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
