import * as vscode from 'vscode';

import { findImpactOfChange } from '../analysis/impactAnalysis';
import { traceExecutionPath, type ExecutionTraceResult, type TraversalEdge, type TraversalNode } from '../analysis/executionTrace';
import { type GraphNode, type WorkspaceFileRelationship, type WorkspaceGraph } from '../graph/graphBuilder';
import { type SemanticSearchHit, type WorkspaceSemanticIndexer } from '../semantic/semanticIndexer';
import { type Logger } from '../utils/logger';
import { type ChatContextBudget } from './contextFilters';
import { resolveFocusNode } from './focusResolver';
import { buildWorkspaceContextSummary } from './contextSummary';

export type QueryTemplateId = 'summary' | 'trace' | 'impact' | 'root-cause' | 'blast-radius' | 'similar-code' | 'test-coverage' | 'general';

export interface HybridQueryInputs {
  readonly request: vscode.ChatRequest;
  readonly graph: WorkspaceGraph;
  readonly semanticIndexer: WorkspaceSemanticIndexer;
  readonly logger: Logger;
  readonly budget: ChatContextBudget;
  readonly denylistPatterns: string[];
  readonly getLastTreeSelectionNodeId: () => string | undefined;
}

export interface QueryPlan {
  readonly templateId: QueryTemplateId;
  readonly graphQueries: string[];
  readonly semanticQueries: string[];
  readonly semanticMaxResults: number;
  readonly useTrace: boolean;
  readonly useImpact: boolean;
}

export interface FileRelationshipEvidence {
  readonly sourceFilePath: string;
  readonly targetFilePath: string;
  readonly sourceUriString: string;
  readonly targetUriString: string;
  readonly relationship: WorkspaceFileRelationship['relationship'];
}

export interface HybridQueryResult {
  readonly templateId: QueryTemplateId;
  readonly title: string;
  readonly prompt: string;
  readonly focusNode: GraphNode | undefined;
  readonly plan: QueryPlan;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly caveats: string[];
  readonly semanticHits: SemanticSearchHit[];
  readonly fileRelationships: FileRelationshipEvidence[];
  readonly traceResult: ExecutionTraceResult | undefined;
  readonly impactResult: Awaited<ReturnType<typeof findImpactOfChange>> | undefined;
  readonly renderedMarkdown: string;
  readonly modelPrompt: string;
}

const TEMPLATE_LABELS: Record<QueryTemplateId, string> = {
  summary: 'Workspace Summary',
  trace: 'Execution Trace',
  impact: 'Impact Analysis',
  'root-cause': 'Root Cause',
  'blast-radius': 'Blast Radius',
  'similar-code': 'Similar Code',
  'test-coverage': 'Test Coverage',
  general: 'Hybrid Query',
};

