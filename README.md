# VSContext

![Version](https://img.shields.io/badge/version-0.1.7-2563eb)
![VS Code](https://img.shields.io/badge/vscode-%5E1.95.0-007acc)
![License](https://img.shields.io/badge/license-MIT-16a34a)

VSContext is a VS Code extension for understanding large codebases faster.
It builds a workspace-level symbol graph, then lets you inspect behavior from a selected symbol using:

- Execution Trace: explores downstream call flow from a symbol.
- Impact Analysis: explores affected symbols around a selected point.
- Code Graph View: opens an interactive workspace graph with layout, filtering, and clarity controls.

VSContext is designed for day-to-day navigation, debugging, and refactoring support across multi-language repositories.

## Screenshot

![VSContext](icon.png)

## Why VSContext

- Reduces "where is this used?" hunting across large projects.
- Gives a graph-first view before making risky changes.
- Helps identify high-impact symbols during refactoring.
- Keeps source-jump workflows fast from tree, tables, and graph nodes.

## Typical Use Cases

- Refactoring safety checks before renaming or deleting shared symbols.
- Onboarding into unfamiliar repositories by exploring architecture first.
- Debugging side effects by tracing execution relationships from entry points.
- Estimating change blast radius for release planning and code reviews.
- Reviewing dependency structure in large mixed-language workspaces.

## Release Notes

- Latest updates are documented in [CHANGELOG.md](CHANGELOG.md).

## Key Features

- Workspace symbol indexing with grouped explorer views.
- Sidebar actions from both view toolbar and symbol context menu.
- Interactive graph view with:
  - Mind Map and DAG layouts
  - Direction toggle in DAG mode
  - Edge budget controls for large graphs
  - Edge-type visibility filters (calls, implements, reads, writes, file dependencies)
  - Variable and structural-edge visibility toggles
  - Smart label mode for dense views
  - Overflow toolbar controls and top-bar hide/show toggle
- Execution and impact panels with:
  - Visual node-link traversal graph
  - Sortable Node Details table
  - Text filtering for quick narrowing
  - Click and keyboard activation to open source
- Copilot Chat integration with a dedicated `@vscontext` chat participant for graph-aware context answers

## Commands

- `VSContext: Trace Path`
- `VSContext: Impact`
- `VSContext: View Code Graph`

These commands are available from:

- Command Palette
- VSContext view title toolbar
- Symbol context actions inside the VSContext tree

## Installation

### From Marketplace

1. Open VS Code.
2. Open Extensions (`Ctrl+Shift+X`).
3. Search for `VSContext`.
4. Select the extension and click Install.

### Local Development Install

1. Clone this repository.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to open an Extension Development Host.

## Quick Start

1. Open a workspace containing supported source files.
2. Open the VSContext activity bar icon.
3. Wait for initial indexing to finish.
4. Expand `Workspace` and browse `Files` or `Symbols`.
5. Select a symbol and run `Trace Path` or `Impact`.
6. Open `View Code Graph` for repository-wide structure.

## Sidebar Structure

The VSContext explorer includes:

- `Workspace` root item
- `Files` view:
  - Per-file symbol groups
  - Functions, methods, classes, and variables (with counts)
- `Symbols` view:
  - Type-grouped global symbols (with counts)
- Toolbar actions:
  - `Trace Path`
  - `Impact`
  - `View Code Graph`
- Symbol context actions:
  - `Trace Path`
  - `Impact`

## Copilot Chat Context

VSContext contributes a chat participant named `@vscontext` that uses indexed graph data as context in chat responses.

Participant commands:

- `/summary` for compact workspace structure context
- `/trace` for downstream traversal context of a resolved symbol
- `/impact` for upstream blast-radius context of a resolved symbol
- `/help` for participant usage and symbol resolution hints

Symbol resolution fallback order for `/trace` and `/impact`:

1. `nodeId=<id>` explicitly in your prompt
2. symbol under the active editor cursor
3. last selected symbol in the VSContext tree
4. symbol inferred from prompt text

## Analysis Workflows

### Execution Trace

Use this when you want to follow what may execute from a selected symbol.

- Start from a symbol in the tree.
- Open `Trace Path`.
- Inspect traversal graph and Node Details.
- Click a row or graph node to open source.

### Impact Analysis

Use this when you want to estimate blast radius before changes.

- Start from a symbol in the tree.
- Open `Impact`.
- Sort and filter affected nodes.
- Jump directly to impacted symbols in editor.

### Code Graph View

Use this when you want workspace-level architecture context.

- Toggle view mode: Mind Map or DAG.
- Toggle DAG direction when in DAG mode.
- Use clarity controls to reduce visual noise.
- Use the legend control to switch between `Hide Legend` and `Show Legend`.
- Hover Edge Budget for guidance on performance versus relationship visibility.
- Use edge filters to isolate relationship categories.
- Hide/show top bars using arrow toggle.

Keyboard shortcuts in graph view:

- Arrow keys: move node focus
- `Enter`: open focused node
- `+` / `-`: zoom in/out
- `F`: fit graph to viewport
- `V`: toggle view mode
- `D`: toggle DAG direction
- `/`: focus search

## Supported Language and Scan Scope

### Compatibility Matrix

| Area | Support |
| --- | --- |
| VS Code Engine | `^1.95.0` |
| TypeScript / TSX | Supported |
| JavaScript / JSX | Supported |
| Python | Supported |
| Go | Supported |
| Java | Supported |
| Rust | Supported |
| C / C++ / Headers | Supported |
| C# | Supported |
| PHP | Supported |
| Ruby | Supported |
| Kotlin | Supported |
| Swift | Supported |

VSContext scans these source patterns:

- `**/*.ts`
- `**/*.js`
- `**/*.tsx`
- `**/*.jsx`
- `**/*.py`
- `**/*.go`
- `**/*.java`
- `**/*.rs`
- `**/*.cpp`
- `**/*.cc`
- `**/*.cxx`
- `**/*.c`
- `**/*.h`
- `**/*.hpp`
- `**/*.hh`
- `**/*.hxx`
- `**/*.cs`
- `**/*.php`
- `**/*.phtml`
- `**/*.rb`
- `**/*.kt`
- `**/*.kts`
- `**/*.swift`

Swift files are currently indexed through VS Code document symbol providers (AST pre-scan parser support is not enabled on Windows builds).

VSContext ignores common generated/vendor folders:

- `node_modules`
- `.git`
- `dist`
- `build`
- `out`
- `.venv`
- `venv`
- `__pycache__`
- `site-packages`

Discovery is enforced through `vscode.workspace.findFiles`.

## Configuration

You can configure VSContext in Settings (`settings.json`) using:

- `vscontext.maxIndexedFiles` (default: `2000`)
  - Maximum number of workspace source files scanned for indexing.
- `vscontext.refreshDebounceMs` (default: `300`)
  - Debounce interval for graph refresh after file changes.
- `vscontext.workerBatchSize` (default: `75`, range: `50-100`)
  - Batch size used by worker pre-scan tasks.
- `vscontext.workerCount` (default: `4`, range: `1-8`)
  - Maximum worker threads used for pre-scan processing.
- `vscontext.debugSymbolDetection` (default: `false`)
  - Enables verbose indexing diagnostics in the VSContext output channel.
- `vscontext.chatContextBudget` (default: `medium`, options: `small`, `medium`, `large`)
  - Controls how much VSContext graph context is included in chat responses.
- `vscontext.chatContextDenylist` (default: `[]`)
  - Additional wildcard path patterns excluded from chat context generation.
- `vscontext.maxScannedFiles` (deprecated)
  - Kept for backward compatibility. Use `vscontext.maxIndexedFiles`.

## Architecture Overview

```text
src/
  extension.ts
  analysis/
    executionTrace.ts
    impactAnalysis.ts
  commands/
  graph/
    graphBuilder.ts
    symbolIndexer.ts
    symbolPreScanWorker.ts
  tree/
    contextTreeProvider.ts
  views/
    codeGraphView.ts
    graphWebviewProvider.ts
  webview/
    analysisPanelTemplate.ts
    executionPanel.ts
    impactPanel.ts
  utils/
    logger.ts
    symbolResolver.ts
    workspaceScanner.ts
webview/
  graph.html
  graph.css
  graph.js
```

## Development

### Prerequisites

- Node.js 18+
- npm
- VS Code 1.95+

### Build and Run

1. `npm install`
2. `npm run compile`
3. Press `F5` in VS Code

### Package a VSIX

1. Install VSCE if needed: `npm install -g @vscode/vsce`
2. Build extension: `npm run compile`
3. Package: `vsce package`

This generates a `.vsix` artifact for local distribution.

## Troubleshooting

- Graph appears sparse:
  - Increase `vscontext.maxIndexedFiles`.
  - Verify workspace contains supported file types.
- Indexing feels slow on very large repos:
  - Tune `vscontext.workerCount` and `vscontext.workerBatchSize`.
- Missing symbol details:
  - Enable `vscontext.debugSymbolDetection` and inspect the VSContext output channel.
- Graph too dense:
  - Use edge filters, variable hiding, structural edge hiding, and search.

## License

MIT
