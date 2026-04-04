// webview/layoutMath.js
// Pure layout helpers shared by the Cytoscape renderer and unit tests.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.VSContextLayoutMath = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function estimateNodeWidth(node, floorWidth) {
    const minimum = Number.isFinite(floorWidth) ? floorWidth : 72;
    const label = String(node?.label || node?.name || "");
    const size = Number(node?.size || 0);
    const textWidth = label.length <= 24
      ? label.length * 6.8
      : label.length * 6.2;
    return Math.max(minimum, Math.round(size + 24 + textWidth));
  }

  function sortNodesByLabel(left, right) {
    return String(left.label || "").localeCompare(String(right.label || ""));
  }

  function resolveLevelOverlaps(entries, options) {
    const collisionPadding = Number.isFinite(options?.collisionPadding)
      ? options.collisionPadding
      : 16;
    const maxCollisionPasses = Number.isFinite(options?.maxCollisionPasses)
      ? options.maxCollisionPasses
      : 8;
    const desiredCenter = Number.isFinite(options?.desiredCenter)
      ? options.desiredCenter
      : 0;

    const ordered = [...entries].sort((left, right) => left.x - right.x);
    let adjustments = 0;
    let passes = 0;

    for (let pass = 0; pass < maxCollisionPasses; pass += 1) {
      passes += 1;
      let changed = false;

      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const minimumGap =
          (previous.width + current.width) / 2 + collisionPadding;
        const actualGap = current.x - previous.x;
        if (actualGap >= minimumGap) {
          continue;
        }

        const delta = minimumGap - actualGap;
        current.x += delta;
        adjustments += 1;
        changed = true;
      }

      if (!changed) {
        break;
      }
    }

    if (ordered.length > 0) {
      const leftEdge = ordered[0].x - ordered[0].width / 2;
      const rightMost = ordered[ordered.length - 1];
      const rightEdge = rightMost.x + rightMost.width / 2;
      const center = (leftEdge + rightEdge) / 2;
      const centerShift = desiredCenter - center;
      if (centerShift !== 0) {
        for (const entry of ordered) {
          entry.x += centerShift;
        }
      }
    }

    return {
      entries: ordered,
      adjustments,
      passes,
    };
  }

  function packFileTrees(fileTrees, options) {
    const fileGap = Number.isFinite(options?.fileGap) ? options.fileGap : 300;
    const levelGap = Number.isFinite(options?.levelGap) ? options.levelGap : 170;
    const siblingGap = Number.isFinite(options?.siblingGap)
      ? options.siblingGap
      : 36;
    const nodeWidthFloor = Number.isFinite(options?.nodeWidthFloor)
      ? options.nodeWidthFloor
      : 72;
    const collisionPadding = Number.isFinite(options?.collisionPadding)
      ? options.collisionPadding
      : 16;
    const maxCollisionPasses = Number.isFinite(options?.maxCollisionPasses)
      ? options.maxCollisionPasses
      : 8;

    const normalizedTrees = fileTrees.map((tree) => {
      const levels = tree.levels
        .map((levelEntry) => {
          const nodes = [...levelEntry.nodes]
            .sort(sortNodesByLabel)
            .map((node) => {
              const width = Number.isFinite(node.width)
                ? node.width
                : estimateNodeWidth(node, nodeWidthFloor);
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
        ...levels.map((level) => level.levelWidth),
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
    let overlapAdjustments = 0;
    let collisionPasses = 0;

    let cursor = -totalWidth / 2;
    for (const tree of normalizedTrees) {
      const treeCenter = cursor + tree.treeWidth / 2;
      cursor += tree.treeWidth + fileGap;

      for (const levelEntry of tree.levels) {
        const rowNodes = levelEntry.nodes;
        if (rowNodes.length === 0) {
          continue;
        }

        let xCursor = treeCenter - levelEntry.levelWidth / 2;
        const row = [];
        for (const node of rowNodes) {
          const x = xCursor + node.width / 2;
          row.push({
            id: node.id,
            width: node.width,
            x,
          });
          xCursor += node.width + siblingGap;
        }

        const overlapResolution = resolveLevelOverlaps(row, {
          collisionPadding,
          maxCollisionPasses,
          desiredCenter: treeCenter,
        });

        overlapAdjustments += overlapResolution.adjustments;
        collisionPasses += overlapResolution.passes;

        const y = levelEntry.level * levelGap;
        for (const entry of overlapResolution.entries) {
          positions[entry.id] = { x: entry.x, y };
        }
      }
    }

    return {
      positions,
      diagnostics: {
        overlapAdjustments,
        collisionPasses,
        totalWidth,
        treeCount: normalizedTrees.length,
      },
    };
  }

  function orientPosition(position, direction) {
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

  function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return String(hash >>> 0);
  }

  function buildLayoutSignature(input) {
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

    return hashString(raw);
  }

  return {
    estimateNodeWidth,
    resolveLevelOverlaps,
    packFileTrees,
    orientPosition,
    buildLayoutSignature,
  };
});
