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
exports.Logger = void 0;
const vscode = __importStar(require("vscode"));
class Logger {
    channel;
    constructor(channelName = 'VSContext') {
        this.channel = vscode.window.createOutputChannel(channelName);
    }
    info(message) {
        this.channel.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
    }
    warn(message) {
        this.channel.appendLine(`[WARN] ${new Date().toISOString()} ${message}`);
    }
    error(message, error) {
        const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error ?? '');
        const suffix = detail.trim().length > 0 ? `\n${detail}` : '';
        this.channel.appendLine(`[ERROR] ${new Date().toISOString()} ${message}${suffix}`);
    }
    show(preserveFocus = true) {
        this.channel.show(preserveFocus);
    }
    dispose() {
        this.channel.dispose();
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map