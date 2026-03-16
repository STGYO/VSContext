"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SOURCE_EXCLUDE_GLOB = exports.SOURCE_INCLUDE_GLOB = void 0;
exports.getPrimaryWorkspaceFolder = getPrimaryWorkspaceFolder;
exports.toWorkspaceRelativePath = toWorkspaceRelativePath;
exports.toFileName = toFileName;
exports.getWorkspaceScanSettings = getWorkspaceScanSettings;
exports.findWorkspaceSourceFiles = findWorkspaceSourceFiles;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
exports.SOURCE_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,c,h}';
exports.SOURCE_EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**';
const EXCLUDED_DIR_FILE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,c,h}';
function getPrimaryWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0];
}
function toWorkspaceRelativePath(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
    const fileSystemPath = typeof uri?.fsPath === 'string' ? uri.fsPath : '';
    if (!folder) {
        return fileSystemPath;
    }
    const relativePath = path.relative(folder.uri.fsPath, fileSystemPath);
    return (relativePath || fileSystemPath).replace(/\\/g, '/');
}
function toFileName(uri) {
    return path.basename(uri.fsPath);
}
function getWorkspaceScanSettings() {
    const config = vscode.workspace.getConfiguration('vscontext');
    const rawMaxIndexedFiles = config.get('maxIndexedFiles', 2000);
    const rawRefreshDebounceMs = config.get('refreshDebounceMs', 300);
    const rawWorkerBatchSize = config.get('workerBatchSize', 75);
    const rawWorkerCount = config.get('workerCount', 4);
    return {
        maxIndexedFiles: Math.max(100, rawMaxIndexedFiles),
        refreshDebounceMs: Math.max(100, rawRefreshDebounceMs),
        workerBatchSize: Math.max(50, Math.min(100, rawWorkerBatchSize)),
        workerCount: Math.max(1, Math.min(8, rawWorkerCount)),
    };
}
async function findWorkspaceSourceFiles(maxIndexedFiles) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return {
            files: [],
            totalCandidateFiles: 0,
            skippedByLimit: 0,
            skippedByExclusions: 0,
        };
    }
    const [allIncludedFiles, excludedFiles] = await Promise.all([
        vscode.workspace.findFiles(exports.SOURCE_INCLUDE_GLOB, exports.SOURCE_EXCLUDE_GLOB),
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
//# sourceMappingURL=workspaceScanner.js.map