export async function orchestrateHybridQuery(inputs: HybridQueryInputs): Promise<HybridQueryResult> {
  const templateId = resolveTemplateId(inputs.request.command, inputs.request.prompt);
  const focusNode = resolveFocusNode(inputs.graph, {
    explicitNodeId: extractExplicitNodeId(inputs.request),
    treeSelectionNodeId: inputs.getLastTreeSelectionNodeId(),
    prompt: inputs.request.prompt,
  });

  inputs.logger.info(`[VSContext] Query template resolved: ${templateId}${focusNode ? ` (${focusNode.symbolName})` : ''}.`);

  const plan = buildQueryPlan(templateId, inputs.request.prompt, focusNode);
  const summary = await buildWorkspaceContextSummary(inputs.graph, {
    budget: inputs.budget,
    denylistPatterns: inputs.denylistPatterns,
    focusNode: templateId === 'similar-code' ? undefined : focusNode,
  });

  const [semanticHits, traceResult, impactResult, fileRelationships] = await Promise.all([
    runSemanticQueries(inputs.semanticIndexer, inputs.graph, plan.semanticQueries, focusNode, plan.semanticMaxResults),
    plan.useTrace && focusNode ? traceExecutionPath(inputs.graph, focusNode.id, 8) : Promise.resolve(undefined),
    plan.useImpact && focusNode ? findImpactOfChange(inputs.graph, focusNode.id, 8) : Promise.resolve(undefined),
    Promise.resolve(buildFileRelationshipEvidence(inputs.graph, focusNode, templateId)),
  ]);

  const confidence = calculateConfidence(focusNode, semanticHits, traceResult, impactResult, fileRelationships);
  const caveats = buildCaveats(focusNode, semanticHits, fileRelationships, templateId);
  const renderedMarkdown = renderQueryResult({
    templateId,
    prompt: inputs.request.prompt,
    focusNode,
    plan,
    summary,
    semanticHits,
    traceResult,
    impactResult,
    fileRelationships,
    confidence,
    caveats,
  });

  return {
    templateId,
    title: TEMPLATE_LABELS[templateId],
    prompt: inputs.request.prompt,
    focusNode,
    plan,
    confidence,
    caveats,
    semanticHits,
    fileRelationships,
    traceResult,
    impactResult,
    renderedMarkdown,
    modelPrompt: buildModelPrompt({
      templateId,
      prompt: inputs.request.prompt,
      renderedMarkdown,
      confidence,
      caveats,
    }),
  };
}

export function getQueryHelpMessage(): string {
  return [
    'VSContext chat commands:',
    '- /summary: show compact workspace context summary.',
    '- /trace: focus on downstream traversal around the resolved symbol.',
    '- /impact: focus on upstream impact around the resolved symbol.',
    '- /root-cause: investigate likely causes using graph and semantic evidence.',
    '- /blast-radius: estimate the impact surface and dependent files.',
    '- /similar-code: find semantically similar code and nearby graph context.',
    '- /test-coverage: surface tests and coverage links for the resolved symbol.',
    '- /help: show VSContext chat participant usage and focus resolution rules.',
    '',
    'Focus resolution order:',
    '1. explicit nodeId in prompt (nodeId=<id>)',
    '2. active editor symbol under cursor',
    '3. last selected symbol in VSContext tree',
    '4. symbol name inferred from prompt text',
  ].join('\n');
}

function buildQueryPlan(templateId: QueryTemplateId, prompt: string, focusNode: GraphNode | undefined): QueryPlan {
  const focusName = focusNode?.symbolName.trim() ?? '';
  const promptText = prompt.trim();
  const semanticQueries = new Set<string>();

  if (focusName.length > 0) {
    semanticQueries.add(focusName);
  }

  if (promptText.length > 0) {
    semanticQueries.add(promptText);
  }

  const graphQueries: string[] = ['workspace summary'];
  let useTrace = false;
  let useImpact = false;

  switch (templateId) {
    case 'trace':
      graphQueries.push('downstream execution trace');
      useTrace = true;
      break;
    case 'impact':
      graphQueries.push('upstream impact analysis');
      useImpact = true;
      break;
    case 'root-cause':
      graphQueries.push('downstream execution trace');
      graphQueries.push('upstream impact analysis');
      graphQueries.push('cross-file structural evidence');
      useTrace = true;
      useImpact = true;
      if (focusName.length > 0) {
        semanticQueries.add(`${focusName} failure`);
        semanticQueries.add(`${focusName} bug`);
      }
      break;
    case 'blast-radius':
      graphQueries.push('upstream impact analysis');
      graphQueries.push('dependent files and imports');
      useImpact = true;
      if (focusName.length > 0) {
        semanticQueries.add(`${focusName} dependency`);
      }
      break;
    case 'similar-code':
      graphQueries.push('structural neighborhood');
      graphQueries.push('same-file siblings');
      if (focusName.length > 0) {
        semanticQueries.add(`${focusName} implementation`);
        semanticQueries.add(`${focusName} similar code`);
      }
      break;
    case 'test-coverage':
      graphQueries.push('test coverage links');
      graphQueries.push('test file relationships');
      if (focusName.length > 0) {
        semanticQueries.add(`${focusName} test`);
        semanticQueries.add(`${focusName} coverage`);
      }
      break;
    case 'summary':
    case 'general':
    default:
      graphQueries.push('workspace hotspots');
      break;
  }

  return {
    templateId,
    graphQueries,
    semanticQueries: [...semanticQueries],
    semanticMaxResults: templateId === 'similar-code' ? 8 : 6,
    useTrace,
    useImpact,
  };
}

