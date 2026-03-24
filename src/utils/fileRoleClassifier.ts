import * as path from 'path';
import * as vscode from 'vscode';

export type WorkspaceFileRole = 'source' | 'test' | 'documentation' | 'template' | 'other';

export interface WorkspaceFileRoleCounts {
  readonly source: number;
  readonly test: number;
  readonly documentation: number;
  readonly template: number;
  readonly other: number;
}

export interface WorkspaceFileRoleSummary extends WorkspaceFileRoleCounts {}

const DOCUMENTATION_EXTENSIONS = new Set<string>(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
const TEMPLATE_EXTENSIONS = new Set<string>(['.html', '.htm', '.jinja', '.jinja2', '.twig', '.hbs', '.handlebars', '.ejs', '.njk', '.vue', '.svelte', '.phtml']);
const SOURCE_EXTENSIONS = new Set<string>(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx', '.cs', '.php', '.rb', '.kt', '.kts', '.swift']);

export function classifyWorkspaceFile(uri: vscode.Uri): WorkspaceFileRole {
  const fileName = path.basename(uri.fsPath).toLowerCase();
  const extension = path.extname(fileName);
  const pathSegments = uri.fsPath.toLowerCase().split(/[\\/]+/);

  if (isTestFile(fileName, pathSegments)) {
    return 'test';
  }

  if (DOCUMENTATION_EXTENSIONS.has(extension)) {
    return 'documentation';
  }

  if (TEMPLATE_EXTENSIONS.has(extension)) {
    return 'template';
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    return 'source';
  }

  return 'other';
}

export function createEmptyWorkspaceFileRoleCounts(): WorkspaceFileRoleCounts {
  return {
    source: 0,
    test: 0,
    documentation: 0,
    template: 0,
    other: 0,
  };
}

export function incrementWorkspaceFileRoleCounts(counts: WorkspaceFileRoleCounts, role: WorkspaceFileRole): WorkspaceFileRoleCounts {
  return {
    source: counts.source + (role === 'source' ? 1 : 0),
    test: counts.test + (role === 'test' ? 1 : 0),
    documentation: counts.documentation + (role === 'documentation' ? 1 : 0),
    template: counts.template + (role === 'template' ? 1 : 0),
    other: counts.other + (role === 'other' ? 1 : 0),
  };
}

function isTestFile(fileName: string, pathSegments: string[]): boolean {
  if (pathSegments.some((segment) => segment === '__tests__' || segment === 'tests' || segment === 'test' || segment === 'spec' || segment === 'specs')) {
    return true;
  }

  return /(^|[.-_])(test|spec)([.-_]|\.|$)/.test(fileName);
}