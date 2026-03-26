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
exports.getWorkspaceFolders = getWorkspaceFolders;
exports.getWorkspaceCacheKey = getWorkspaceCacheKey;
exports.toWorkspaceRelativePath = toWorkspaceRelativePath;
exports.toFileName = toFileName;
exports.getWorkspaceScanSettings = getWorkspaceScanSettings;
exports.findWorkspaceSourceFiles = findWorkspaceSourceFiles;
exports.findWorkspaceRepositoryFiles = findWorkspaceRepositoryFiles;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const fileRoleClassifier_1 = require("./fileRoleClassifier");
exports.SOURCE_INCLUDE_GLOB = '**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';
exports.SOURCE_EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**';
const EXCLUDED_DIR_FILE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.venv,venv,__pycache__,site-packages}/**/*.{ts,tsx,js,jsx,py,go,java,rs,cpp,cc,cxx,c,h,hpp,hh,hxx,cs,php,phtml,rb,kt,kts,swift}';
const DOCUMENTATION_INCLUDE_GLOB = '**/*.{md,mdx,markdown,txt,rst,adoc}';
const TEMPLATE_INCLUDE_GLOB = '**/*.{html,htm,jinja,jinja2,twig,hbs,handlebars,ejs,njk,vue,svelte,phtml}';
function getPrimaryWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0];
}
function getWorkspaceFolders() {
    return vscode.workspace.workspaceFolders ?? [];
}
function getWorkspaceCacheKey() {
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
function getWorkspaceFolderKey(folder) {
    const folders = getWorkspaceFolders();
    if (folders.length <= 1) {
        return '';
    }
    const hash = crypto.createHash('sha1').update(folder.uri.toString()).digest('hex').slice(0, 8);
    const folderName = folder.name.trim().length > 0 ? folder.name.trim() : 'workspace';
    return `${folderName}-${hash}/`;
}
function toWorkspaceRelativePath(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
    const fileSystemPath = typeof uri?.fsPath === 'string' ? uri.fsPath : '';
    if (!folder) {
        return fileSystemPath;
    }
    const relativePath = path.relative(folder.uri.fsPath, fileSystemPath);
    const workspacePrefix = getWorkspaceFolderKey(folder);
    return `${workspacePrefix}${(relativePath || fileSystemPath).replace(/\\/g, '/')}`;
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
    const result = await findWorkspaceRepositoryFiles(maxIndexedFiles);
    return {
        files: result.files,
        totalCandidateFiles: result.totalCandidateFiles,
        skippedByLimit: result.skippedByLimit,
        skippedByExclusions: result.skippedByExclusions,
    };
}
async function findWorkspaceRepositoryFiles(maxIndexedFiles) {
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
            roleCounts: (0, fileRoleClassifier_1.createEmptyWorkspaceFileRoleCounts)(),
            totalCandidateFiles: 0,
            skippedByLimit: 0,
            skippedByExclusions: 0,
        };
    }
    const [sourceFiles, documentationFiles, templateFiles, excludedFiles] = await Promise.all([
        vscode.workspace.findFiles(exports.SOURCE_INCLUDE_GLOB, exports.SOURCE_EXCLUDE_GLOB),
        vscode.workspace.findFiles(DOCUMENTATION_INCLUDE_GLOB, exports.SOURCE_EXCLUDE_GLOB),
        vscode.workspace.findFiles(TEMPLATE_INCLUDE_GLOB, exports.SOURCE_EXCLUDE_GLOB),
        vscode.workspace.findFiles(EXCLUDED_DIR_FILE_GLOB),
    ]);
    const includedFiles = new Map();
    const filesByRole = {
        source: [],
        test: [],
        documentation: [],
        template: [],
        other: [],
    };
    let roleCounts = (0, fileRoleClassifier_1.createEmptyWorkspaceFileRoleCounts)();
    for (const uri of [...sourceFiles, ...documentationFiles, ...templateFiles]) {
        const key = uri.fsPath.toLowerCase();
        if (includedFiles.has(key)) {
            continue;
        }
        includedFiles.set(key, uri);
        const role = (0, fileRoleClassifier_1.classifyWorkspaceFile)(uri);
        filesByRole[role].push(uri);
        roleCounts = (0, fileRoleClassifier_1.incrementWorkspaceFileRoleCounts)(roleCounts, role);
    }
    const files = sourceFiles.slice(0, maxIndexedFiles);
    for (const uri of files) {
        const role = (0, fileRoleClassifier_1.classifyWorkspaceFile)(uri);
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
//# sourceMappingURL=workspaceScanner.js.map