# Changelog

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
