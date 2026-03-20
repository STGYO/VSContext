import * as vscode from 'vscode';

import { GraphNode } from '../graph/graphBuilder';

export type ChatContextBudget = 'small' | 'medium' | 'large';

export interface ChatContextSettings {
  readonly budget: ChatContextBudget;
  readonly denylistPatterns: string[];
}

const DEFAULT_CHAT_DENYLIST_PATTERNS = [
  '/node_modules/',
  '/.git/',
  '/dist/',
  '/build/',
  '/out/',
  '/coverage/',
  '/.venv/',
  '/venv/',
  '/__pycache__/',
  '/site-packages/',
  '/test/',
  '/tests/',
  '/__tests__/',
  '.test.',
  '.spec.',
  '/config/',
  '/configs/',
  '/migrations/',
];

export function getChatContextSettings(): ChatContextSettings {
  const config = vscode.workspace.getConfiguration('vscontext');
  const budget = normalizeBudget(config.get<string>('chatContextBudget', 'medium'));
  const denylistPatterns = config
    .get<string[]>('chatContextDenylist', [])
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    budget,
    denylistPatterns,
  };
}

export function normalizeBudget(value: string): ChatContextBudget {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'small' || normalized === 'large') {
    return normalized;
  }

  return 'medium';
}

export function isNodeAllowedForChat(node: GraphNode, denylistPatterns: string[]): boolean {
  return !shouldExcludePath(node.filePath, denylistPatterns);
}

export function shouldExcludePath(filePath: string, denylistPatterns: string[]): boolean {
  const normalizedPath = normalizePath(filePath);
  const patterns = [...DEFAULT_CHAT_DENYLIST_PATTERNS, ...denylistPatterns];

  return patterns.some((pattern) => matchesPattern(normalizedPath, pattern));
}

function matchesPattern(normalizedPath: string, rawPattern: string): boolean {
  const normalizedPattern = normalizePath(rawPattern);
  if (normalizedPattern.length === 0) {
    return false;
  }

  if (normalizedPattern.includes('*')) {
    return wildcardToRegExp(normalizedPattern).test(normalizedPath);
  }

  return normalizedPath.includes(normalizedPattern);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  return new RegExp(escaped, 'i');
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').toLowerCase();
}
