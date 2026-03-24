import * as path from 'path';
import * as vscode from 'vscode';

import { WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { Logger } from '../utils/logger';
import { getChatContextSettings } from './contextFilters';
import { resolveFocusNode } from './focusResolver';
import { buildWorkspaceContextSummary } from './contextSummary';
import { WorkspaceSemanticIndexer } from '../semantic/semanticIndexer';

interface RegisterChatParticipantOptions {
  readonly extensionUri: vscode.Uri;
  readonly graphBuilder: WorkspaceGraphBuilder;
  readonly semanticIndexer: WorkspaceSemanticIndexer;
  readonly logger: Logger;
  readonly getLastTreeSelectionNodeId: () => string | undefined;
}

const PARTICIPANT_ID = 'vscontext.chat-assistant';

export function registerVSContextChatParticipant(
  options: RegisterChatParticipantOptions,
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const command = request.command?.toLowerCase();

    if (command === 'help') {
      stream.markdown(getHelpMessage());
      return;
    }

    if (options.graphBuilder.isIndexing() && !options.graphBuilder.hasCompletedInitialIndex()) {
      stream.markdown('VSContext is still indexing the workspace. Try again in a moment.');
      return;
    }

    const graph = await options.graphBuilder.getGraph();
    if (graph.nodes.size === 0) {
      stream.markdown('VSContext graph is empty. Open a workspace with supported source files and retry.');
      return;
    }

    const settings = getChatContextSettings();
    const focusNode = resolveFocusNode(graph, {
      explicitNodeId: extractExplicitNodeId(request),
      treeSelectionNodeId: options.getLastTreeSelectionNodeId(),
      prompt: request.prompt,
    });

    if ((command === 'trace' || command === 'impact') && !focusNode) {
      stream.markdown('No symbol could be resolved for trace or impact. Place your cursor inside a symbol, pick one in the VSContext tree, or include the symbol name in your prompt.');
      return;
    }

    const contextSummary = await buildWorkspaceContextSummary(graph, {
      budget: settings.budget,
      denylistPatterns: settings.denylistPatterns,
      focusNode,
    });

    const semanticQuery = (focusNode?.symbolName || request.prompt).trim();
    let semanticSummary = '';
    if (semanticQuery.length > 0) {
      const semanticResult = await options.semanticIndexer.search(graph, semanticQuery, {
        focusNodeId: focusNode?.id,
        maxResults: settings.budget === 'small' ? 4 : 6,
      });

      if (semanticResult.hits.length > 0) {
        semanticSummary = options.semanticIndexer.formatSearchResult(semanticResult);
      }
    }

    const combinedSummary = semanticSummary.length > 0
      ? `${contextSummary}\n\n${semanticSummary}`
      : contextSummary;

    const hasPromptText = request.prompt.trim().length > 0;

    if (command === 'summary' && !hasPromptText) {
      stream.markdown(combinedSummary);
      return;
    }

    if (!request.model) {
      stream.markdown(combinedSummary);
      return;
    }

    const chatPrompt = createPromptForCommand(command, request.prompt);

    try {
      const modelRequest = await request.model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            'You are assisting with software architecture analysis. Use the provided VSContext graph summary as structural context. If information is missing from the summary, state uncertainty explicitly.',
          ),
          vscode.LanguageModelChatMessage.User(
            `VSContext summary:\n${combinedSummary}\n\nUser request:\n${chatPrompt}\n\nAnswer the user request using only this summary as architecture context.`,
          ),
        ],
        {},
        token,
      );

      for await (const fragment of modelRequest.text) {
        stream.markdown(fragment);
      }
    } catch (error) {
      options.logger.error('VSContext chat participant failed to send model request.', error);
      stream.markdown('The selected model did not complete this request. Here is the VSContext summary that was prepared:');
      stream.markdown(combinedSummary);
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.file(path.join(options.extensionUri.fsPath, 'resources', 'activity-bar.svg'));

  options.logger.info('VSContext chat participant registered.');
  return participant;
}

function extractExplicitNodeId(request: vscode.ChatRequest): string | undefined {
  const match = /nodeId\s*=\s*([A-Za-z0-9:_\-/.]+)/i.exec(request.prompt);
  if (!match) {
    return undefined;
  }

  return match[1];
}

function createPromptForCommand(command: string | undefined, prompt: string): string {
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length > 0) {
    return trimmedPrompt;
  }

  if (command === 'trace') {
    return 'Explain downstream behavior using the focus symbol traversal.';
  }

  if (command === 'impact') {
    return 'Explain upstream impact and likely blast radius using the focus symbol traversal.';
  }

  return 'Summarize the most important architecture insights from this workspace context.';
}

function getHelpMessage(): string {
  return [
    'VSContext chat commands:',
    '- /summary: show compact workspace context summary.',
    '- /trace: focus on downstream traversal around the resolved symbol.',
    '- /impact: focus on upstream impact around the resolved symbol.',
    '',
    'Focus resolution order:',
    '1. explicit nodeId in prompt (nodeId=<id>)',
    '2. active editor symbol under cursor',
    '3. last selected symbol in VSContext tree',
    '4. symbol name inferred from prompt text',
  ].join('\n');
}