function resolveTemplateId(command: string | undefined, prompt: string): QueryTemplateId {
  const normalizedCommand = command?.trim().toLowerCase();
  if (
    normalizedCommand === 'summary'
    || normalizedCommand === 'trace'
    || normalizedCommand === 'impact'
    || normalizedCommand === 'root-cause'
    || normalizedCommand === 'blast-radius'
    || normalizedCommand === 'similar-code'
    || normalizedCommand === 'test-coverage'
  ) {
    return normalizedCommand;
  }

  const normalizedPrompt = prompt.toLowerCase();
  if (/\b(root cause|why did|cause|failure|bug)\b/.test(normalizedPrompt)) {
    return 'root-cause';
  }

  if (/\b(blast radius|impact|affected|downstream|upstream)\b/.test(normalizedPrompt)) {
    return 'blast-radius';
  }

  if (/\b(similar|similar code|related code|pattern match)\b/.test(normalizedPrompt)) {
    return 'similar-code';
  }

  if (/\b(test coverage|coverage|tests?|specs?)\b/.test(normalizedPrompt)) {
    return 'test-coverage';
  }

  if (/\b(trace|walk downstream|follow calls)\b/.test(normalizedPrompt)) {
    return 'trace';
  }

  if (/\b(impact|blast radius|upstream)\b/.test(normalizedPrompt)) {
    return 'impact';
  }

  if (/\b(summary|summarize|overview)\b/.test(normalizedPrompt)) {
    return 'summary';
  }

  return 'general';
}

function extractExplicitNodeId(request: vscode.ChatRequest): string | undefined {
  const match = /nodeId\s*=\s*([A-Za-z0-9:_\-/.]+)/i.exec(request.prompt);
  if (!match) {
    return undefined;
  }

  return match[1];
}

async function runSemanticQueries(
  semanticIndexer: WorkspaceSemanticIndexer,
  graph: WorkspaceGraph,
  queries: readonly string[],
  focusNode: GraphNode | undefined,
  maxResults: number,
): Promise<SemanticSearchHit[]> {
  if (queries.length === 0) {
    return [];
  }

  const results = await Promise.all(
    queries.map((query) => semanticIndexer.search(graph, query, {
      focusNodeId: focusNode?.id,
      maxResults,
    })),
  );

  return mergeSemanticHits(results.flatMap((result) => result.hits), maxResults);
}

function mergeSemanticHits(hits: readonly SemanticSearchHit[], maxResults: number): SemanticSearchHit[] {
  const merged = new Map<string, SemanticSearchHit>();

  for (const hit of hits) {
    const existing = merged.get(hit.id);
    if (!existing) {
      merged.set(hit.id, hit);
      continue;
    }

    merged.set(hit.id, {
      ...existing,
      score: Math.max(existing.score, hit.score),
      reasons: [...new Set([...existing.reasons, ...hit.reasons])],
    });
  }

  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, maxResults);
}

