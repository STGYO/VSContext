import * as path from 'path';
import * as vscode from 'vscode';

export const SOURCE_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';
export const SOURCE_EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**';
const EXCLUDED_DIR_FILE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';

export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  return folders[0];
}

export function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
  const fileSystemPath = typeof uri?.fsPath === 'string' ? uri.fsPath : '';

  if (!folder) {
    return fileSystemPath;
  }

  const relativePath = path.relative(folder.uri.fsPath, fileSystemPath);
  return (relativePath || fileSystemPath).replace(/\\/g, '/');
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

export async function findWorkspaceSourceFiles(maxIndexedFiles: number): Promise<WorkspaceSourceScanResult> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return {
      files: [],
      totalCandidateFiles: 0,
      skippedByLimit: 0,
      skippedByExclusions: 0,
    };
  }

  const [allIncludedFiles, excludedFiles] = await Promise.all([
    vscode.workspace.findFiles(SOURCE_INCLUDE_GLOB, SOURCE_EXCLUDE_GLOB),
    vscode.workspace.findFiles(EXCLUDED_DIR_FILE_GLOB),
  ]);

  const files = allIncludedFiles.slice(0, maxIndexedFiles);
  return {
    files,
    totalCandidateFiles: allIncludedFiles.length,
    skippedByLimit: Math.max(0, allIncludedFiles.length - files.length),
    skippedByExclusions: excludedFiles.length,
  };
}
