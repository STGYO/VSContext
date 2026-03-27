import { type HybridQueryResult, type FileRelationshipEvidence } from '../chat/queryOrchestrator';
import { type ExecutionTraceResult, type TraversalNode, type TraversalEdge } from '../analysis/executionTrace';
import { type Logger } from '../utils/logger';

export interface ExportOptions {
  readonly includeMetadata: boolean;
  readonly includeCaveats: boolean;
  readonly includeEvidence: boolean;
  readonly includeQueryPlan: boolean;
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeMetadata: true,
  includeCaveats: true,
  includeEvidence: true,
  includeQueryPlan: true,
};

export class QueryResultExporter {
  constructor(private readonly logger: Logger) {}

  exportAsJSON(result: HybridQueryResult, options: Partial<ExportOptions> = {}): string {
    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };

    const exportData: Record<string, unknown> = {
      title: result.title,
      templateId: result.templateId,
      prompt: result.prompt,
      confidence: result.confidence,
    };

    if (opts.includeMetadata) {
      exportData.metadata = {
        exportedAt: new Date().toISOString(),
        focusNode: result.focusNode ? {
          id: result.focusNode.id,
          symbolName: result.focusNode.symbolName,
          symbolKind: result.focusNode.symbolKind,
          filePath: result.focusNode.filePath,
        } : undefined,
      };
    }

    if (opts.includeQueryPlan) {
      exportData.queryPlan = result.plan;
    }

    if (opts.includeCaveats && result.caveats.length > 0) {
      exportData.caveats = result.caveats;
    }

    if (opts.includeEvidence) {
      exportData.evidence = {
        semanticHits: result.semanticHits.map(hit => ({
          id: hit.id,
          filePath: hit.filePath,
          title: hit.title,
          score: hit.score,
        })),
        fileRelationships: result.fileRelationships.map(rel => ({
          source: rel.sourceFilePath,
          target: rel.targetFilePath,
          relationship: rel.relationship,
        })),
        traceNodes: result.traceResult?.nodes.map(node => ({
          nodeId: node.nodeId,
          symbolName: node.symbolName,
          depth: node.depth,
        })),
        impactNodes: result.impactResult?.nodes.map(node => ({
          nodeId: node.nodeId,
          symbolName: node.symbolName,
          depth: node.depth,
        })),
      };
    }

    exportData.content = result.renderedMarkdown;