function buildFileRelationshipEvidence(
  graph: WorkspaceGraph,
  focusNode: GraphNode | undefined,
  templateId: QueryTemplateId,
): FileRelationshipEvidence[] {
  if (!focusNode) {
    return [];
  }

  const focusFilePath = focusNode.filePath;
  const relationshipPreference = templateId === 'test-coverage'
    ? new Set(['covers', 'imports', 'documents'])
    : templateId === 'similar-code'
      ? new Set(['related-to', 'imports'])
      : new Set(['imports', 'related-to', 'documents', 'covers']);

  return graph.fileRelationships
    .filter((relationship) => relationshipPreference.has(relationship.relationship))
    .filter((relationship) => relationship.sourceFilePath === focusFilePath || relationship.targetFilePath === focusFilePath)
    .slice(0, 12)
    .map((relationship) => ({
      sourceFilePath: relationship.sourceFilePath,
      targetFilePath: relationship.targetFilePath,
      sourceUriString: relationship.sourceUriString,
      targetUriString: relationship.targetUriString,
      relationship: relationship.relationship,
    }));
}

function calculateConfidence(
  focusNode: GraphNode | undefined,
  semanticHits: readonly SemanticSearchHit[],
  traceResult: ExecutionTraceResult | undefined,
  impactResult: Awaited<ReturnType<typeof findImpactOfChange>> | undefined,
  fileRelationships: readonly FileRelationshipEvidence[],
): 'low' | 'medium' | 'high' {
  let score = 0;
  if (focusNode) {
    score += 1;
  }

  if (semanticHits.length > 0) {
    score += 1;
  }

  if ((traceResult?.nodes.length ?? 0) > 1) {
    score += 1;
  }

  if ((impactResult?.nodes.length ?? 0) > 1) {
    score += 1;
  }

  if (fileRelationships.length > 0) {
    score += 1;
  }

  if (score >= 4) {
    return 'high';
  }

  if (score >= 2) {
    return 'medium';
  }

  return 'low';
}

function buildCaveats(
  focusNode: GraphNode | undefined,
  semanticHits: readonly SemanticSearchHit[],
  fileRelationships: readonly FileRelationshipEvidence[],
  templateId: QueryTemplateId,
): string[] {
  const caveats: string[] = [];

  if (!focusNode) {
    caveats.push('No exact focus symbol was resolved, so the answer leans on workspace-level evidence.');
  }

  if (semanticHits.length === 0) {
    caveats.push('No strong semantic matches were found for the current query.');
  }

  if (templateId === 'test-coverage' && !fileRelationships.some((entry) => entry.relationship === 'covers')) {
    caveats.push('No explicit coverage links were available, so test coverage was inferred from test files and related imports.');
  }

  if (templateId === 'similar-code' && semanticHits.length < 3) {
    caveats.push('Similarity ranking is thin for this query; compare the top semantic hits with the graph neighborhood.');
  }

  return caveats;
}

