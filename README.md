# VSContext

VSContext is a single, free VS Code extension that builds a workspace symbol graph and provides two analysis tools:

- Execution trace from a selected function
- Impact analysis from a selected function

## Screenshot

![VSContext](icon.png)

## Commands

- `VSContext: Trace Execution Path`
- `VSContext: Find Impact of Change`

## Installation

1. Open VS Code.
1. Open Extensions.
1. Search for `VSContext`.
1. Click Install.

For local development build:

1. Clone this repository.
1. Run `npm install`.
1. Run `npm run compile`.
1. Press `F5` to start an Extension Development Host.

## Sidebar

The `VSContext Explorer` view contains:

- `Workspace`
- `Files` and indexed methods
- `Analysis`
  - `Trace Execution Path`
  - `Impact Analysis`

## Usage

1. Open a workspace with TypeScript, JavaScript, Python, Go, or Rust files.
1. Open `VSContext Explorer` from the Activity Bar.
1. Expand `Workspace` and browse indexed methods under `Files`.
1. Select a function and run `VSContext: Trace Execution Path`.
1. Select a function and run `VSContext: Find Impact of Change`.
1. Click nodes in either analysis panel to jump to source.

## Supported Indexing Scope

Scanned file patterns:

- `**/*.ts`
- `**/*.js`
- `**/*.tsx`
- `**/*.jsx`
- `**/*.py`
- `**/*.go`
- `**/*.java`
- `**/*.rs`
- `**/*.cpp`
- `**/*.c`
- `**/*.h`

Ignored folders:

- `node_modules`
- `.git`
- `dist`
- `build`
- `out`
- `.venv`
- `venv`
- `__pycache__`
- `site-packages`

These rules are enforced through `vscode.workspace.findFiles`.

## Architecture

```text
src/
  extension.ts
  graph/
    graphBuilder.ts
    symbolIndexer.ts
  analysis/
    executionTrace.ts
    impactAnalysis.ts
  tree/
    contextTreeProvider.ts
  webview/
    executionPanel.ts
    impactPanel.ts
  utils/
    workspaceScanner.ts
    symbolResolver.ts
    logger.ts
```

## Configuration

- `vscontext.maxIndexedFiles`: maximum files scanned for indexing.
- `vscontext.refreshDebounceMs`: debounce delay before graph refresh.
- `vscontext.workerBatchSize`: files per worker pre-scan batch.
- `vscontext.workerCount`: worker thread count for pre-scan.

## License

MIT
