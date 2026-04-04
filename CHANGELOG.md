# Changelog

## 0.2.1

- Wired saved searches and saved views into the VSContext activity bar view.
- Added cross-link enhancement for chat output so referenced symbols and files resolve back to source.
- Replaced the PDF export placeholder with a real PDF file generator.
- Bumped the extension version for the next marketplace release.

## 0.2.0

- Added a local semantic indexing pipeline with chunked file records and symbol summaries
- Added native VS Code workspace symbol queries to enrich retrieval results
- Surfaced semantic matches in chat summaries to complement structural graph context

## 0.1.9

- Added a shared knowledge-model schema for graph nodes and relationships so future test, documentation, API, and semantic layers can build on a stable core model
- Versioned persisted graph snapshots with explicit knowledge-model compatibility checks
- Added graph payload metadata that exposes the active knowledge-model version and catalog to the code graph view

## 0.1.8

- Expanded language coverage with parser-backed pre-scan support for C#, PHP, Ruby, and Kotlin
- Expanded C/C++ source coverage for additional extensions (`.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`)
- Added workspace scanning support for Swift files (indexed through VS Code document symbol providers)
- Added legend visibility control in the graph panel with explicit `Hide Legend` and `Show Legend` states
- Added Edge Budget tooltip guidance, including dynamic current-value context in the graph UI
- Updated graph fallback template parity so legend toggle and Edge Budget tooltip behavior are consistent

## 0.1.7

- Added a VSContext chat participant (`@vscontext`) for Copilot Chat with `/summary`, `/trace`, `/impact`, and `/help` commands
- Added compact graph-context generation with configurable budget tiers (`small`, `medium`, `large`)
- Added balanced chat-context filtering with configurable denylist patterns (`vscontext.chatContextDenylist`)
- Added symbol focus fallback for chat context: explicit node ID, active editor selection, VSContext tree selection, then prompt inference
- Raised minimum VS Code engine requirement to `^1.95.0` for chat API compatibility

## 0.1.6

- Added a single toolbar arrow toggle to hide/show top graph bars (up arrow when visible, down arrow when hidden)
- Improved graph webview controls with overflow menu behavior and responsive top-bar collapse handling

## 0.1.5

- Added a dedicated Code Graph view and graph webview provider integration
- Added graph webview assets (`graph.html`, `graph.css`, `graph.js`) for interactive graph rendering
- Enhanced graph relationship modeling and rendering with richer edge handling
- Improved symbol extraction and indexing across supported Tree-sitter language parsers
- Implemented graph caching and hydration to improve graph load and refresh performance
- Refactored core graph/indexing modules and removed unused code paths for better maintainability

## 0.1.4

- Expanded fallback symbol detection across all supported languages to improve class, method, and variable indexing reliability

## 0.1.3

- Updated execution and impact analysis panels to render visual node-link graphs

## 0.1.2

- Added a dedicated Activity Bar icon contribution asset for the VSContext view container

## 0.1.1

- Production hardening pass for marketplace readiness
- Safe workspace scanning with include/exclude globs
- Debounced index refresh on workspace changes
- Strengthened command and activation error handling
- Added marketplace metadata and extension configuration
- Hardened webview panels with CSP and nonce

## 0.1.0

- Initial clean extension release
- Workspace symbol graph indexing
- Execution trace command and panel
- Impact analysis command and panel
- Sidebar explorer with file and method tree
