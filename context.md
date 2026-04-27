# Context

## Project Overview
- VSContext is a VS Code extension for workspace symbol graphing, execution tracing, and impact analysis.
- The extension contributes an activity bar view, a chat participant, several commands, and saved-search/tree views.

## Key Files
- `package.json` defines the extension manifest, version, scripts, and packaged files.
- `src/extension.ts` is the main activation entry point.
- `src/graph/` contains graph storage, indexing, and relationship logic.
- `src/chat/` contains the chat participant and context orchestration.
- `src/webview/` and `webview/` contain the graph UI assets.

## Build And Package
- `npm run compile` builds TypeScript into `out/`.
- `vsce package` creates the distributable VSIX.
- README packaging instructions assume `@vscode/vsce` is installed globally when needed.

## Current Conventions
- The manifest version is the release source of truth for packaged VSIX artifacts.
- Generated outputs live in `out/` and are not edited manually.

## Risks
- Packaging depends on native and bundled dependencies already present in `node_modules`.
- Version bumps should stay in sync with the generated VSIX filename.