    return JSON.stringify(exportData, null, 2);
  }

  exportAsCSV(result: HybridQueryResult, options: Partial<ExportOptions> = {}): string {
    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };
    const lines: string[] = [];

    // Header with basic info
    lines.push('Query Result Export');
    lines.push(`Template,${result.templateId}`);
    lines.push(`Title,${this.escapeCsvValue(result.title)}`);
    lines.push(`Prompt,${this.escapeCsvValue(result.prompt)}`);
    lines.push(`Confidence,${result.confidence}`);
    lines.push(`Exported,${new Date().toISOString()}`);
    lines.push('');

    if (opts.includeMetadata && result.focusNode) {
      lines.push('Focus Node');
      lines.push(`Symbol,${this.escapeCsvValue(result.focusNode.symbolName)}`);
      lines.push(`File,${this.escapeCsvValue(result.focusNode.filePath)}`);
      lines.push(`Kind,${result.focusNode.symbolKind}`);
      lines.push('');
    }

    if (opts.includeEvidence) {
      if (result.semanticHits.length > 0) {
        lines.push('Semantic Hits');
        lines.push('File,Score,Title');
        for (const hit of result.semanticHits) {
          lines.push(`${this.escapeCsvValue(hit.filePath)},${hit.score.toFixed(3)},${this.escapeCsvValue(hit.title.substring(0, 100))}`);
        }
        lines.push('');
      }

      if (result.fileRelationships.length > 0) {
        lines.push('File Relationships');
        lines.push('Source,Target,Relationship');
        for (const rel of result.fileRelationships) {
          lines.push(`${this.escapeCsvValue(rel.sourceFilePath)},${this.escapeCsvValue(rel.targetFilePath)},${rel.relationship}`);
        }
        lines.push('');
      }

      if (result.traceResult && result.traceResult.nodes.length > 0) {
        lines.push('Trace Nodes');
        lines.push('Symbol,NodeID');
        for (const node of result.traceResult.nodes) {
          lines.push(`${this.escapeCsvValue(node.symbolName)},${node.nodeId}`);
        }
        lines.push('');
      }
    }

    if (opts.includeCaveats && result.caveats.length > 0) {
      lines.push('Caveats');
      for (const caveat of result.caveats) {
        lines.push(this.escapeCsvValue(caveat));
      }
    }

    return lines.join('\n');
  }

  exportAsHTML(result: HybridQueryResult, options: Partial<ExportOptions> = {}): string {
    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(result.title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
      background-color: #f5f5f5;
    }
    header {
      background-color: #1E293B;
      color: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 10px 0;
    }
    .metadata {
      font-size: 0.9em;
      opacity: 0.9;
      margin-top: 10px;
    }
    .section {
      background: white;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h2 {
      border-bottom: 3px solid #0066cc;
      padding-bottom: 10px;
      margin-top: 0;
    }
    .confidence {
      display: inline-block;
      padding: 5px 10px;
      border-radius: 4px;
      font-weight: bold;
      margin: 10px 0;
    }
    .confidence.high { background-color: #10b981; color: white; }
    .confidence.medium { background-color: #f59e0b; color: white; }
    .confidence.low { background-color: #ef4444; color: white; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 12px;
      text-align: left;
    }
    th {
      background-color: #f0f0f0;
      font-weight: bold;
    }
    .code {
      background-color: #f5f5f5;
      border-left: 4px solid #0066cc;
      padding: 10px;
      margin: 10px 0;
      font-family: 'Courier New', monospace;
      overflow-x: auto;
    }
    .caveat {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 10px;
      margin: 10px 0;
    }
    .rendering {
      color: #555;
      line-height: 1.6;
    }
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      font-size: 0.9em;
      color: #666;
      text-align: center;
    }
  </style>
</head>
<body>
  <header>
    <h1>${this.escapeHtml(result.title)}</h1>
    <div class="metadata">
      <strong>Template:</strong> ${this.escapeHtml(result.templateId)} |
      <strong>Prompt:</strong> ${this.escapeHtml(result.prompt.substring(0, 100))}${result.prompt.length > 100 ? '...' : ''} |
      <strong>Exported:</strong> ${new Date().toISOString()}
    </div>
    <div class="confidence ${result.confidence}">${result.confidence.toUpperCase()}</div>
  </header>

  ${opts.includeMetadata && result.focusNode ? `
  <div class="section">
    <h2>Focus Node</h2>
    <table>
      <tr>
        <th>Property</th>
        <th>Value</th>
      </tr>
      <tr>
        <td>Symbol</td>
        <td>${this.escapeHtml(result.focusNode.symbolName)}</td>
      </tr>
      <tr>
        <td>Kind</td>
        <td>${typeof result.focusNode.symbolKind === 'number' ? result.focusNode.symbolKind : String(result.focusNode.symbolKind)}</td>
      </tr>
      <tr>
        <td>File</td>
        <td><code>${this.escapeHtml(result.focusNode.filePath)}</code></td>
      </tr>
    </table>
  </div>
  ` : ''}

  ${opts.includeQueryPlan ? `
  <div class="section">
    <h2>Query Plan</h2>
    <p><strong>Graph Queries:</strong> ${result.plan.graphQueries.join(', ')}</p>
    <p><strong>Semantic Queries:</strong> ${result.plan.semanticQueries.join(', ')}</p>
    <p><strong>Trace:</strong> ${result.plan.useTrace ? 'Yes' : 'No'} | <strong>Impact:</strong> ${result.plan.useImpact ? 'Yes' : 'No'}</p>
  </div>
  ` : ''}

  <div class="section">
    <h2>Result</h2>
    <div class="rendering">${this.markdownToHtml(result.renderedMarkdown)}</div>
  </div>

  ${opts.includeEvidence && result.semanticHits.length > 0 ? `
  <div class="section">
    <h2>Semantic Evidence</h2>
    <table>
      <tr>
        <th>File</th>
        <th>Score</th>
        <th>Title</th>
      </tr>
      ${result.semanticHits.map(hit => `
      <tr>
        <td><code>${this.escapeHtml(hit.filePath)}</code></td>
        <td>${hit.score.toFixed(3)}</td>
        <td>${this.escapeHtml(hit.title.substring(0, 150))}</td>
      </tr>
      `).join('')}
    </table>
  </div>
  ` : ''}

  ${opts.includeEvidence && result.fileRelationships.length > 0 ? `
  <div class="section">
    <h2>File Relationships</h2>
    <table>
      <tr>
        <th>Source</th>
        <th>Target</th>
        <th>Relationship</th>
      </tr>
      ${result.fileRelationships.map(rel => `
      <tr>
        <td><code>${this.escapeHtml(rel.sourceFilePath)}</code></td>
        <td><code>${this.escapeHtml(rel.targetFilePath)}</code></td>
        <td>${this.escapeHtml(rel.relationship)}</td>
      </tr>
      `).join('')}
    </table>
  </div>
  ` : ''}

  ${opts.includeCaveats && result.caveats.length > 0 ? `
  <div class="section">
    <h2>Caveats</h2>
    ${result.caveats.map(caveat => `<div class="caveat">${this.escapeHtml(caveat)}</div>`).join('')}
  </div>
  ` : ''}

  <footer>
    <p>Generated by VSContext | <a href="https://github.com/STGYO/VSContext">GitHub</a></p>
  </footer>
</body>
</html>`;

    return html;
  }

  private escapeCsvValue(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private escapeHtml(text: string): string {
    const htmlEscapeMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, char => htmlEscapeMap[char] || char);
  }

  private markdownToHtml(markdown: string): string {
    // Simple markdown to HTML conversion
    let html = markdown
      .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^- (.*?)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    return `<p>${html}</p>`;
  }
}

export async function exportQueryResultToPDF(
  result: HybridQueryResult,
  outputPath: string,
  options: Partial<ExportOptions> = {},
  logger: Logger
): Promise<void> {
  try {
    // For PDF, we'll generate HTML and note that client-side PDF conversion is needed
    // (or integrate a library like pdfdocument or puppeteer if available)
    const exporter = new QueryResultExporter(logger);
    const htmlContent = exporter.exportAsHTML(result, options);
    
    // This is a placeholder - in production, use a PDF library
    logger.info(`[VSContext] PDF export would contain: ${htmlContent.length} bytes of content`);
    logger.info(`[VSContext] Use a PDF conversion tool or print to PDF from the HTML output`);
  } catch (error) {
    logger.error(`Failed to export PDF: ${error}`);
    throw error;
  }
}
