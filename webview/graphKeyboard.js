// webview/graphKeyboard.js
// Keyboard shortcut guards shared by the graph webview runtime and tests.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.VSContextGraphKeyboard = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "checkbox",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "switch",
  ]);

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isInteractiveTag(tagName) {
    return INTERACTIVE_TAGS.has(String(tagName || "").toUpperCase());
  }

  function isInteractiveRole(role) {
    return INTERACTIVE_ROLES.has(normalize(role));
  }

  function shouldHandleGraphShortcut(context) {
    if (context?.ctrlKey || context?.metaKey || context?.altKey) {
      return false;
    }

    if (!context?.activeWithinGraph) {
      return false;
    }

    if (context?.isContentEditable) {
      return false;
    }

    if (
      isInteractiveTag(context?.targetTagName) ||
      isInteractiveRole(context?.targetRole) ||
      isInteractiveTag(context?.activeTagName) ||
      isInteractiveRole(context?.activeRole)
    ) {
      return false;
    }

    return true;
  }

  return {
    isInteractiveTag,
    isInteractiveRole,
    shouldHandleGraphShortcut,
  };
});
