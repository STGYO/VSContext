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
exports.openExecutionPanel = openExecutionPanel;
const vscode = __importStar(require("vscode"));
function openExecutionPanel(result, logger, onOpenNode) {
    const panel = vscode.window.createWebviewPanel('vscontext.executionTrace', 'Execution Trace Panel', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });
    panel.webview.html = renderExecutionHtml(panel.webview, result);
    const disposable = panel.webview.onDidReceiveMessage(async (message) => {
        if (!isOpenNodeMessage(message)) {
            return;
        }
        try {
            await onOpenNode(message.nodeId);
        }
        catch (error) {
            logger.error('Failed to open node from execution panel.', error);
        }
    });
    panel.onDidDispose(() => {
        disposable.dispose();
    });
}
function isOpenNodeMessage(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    const candidate = message;
    return candidate.type === 'openNode' && typeof candidate.nodeId === 'string';
}
function renderExecutionHtml(webview, result) {
    const nonce = createNonce();
    const rows = result.nodes
        .map((node) => {
        const depth = node.depth.toString();
        const location = `${escapeHtml(node.filePath)}:${node.lineNumber.toString()}`;
        return `<tr>
        <td>${depth}</td>
        <td><button class="link" data-node-id="${escapeHtml(node.nodeId)}">${escapeHtml(node.symbolName)}</button></td>
        <td>${location}</td>
      </tr>`;
    })
        .join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body { font-family: Segoe UI, sans-serif; margin: 16px; }
    h2 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #444; padding: 8px; text-align: left; }
    th { background: #252526; }
    .link { background: none; border: none; color: #4da3ff; cursor: pointer; padding: 0; font: inherit; }
  </style>
</head>
<body>
  <h2>Execution Trace</h2>
  <p>Nodes visited: ${result.nodes.length.toString()} | Max depth: ${result.maxDepth.toString()}</p>
  <table>
    <thead>
      <tr>
        <th>Depth</th>
        <th>Function</th>
        <th>Location</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const buttons = document.querySelectorAll('[data-node-id]');
    for (const button of buttons) {
      button.addEventListener('click', () => {
        const nodeId = button.getAttribute('data-node-id');
        if (nodeId) {
          vscode.postMessage({ type: 'openNode', nodeId });
        }
      });
    }
  </script>
</body>
</html>`;
}
function createNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 24; i += 1) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
}
function escapeHtml(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
//# sourceMappingURL=executionPanel.js.map