function renderQueryResult(input: {
  readonly templateId: QueryTemplateId;
  readonly prompt: string;
  readonly focusNode: GraphNode | undefined;
  readonly plan: QueryPlan;
  readonly summary: string;
  readonly semanticHits: readonly SemanticSearchHit[];
  readonly traceResult: ExecutionTraceResult | undefined;
  readonly impactResult: Awaited<ReturnType<typeof findImpactOfChange>> | undefined;
  readonly fileRelationships: readonly FileRelationshipEvidence[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly caveats: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push('## VSContext Query');
  lines.push(`- Template: ${TEMPLATE_LABELS[input.templateId]}`);
  lines.push(`- Confidence: ${input.confidence}`);
  lines.push(`- User request: ${input.prompt.trim().length > 0 ? input.prompt.trim() : 'No prompt supplied.'}`);

  if (input.focusNode) {
    lines.push(`- Focus: ${formatNodeLink(input.focusNode)}`);
  }

  lines.push('');
  lines.push('### Query Decomposition');
  lines.push('- Graph subqueries:');
  for (const query of input.plan.graphQueries) {
    lines.push(`  - ${query}`);
  }

  lines.push('- Semantic subqueries:');
  if (input.plan.semanticQueries.length === 0) {
    lines.push('  - None');
  } else {
    for (const query of input.plan.semanticQueries) {
      lines.push(`  - ${query}`);
    }
  }

  lines.push('');
  lines.push('### Structural Evidence');
  lines.push(input.summary);

  if (input.traceResult) {
    lines.push('');
    lines.push('#### Downstream Trace');
    lines.push(...renderTraversal('trace', input.traceResult.nodes, input.traceResult.edges));
  }

  if (input.impactResult) {
    lines.push('');
    lines.push('#### Upstream Impact');
    lines.push(...renderTraversal('impact', input.impactResult.nodes, input.impactResult.edges));
  }

  if (input.fileRelationships.length > 0) {
    lines.push('');
    lines.push('#### File Relationships');
    for (const relationship of input.fileRelationships) {
      lines.push(`- ${relationship.relationship}: ${formatFileUriLink(relationship.sourceFilePath, relationship.sourceUriString)} -> ${formatFileUriLink(relationship.targetFilePath, relationship.targetUriString)}`);
    }
  }

  lines.push('');
  lines.push('### Semantic Evidence');
  if (input.semanticHits.length === 0) {
    lines.push('- None');
  } else {
    for (const hit of input.semanticHits) {
      lines.push(`- ${formatSemanticHit(hit)}`);
    }
  }

  if (input.caveats.length > 0) {
    lines.push('');
    lines.push('### Caveats');
    for (const caveat of input.caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  lines.push('');
  lines.push('Use this packet as evidence, not as literal source code.');
  return lines.join('\n');
}

function buildModelPrompt(input: {
  readonly templateId: QueryTemplateId;
  readonly prompt: string;
  readonly renderedMarkdown: string;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly caveats: readonly string[];
}): string {
  const caveatText = input.caveats.length > 0 ? input.caveats.map((entry) => `- ${entry}`).join('\n') : '- None';
  return [
    'You are assisting with software architecture analysis.',
    'Use the VSContext query packet below as the only evidence source.',
    'Answer with a direct conclusion first, then cite the structural and semantic evidence that supports it.',
    'State uncertainty explicitly if the packet is incomplete or low confidence.',
    '',
    `Template: ${TEMPLATE_LABELS[input.templateId]}`,
    `Confidence: ${input.confidence}`,
    '',
    'Caveats:',
    caveatText,
    '',
    'VSContext query packet:',
    input.renderedMarkdown,
    '',
    `User request: ${input.prompt.trim()}`,
  ].join('\n');
}

function renderTraversal(label: 'trace' | 'impact', nodes: readonly TraversalNode[], edges: readonly TraversalEdge[]): string[] {
  const lines: string[] = [];
  lines.push(`- Nodes: ${nodes.length}`);
  lines.push(`- Edges: ${edges.length}`);

  for (const node of nodes.slice(0, 10)) {
    lines.push(`  - [${label} d${node.depth}] ${formatFileLink(node.filePath, node.lineNumber, node.symbolName)}`);
  }

  return lines;
}

function formatSemanticHit(hit: SemanticSearchHit): string {
  const location = hit.lineNumber ? `${formatFileLink(hit.filePath, hit.lineNumber)}` : formatFileLink(hit.filePath);
  const reasons = hit.reasons.length > 0 ? ` [${hit.reasons.join(', ')}]` : '';
  return `${hit.title} (${hit.score.toFixed(2)}) - ${hit.summary} - ${location}${reasons}`;
}

function formatNodeLink(node: GraphNode): string {
  return `${formatFileLink(node.filePath, node.lineNumber, node.symbolName)} (${node.nodeType})`;
}

function formatFileLink(filePath: string, lineNumber?: number, label?: string): string {
  const displayLabel = label ?? (typeof lineNumber === 'number' ? `${filePath}:${lineNumber}` : filePath);
  const target = lineNumber ? `${encodeURI(filePath)}#L${lineNumber}` : encodeURI(filePath);
  return `[${displayLabel}](${target})`;
}

function formatFileUriLink(filePath: string, uriString: string): string {
  if (uriString.length === 0) {
    return formatFileLink(filePath);
  }

  return `[${filePath}](${uriString})`;
}
