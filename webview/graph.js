/* global acquireVsCodeApi SigmaRenderer */
// webview/graph.js
// Main controller for the VSContext graph webview.
// Depends on sigmaRenderer.js (window.SigmaRenderer) loaded before this script.

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {SigmaRenderer|null} */
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

  // ─── View state ────────────────────────────────────────────────────────────
  let viewMode = "hierarchical"; // 'hierarchical' | 'force'
  let dagDirection = "TB";
  const DIRECTIONS = ["TB", "LR", "BT", "RL"];
  let directionIndex = 0;
  let legendVisible = true;
  let topBarsVisible = true;

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
    if (typeof SigmaRenderer === "undefined") {
      showNotice("Sigma renderer failed to load. Please reload the webview.");
      return;
    }

    renderer = new SigmaRenderer(graphContainer);
    renderer.initialize();

    renderer.setOpenNodeCallback((target) => {
      showNotice("Opening symbol in editor…");
      vscode.postMessage({ type: "openNode", target });
    });

    renderer.setCameraUpdateCallback(() => {
      scheduleZoomDisplayUpdate();
    });

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
    // ── Layout ────────────────────────────────────────────────────────────────
    viewToggleBtn?.addEventListener("click", () => {
      viewMode = viewMode === "hierarchical" ? "force" : "hierarchical";
      updateViewToggleBtn();
      updateDirectionBtn();
      renderer.setLayout(viewMode);
    });

    directionToggleBtn?.addEventListener("click", () => {
      if (viewMode !== "hierarchical") return;
      directionIndex = (directionIndex + 1) % DIRECTIONS.length;
      dagDirection = DIRECTIONS[directionIndex];
      updateDirectionBtn();
      renderer.setDagDirection(dagDirection);
    });

    fitViewBtn?.addEventListener("click", () => {
      renderer.fitView();
    });

    relayoutBtn?.addEventListener("click", () => {
      renderer._applyLayout();
    });

    // Collapse/expand: not meaningful for Sigma (no compound nodes),
    // but keep buttons wired to avoid broken UI
    collapseAllBtn?.addEventListener("click", () => {
      showNotice("Structural grouping is not available in this graph view.");
    });
    expandAllBtn?.addEventListener("click", () => {
      showNotice("Structural grouping is not available in this graph view.");
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
      toggleContainmentBtn.setAttribute("aria-checked", String(hideStructural));
      toggleContainmentBtn.textContent = hideStructural
        ? "Show Structural Edges"
        : "Hide Structural Edges";
      renderer.setFilter("hideStructural", hideStructural);
    });

    toggleVariablesBtn?.addEventListener("click", () => {
      hideVariables = !hideVariables;
      toggleVariablesBtn.setAttribute("data-active", String(hideVariables));
      toggleVariablesBtn.setAttribute("aria-checked", String(hideVariables));
      toggleVariablesBtn.textContent = hideVariables
        ? "Show Variables"
        : "Hide Variables";
      renderer.setFilter("hideVariables", hideVariables);
    });

    // Smart labels: Sigma doesn't have automatic label culling built in, but
    // we track the toggle state for UI parity (no-op on renderer for now).
    toggleSmartLabelsBtn?.addEventListener("click", () => {
      const current =
        toggleSmartLabelsBtn.getAttribute("data-active") === "true";
      const next = !current;
      toggleSmartLabelsBtn.setAttribute("data-active", String(next));
      toggleSmartLabelsBtn.setAttribute("aria-checked", String(next));
      toggleSmartLabelsBtn.textContent = next
        ? "Smart Labels: On"
        : "Smart Labels: Off";
    });

    // ── Edge type toggles ─────────────────────────────────────────────────────
    for (const { btn, type, label } of EDGE_TYPE_BTNS) {
      if (!btn) continue;
      btn.addEventListener("click", () => {
        const isActive = activeEdgeTypes.has(type);
        if (isActive) {
          activeEdgeTypes.delete(type);
          btn.setAttribute("data-active", "false");
          btn.setAttribute("aria-checked", "false");
          btn.textContent = `${label}: Off`;
          renderer.toggleEdgeType(type, false);
        } else {
          activeEdgeTypes.add(type);
          btn.setAttribute("data-active", "true");
          btn.setAttribute("aria-checked", "true");
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
    // Don't intercept keys when user is typing in an input
    if (
      e.target &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
    )
      return;
    // Don't intercept if a modifier key is held (allow browser shortcuts)
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!renderer) return;

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
        viewMode = viewMode === "hierarchical" ? "force" : "hierarchical";
        updateViewToggleBtn();
        updateDirectionBtn();
        renderer.setLayout(viewMode);
        break;

      // ── Cycle dag direction ───────────────────────────────────────────────────
      case "d":
      case "D":
        e.preventDefault();
        if (viewMode === "hierarchical") {
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

    renderer.setData(msg.payload.nodes, msg.payload.edges);

    updateSummary(msg.payload.nodes.length, msg.payload.edges.length);
    updateLoadMoreButton();
    scheduleZoomDisplayUpdate();

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

    renderer.appendData(msg.payload.nodes, msg.payload.edges);

    const totalVisible = renderer.graph ? renderer.graph.order : 0;
    const totalEdges = renderer.graph ? renderer.graph.size : 0;
    updateSummary(totalVisible, totalEdges);
    updateLoadMoreButton();
    scheduleZoomDisplayUpdate();

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
    if (tooltipEl) tooltipEl.hidden = true;
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

  // ── Filter state ──────────────────────────────────────────────────────────

  function syncFilterButtonStates() {
    if (toggleContainmentBtn) {
      toggleContainmentBtn.setAttribute("data-active", String(hideStructural));
      toggleContainmentBtn.setAttribute("aria-checked", String(hideStructural));
      toggleContainmentBtn.textContent = hideStructural
        ? "Show Structural Edges"
        : "Hide Structural Edges";
    }
    if (toggleVariablesBtn) {
      toggleVariablesBtn.setAttribute("data-active", String(hideVariables));
      toggleVariablesBtn.setAttribute("aria-checked", String(hideVariables));
      toggleVariablesBtn.textContent = hideVariables
        ? "Show Variables"
        : "Hide Variables";
    }
    for (const { btn, type, label } of EDGE_TYPE_BTNS) {
      if (!btn) continue;
      const on = activeEdgeTypes.has(type);
      btn.setAttribute("data-active", String(on));
      btn.setAttribute("aria-checked", String(on));
      btn.textContent = `${label}: ${on ? "On" : "Off"}`;
    }
  }

  function resetFilters() {
    hideStructural = false;
    hideVariables = false;
    activeEdgeTypes.clear();
    ["calls", "implements", "reads", "writes", "file-dependency"].forEach((t) =>
      activeEdgeTypes.add(t),
    );

    if (renderer) {
      renderer.setFilter("hideStructural", false);
      renderer.setFilter("hideVariables", false);
      for (const { type } of EDGE_TYPE_BTNS) {
        renderer.toggleEdgeType(type, true);
      }
    }

    syncFilterButtonStates();
    showNotice("Filters reset.");
  }

  // ── Layout button labels ───────────────────────────────────────────────────

  function updateViewToggleBtn() {
    if (!viewToggleBtn) return;
    viewToggleBtn.textContent =
      viewMode === "hierarchical" ? "View: Mind Map" : "View: Force";
  }

  function updateDirectionBtn() {
    if (!directionToggleBtn) return;
    if (viewMode !== "hierarchical") {
      directionToggleBtn.disabled = true;
      directionToggleBtn.textContent = `Direction: ${dagDirection}`;
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
