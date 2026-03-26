import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import { classifyWorkspaceFile, createEmptyWorkspaceFileRoleCounts, incrementWorkspaceFileRoleCounts, type WorkspaceFileRole, type WorkspaceFileRoleCounts } from './fileRoleClassifier';

export const SOURCE_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';
export const SOURCE_EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**';
const EXCLUDED_DIR_FILE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';
const DOCUMENTATION_INCLUDE_GLOB = '**/*.{md,mdx,markdown,txt,rst,adoc}';
const TEMPLATE_INCLUDE_GLOB = '**/*.{html,htm,jinja,jinja2,twig,hbs,handlebars,ejs,njk,vue,svelte,phtml}';

export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  return folders[0];
}

export function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

export function getWorkspaceCacheKey(): string {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    return 'no-workspace';
  }

  const hash = crypto.createHash('sha256');
  for (const folder of [...folders].sort((left, right) => left.uri.toString().localeCompare(right.uri.toString()))) {
    hash.update(folder.uri.toString());
    hash.update('\0');
  }

  return hash.digest('hex').slice(0, 16);
}

function getWorkspaceFolderKey(folder: vscode.WorkspaceFolder): string {
  const folders = getWorkspaceFolders();
  if (folders.length <= 1) {
    return '';
  }

  const hash = crypto.createHash('sha1').update(folder.uri.toString()).digest('hex').slice(0, 8);
  const folderName = folder.name.trim().length > 0 ? folder.name.trim() : 'workspace';
  return `${folderName}-${hash}/`;
}

export function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
  const fileSystemPath = typeof uri?.fsPath === 'string' ? uri.fsPath : '';

  if (!folder) {
    return fileSystemPath;
  }

  const relativePath = path.relative(folder.uri.fsPath, fileSystemPath);
  const workspacePrefix = getWorkspaceFolderKey(folder);
  return `${workspacePrefix}${(relativePath || fileSystemPath).replace(/\\/g, '/')}`;
}

export function toFileName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath);
}

export interface WorkspaceScanSettings {
  readonly maxIndexedFiles: number;
  readonly refreshDebounceMs: number;
  readonly workerBatchSize: number;
  readonly workerCount: number;
}

export function getWorkspaceScanSettings(): WorkspaceScanSettings {
  const config = vscode.workspace.getConfiguration('vscontext');
  const rawMaxIndexedFiles = config.get<number>('maxIndexedFiles', 2000);
  const rawRefreshDebounceMs = config.get<number>('refreshDebounceMs', 300);
  const rawWorkerBatchSize = config.get<number>('workerBatchSize', 75);
  const rawWorkerCount = config.get<number>('workerCount', 4);

  return {
    maxIndexedFiles: Math.max(100, rawMaxIndexedFiles),
    refreshDebounceMs: Math.max(100, rawRefreshDebounceMs),
    workerBatchSize: Math.max(50, Math.min(100, rawWorkerBatchSize)),
    workerCount: Math.max(1, Math.min(8, rawWorkerCount)),
  };
}

export interface WorkspaceSourceScanResult {
  readonly files: vscode.Uri[];
  readonly totalCandidateFiles: number;
  readonly skippedByLimit: number;
  readonly skippedByExclusions: number;
}

export interface WorkspaceRepositoryScanResult extends WorkspaceSourceScanResult {
  readonly filesByRole: Record<WorkspaceFileRole, vscode.Uri[]>;
  readonly roleCounts: WorkspaceFileRoleCounts;
}

export async function findWorkspaceSourceFiles(maxIndexedFiles: number): Promise<WorkspaceSourceScanResult> {
  const result = await findWorkspaceRepositoryFiles(maxIndexedFiles);

  return {
    files: result.files,
    totalCandidateFiles: result.totalCandidateFiles,
    skippedByLimit: result.skippedByLimit,
    skippedByExclusions: result.skippedByExclusions,
  };
}

export async function findWorkspaceRepositoryFiles(maxIndexedFiles: number): Promise<WorkspaceRepositoryScanResult> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return {
      files: [],
      filesByRole: {
        source: [],
        test: [],
        documentation: [],
        template: [],
        other: [],
      },
      roleCounts: createEmptyWorkspaceFileRoleCounts(),
      totalCandidateFiles: 0,
      skippedByLimit: 0,
      skippedByExclusions: 0,
    };
  }

  const [sourceFiles, documentationFiles, templateFiles, excludedFiles] = await Promise.all([
    vscode.workspace.findFiles(SOURCE_INCLUDE_GLOB, SOURCE_EXCLUDE_GLOB),
    vscode.workspace.findFiles(DOCUMENTATION_INCLUDE_GLOB, SOURCE_EXCLUDE_GLOB),
    vscode.workspace.findFiles(TEMPLATE_INCLUDE_GLOB, SOURCE_EXCLUDE_GLOB),
    vscode.workspace.findFiles(EXCLUDED_DIR_FILE_GLOB),
  ]);

  const includedFiles = new Map<string, vscode.Uri>();
  const filesByRole: Record<WorkspaceFileRole, vscode.Uri[]> = {
    source: [],
    test: [],
    documentation: [],
    template: [],
    other: [],
  };
  let roleCounts = createEmptyWorkspaceFileRoleCounts();

  for (const uri of [...sourceFiles, ...documentationFiles, ...templateFiles]) {
    const key = uri.fsPath.toLowerCase();
    if (includedFiles.has(key)) {
      continue;
    }

    includedFiles.set(key, uri);
    const role = classifyWorkspaceFile(uri);
    filesByRole[role].push(uri);
    roleCounts = incrementWorkspaceFileRoleCounts(roleCounts, role);
  }

  const files = sourceFiles.slice(0, maxIndexedFiles);
  for (const uri of files) {
    const role = classifyWorkspaceFile(uri);
    if (!filesByRole[role].some((entry) => entry.fsPath === uri.fsPath)) {
      filesByRole[role].push(uri);
    }
  }

  return {
    files,
    filesByRole,
    roleCounts,
    totalCandidateFiles: includedFiles.size,
    skippedByLimit: Math.max(0, sourceFiles.length - files.length),
    skippedByExclusions: excludedFiles.length,
  };
}
