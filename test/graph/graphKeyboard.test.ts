import * as assert from "assert";
import { describe, it } from "mocha";
import graphKeyboardModule from "../../webview/graphKeyboard.js";

const graphKeyboard = graphKeyboardModule as {
  isInteractiveTag: (tagName: string) => boolean;
  isInteractiveRole: (role: string) => boolean;
  shouldHandleGraphShortcut: (context: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    activeWithinGraph?: boolean;
    targetTagName?: string;
    targetRole?: string;
    activeTagName?: string;
    activeRole?: string;
    isContentEditable?: boolean;
  }) => boolean;
};

describe("graphKeyboard guards", () => {
  it("recognizes interactive tags and roles", () => {
    assert.strictEqual(graphKeyboard.isInteractiveTag("input"), true);
    assert.strictEqual(graphKeyboard.isInteractiveTag("DIV"), false);
    assert.strictEqual(graphKeyboard.isInteractiveRole("menuitemcheckbox"), true);
    assert.strictEqual(graphKeyboard.isInteractiveRole("region"), false);
  });

  it("rejects shortcuts when focus is outside graph canvas", () => {
    const shouldHandle = graphKeyboard.shouldHandleGraphShortcut({
      activeWithinGraph: false,
      targetTagName: "DIV",
      activeTagName: "DIV",
    });

    assert.strictEqual(shouldHandle, false);
  });

  it("rejects shortcuts on interactive controls", () => {
    const shouldHandle = graphKeyboard.shouldHandleGraphShortcut({
      activeWithinGraph: true,
      targetTagName: "BUTTON",
      activeTagName: "BUTTON",
    });

    assert.strictEqual(shouldHandle, false);
  });

  it("rejects shortcuts when modifier keys are held", () => {
    const shouldHandle = graphKeyboard.shouldHandleGraphShortcut({
      ctrlKey: true,
      activeWithinGraph: true,
      targetTagName: "DIV",
      activeTagName: "DIV",
    });

    assert.strictEqual(shouldHandle, false);
  });

  it("allows shortcuts for graph-focused non-interactive context", () => {
    const shouldHandle = graphKeyboard.shouldHandleGraphShortcut({
      activeWithinGraph: true,
      targetTagName: "DIV",
      activeTagName: "MAIN",
      targetRole: "",
      activeRole: "",
      isContentEditable: false,
    });

    assert.strictEqual(shouldHandle, true);
  });
});
