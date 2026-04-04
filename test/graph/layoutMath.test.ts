import * as assert from "assert";
import { describe, it } from "mocha";
import layoutMath from "../../webview/layoutMath.js";

describe("layoutMath", () => {
  it("estimateNodeWidth respects floor", () => {
    const width = layoutMath.estimateNodeWidth({ label: "x", size: 0 }, 90);
    assert.strictEqual(width >= 90, true);
  });

  it("packFileTrees positions file roots in monotonic order", () => {
    const result = layoutMath.packFileTrees(
      [
        {
          fileId: "file-a",
          levels: [
            { level: 0, nodes: [{ id: "file-a", label: "a.ts", width: 140 }] },
            {
              level: 1,
              nodes: [
                { id: "a-1", label: "Definitions", width: 120 },
                { id: "a-2", label: "Dependencies", width: 120 },
              ],
            },
          ],
        },
        {
          fileId: "file-b",
          levels: [
            { level: 0, nodes: [{ id: "file-b", label: "b.ts", width: 140 }] },
            {
              level: 1,
              nodes: [
                { id: "b-1", label: "Definitions", width: 120 },
                { id: "b-2", label: "Dependencies", width: 120 },
              ],
            },
          ],
        },
      ],
      {
        fileGap: 320,
        levelGap: 160,
        siblingGap: 40,
        nodeWidthFloor: 80,
      },
    );

    assert.ok(result.positions["file-a"]);
    assert.ok(result.positions["file-b"]);
    assert.ok(result.positions["file-b"].x > result.positions["file-a"].x);
  });

  it("resolveLevelOverlaps fixes colliding entries", () => {
    const resolved = layoutMath.resolveLevelOverlaps(
      [
        { id: "n1", x: 0, width: 100 },
        { id: "n2", x: 10, width: 100 },
      ],
      {
        collisionPadding: 16,
        maxCollisionPasses: 8,
        desiredCenter: 0,
      },
    );

    assert.ok(resolved.adjustments > 0);
    const left = resolved.entries[0];
    const right = resolved.entries[1];
    const gap = right.x - left.x;
    assert.ok(gap >= 116);
  });
});
