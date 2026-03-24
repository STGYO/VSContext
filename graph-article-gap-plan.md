# VSContext vs. Codebase Parser Gap Plan

## Goal

Use the Medium article as the target shape and turn VSContext into a hybrid codebase understanding tool, while preserving the extension's current strengths: persistent workspace graph indexing, trace and impact traversals, graph visualization, and the chat participant.

## What the article has that VSContext does not yet have

- Repository traversal that classifies files into source, test, template, and documentation groups.
- Content parsing beyond symbols, including API endpoints, imports, test targets, and documentation concepts.
- A semantic layer with embeddings and vector search.
- A graph database style model for richer relationships such as test links, API flows, file dependencies, and cross-file structural links.
- Natural language query decomposition for issues and architecture questions.
- Specialized workflows like repository summarization and issue solving.
- Chunking and context preservation for large files and large repositories.
- Query outputs that combine graph evidence and semantic evidence.

## What VSContext already has and should be kept

- Persistent workspace graph hydration and cache rebuilds on startup.
- Incremental updates when files are saved, created, or deleted.
- Symbol relationships for calls, implementations, reads, and writes.
- Trace and impact traversals.
- A graph webview with Mind Map and DAG layouts, edge filtering, search, and large graph load-more behavior.
- A chat participant that can summarize, trace, and explain impact.

## Gap Analysis

### 1. Ingestion is symbol-first, not repository-first

Current indexing is built around supported source-file symbols and relationships. The article's approach starts one level earlier, by traversing the repository, categorizing files, and routing each category into different extractors. VSContext needs a repository ingestion layer that understands file role before symbol extraction begins.

### 2. There is no semantic retrieval layer

The extension currently does structural traversal and substring search in the graph view. The article relies on embeddings and vector retrieval for conceptual matching, issue decomposition, and document/code lookup. That layer is missing entirely.

### 3. Relationship coverage is narrower

VSContext models calls, implementations, reads, and writes. The article describes additional links such as test-to-target, file dependency, API flow, and documentation relationships. Those edges are not represented today.

### 4. The chat surface is lightweight

The chat participant can summarize or explain trace and impact from the existing graph summary. It does not perform issue decomposition, hybrid retrieval, or synthesized answer generation from graph plus semantic context.

### 5. Large-codebase handling is present, but not article-level

VSContext has load-more chunking and edge budgets, but the article implies scalable ingestion across whole repositories, chunked document processing, and semantic storage for large corpora. That infrastructure is not present.

### 6. No dedicated workflow for tests, docs, or APIs

The article treats tests and docs as first-class citizens and extracts high-value metadata from them. VSContext does not currently parse those categories into dedicated knowledge objects or relationships.

## Proposed Plan

### Phase 1. Define the target knowledge model

Deliverables:

- A unified schema for files, symbols, chunks, tests, docs, APIs, and issues.
- A relationship catalog that extends the current graph with file dependency, test coverage, import, documentation reference, and API flow edges.
- A decision on whether embeddings are stored locally, remotely, or through an abstraction layer.

Acceptance criteria:

- The schema supports both structural graph traversal and semantic retrieval.
- New edge types are modeled without breaking the current trace and impact workflows.

### Phase 2. Add repository classification and parsing

Deliverables:

- A repository traversal pipeline that classifies files before parsing.
- Dedicated parsers for source, test, doc, and template files.
- Chunking for large files with overlap so meaning is preserved across boundaries.

Acceptance criteria:

- Files are assigned a role before extraction.
- Test files produce coverage targets and doc files produce topic summaries.

### Phase 3. Add semantic indexing

Deliverables:

- An embedding pipeline for file chunks, symbol summaries, tests, and docs.
- A vector retrieval API for similarity search and context lookup.
- Retrieval ranking that can combine semantic similarity with graph distance.

Acceptance criteria:

- The extension can answer queries using semantic matches, not only exact name matches.
- Graph results and semantic results can be merged into one context packet.

### Phase 4. Expand graph extraction

Deliverables:

- Import relationships between files and modules.
- File dependency edges.
- Test-to-target edges.
- API route or endpoint nodes where supported by language parsers.
- Documentation reference edges.

Acceptance criteria:

- The graph can explain not just what calls what, but what depends on what and what covers what.
- The existing trace and impact traversals continue to work with the larger graph.

### Phase 5. Build a query orchestration layer

Deliverables:

- Natural language query parsing.
- Query decomposition into graph and vector subqueries.
- A result synthesizer that merges structural and semantic evidence.
- Query templates for common tasks such as root cause, blast radius, similar code, and test coverage.

Acceptance criteria:

- A user can ask broad questions like which files are relevant to a bug or where a function is covered by tests.
- Results include a structured explanation and the underlying evidence.

### Phase 6. Add article-style workflows

Deliverables:

- Repository summary generation.
- Issue intake and solution workflow.
- A richer chat experience that can answer from hybrid context.
- Optional visualization queries that explain the graph slice behind an answer.

Acceptance criteria:

- The chat participant can produce a summary, a trace explanation, or an issue-oriented answer from the same knowledge base.
- The extension exposes a clear path from a user question to graph evidence and semantic evidence.

### Phase 7. Improve scalability and operability

Deliverables:

- Background indexing with progress and cancellation.
- Incremental re-embedding and re-indexing for changed files.
- Cache versioning for both graph and semantic indexes.
- Telemetry or logging around ingestion, retrieval, and truncation.

Acceptance criteria:

- Large repositories can be ingested without blocking the UI for long periods.
- Cache rebuilds are predictable and safe across workspace changes.

### Phase 8. Add product quality features

Deliverables:

- Saved searches or saved graph views.
- Export formats for graph slices and query results.
- Better cross-linking from answers back to source files.
- Tests for parsers, query orchestration, and incremental updates.

Acceptance criteria:

- Users can revisit useful queries and graph views.
- Output can be shared or reused outside the extension.

## Recommended implementation order

1. Define schema and relationship extensions.
2. Add repository categorization and chunking.
3. Add embeddings and vector retrieval.
4. Expand graph extraction to tests, docs, imports, and API routes.
5. Add hybrid query orchestration and chat synthesis.
6. Harden scalability, caching, and tests.

## Key product decisions to make early

- Whether semantic storage should be local-first or depend on an external service.
- Whether the issue workflow should live inside the extension or call out to an external service.
- How aggressively to expand language-specific parsers beyond the current supported symbol set.
- Whether graph query language should remain natural-language-first or also expose a formal query syntax.

## Recommendation

Treat the current VSContext architecture as the graph and UI foundation, then layer the article's missing capabilities on top in this order: ingestion, semantics, richer relationships, query orchestration, specialized workflows. That keeps the existing extension useful while moving it toward the hybrid graph plus vector design described in the article.