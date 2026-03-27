import * as vscode from 'vscode';
import { type GraphNode, type WorkspaceGraph } from '../graph/graphBuilder';
import { type Logger } from '../utils/logger';

export interface CrossLink {
  readonly displayText: string;
  readonly filePath: string;
  readonly lineNumber?: number;
  readonly symbolName?: string;
  readonly linkType: 'file' | 'symbol' | 'line' | 'selection';
}

export class CrossLinkResolver {
  constructor(private readonly graph: WorkspaceGraph, private readonly logger: Logger) {}

  /**
   * Generate cross-links from a markdown answer back to source files
   * Scans for symbol names, file paths, and other references in the answer
   */
  generateCrossLinksFromAnswer(markdownContent: string): CrossLink[] {
    const links: CrossLink[] = [];
    const processedRefs = new Set<string>();

    // Find all symbol names mentioned in backticks
    const symbolMatches = markdownContent.matchAll(/`([^`]+)`/g);
    for (const match of symbolMatches) {
      const symbolName = match[1];
      // Search for symbol in graph nodes
      for (const node of this.graph.nodes.values()) {
        if (node.symbolName === symbolName && !processedRefs.has(node.id)) {
          processedRefs.add(node.id);
          links.push({
            displayText: symbolName,
            filePath: node.filePath,
            symbolName: node.symbolName,
            linkType: 'symbol',
          });
          break;
        }
      }
    }

    // Find file paths mentioned as paths
    const fileMatches = markdownContent.matchAll(/(?:file|path|src)[:\s]+([^\s\n]+\.(?:ts|js|tsx|jsx|py|java|go|cpp|c|rs|rb|php|kt|cs))/gi);
    for (const match of fileMatches) {
      const filePath = match[1];
      if (!processedRefs.has(filePath)) {
        processedRefs.add(filePath);
        links.push({
          displayText: filePath,
          filePath: filePath,
          linkType: 'file',
        });
      }
    }

    // Find line number references
    const lineMatches = markdownContent.matchAll(/(?:line|at|L)[\s:]*(\d+)/gi);
    for (const match of lineMatches) {
      const lineNum = parseInt(match[1], 10);
      if (lineNum > 0) {
        links.push({
          displayText: `Line ${lineNum}`,
          filePath: '', // Will be resolved from context
          lineNumber: lineNum,
          linkType: 'line',
        });
      }
    }

    return links;
  }

  /**
   * Create a markdown link to a file in the workspace
   */
  createFileLink(filePath: string, displayText?: string, lineNumber?: number): string {
    const text = displayText || filePath;
    const anchor = lineNumber ? `#L${lineNumber}` : '';
    return `[${text}](${filePath}${anchor})`;
  }

  /**
   * Create a markdown link to a symbol
   */
  createSymbolLink(symbolName: string, displayText?: string): string {
    const text = displayText || symbolName;
    // Search for symbol in graph nodes
    for (const node of this.graph.nodes.values()) {
      if (node.symbolName === symbolName) {
        return `[${text}](${node.filePath}#L${node.lineNumber || 1})`;
      }
    }
    return text;
  }

  /**
   * Enhance markdown content with cross-links
   */
  enhanceMarkdownWithCrossLinks(markdown: string): string {
    let enhanced = markdown;
    const links = this.generateCrossLinksFromAnswer(markdown);

    for (const link of links) {
      if (link.linkType === 'symbol' && link.symbolName) {
        // Search for symbol in graph nodes
        for (const node of this.graph.nodes.values()) {
          if (node.symbolName === link.symbolName) {
            const linkMarkdown = this.createFileLink(node.filePath, `${link.symbolName}`, node.lineNumber);
            enhanced = enhanced.replace(new RegExp(`\`${link.symbolName}\``, 'g'), linkMarkdown);
            break;
          }
        }
      } else if (link.linkType === 'file') {
        const linkMarkdown = this.createFileLink(link.filePath, link.filePath);
        enhanced = enhanced.replace(new RegExp(`(file|path|src)[:\\s]*${link.filePath}`, 'i'), `$1: ${linkMarkdown}`);
      }
    }

    return enhanced;
  }

  /**
   * Open a file at a specific location from a cross-link
   */
  async openCrossLink(link: CrossLink): Promise<void> {
    if (!link.filePath) {
      this.logger.warn('Cannot open cross-link without file path');
      return;
    }

    try {
      const uri = vscode.Uri.file(link.filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      if (link.lineNumber) {
        const position = new vscode.Position(link.lineNumber - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }

      this.logger.info(`[VSContext] Opened cross-link: ${link.filePath}${link.lineNumber ? `:${link.lineNumber}` : ''}`);
    } catch (error) {
      this.logger.error(`Failed to open cross-link: ${error}`);
    }
  }

  /**
   * Generate a cross-link summary showing all referenced files and symbols
   */
  generateCrossLinkSummary(markdown: string): string {
    const links = this.generateCrossLinksFromAnswer(markdown);
    const fileLinks = links.filter(l => l.linkType === 'file' || l.linkType === 'symbol');
    const lineLinks = links.filter(l => l.linkType === 'line');

    const lines = [
      '### Cross-Link Summary',
      `Files/Symbols Referenced: ${fileLinks.length}`,
      `Line Numbers: ${lineLinks.length}`,
    ];

    if (fileLinks.length > 0) {
      lines.push('');
      lines.push('**Files and Symbols:**');
      const uniqueFiles = new Set(fileLinks.map(l => l.filePath).filter(Boolean));
      for (const file of Array.from(uniqueFiles).slice(0, 10)) {
        const symbols = fileLinks.filter(l => l.filePath === file && l.linkType === 'symbol').map(l => l.symbolName);
        if (symbols.length > 0) {
          lines.push(`- ${file}: ${symbols.join(', ')}`);
        } else {
          lines.push(`- ${file}`);
        }
      }
    }

    return lines.join('\n');
  }
}
