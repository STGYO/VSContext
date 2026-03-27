import * as path from 'path';
import * as vscode from 'vscode';

import { WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { Logger } from '../utils/logger';
import { getChatContextSettings } from './contextFilters';
import { getQueryHelpMessage, orchestrateHybridQuery } from './queryOrchestrator';
import { WorkspaceSemanticIndexer } from '../semantic/semanticIndexer';

interface RegisterChatParticipantOptions {
  readonly extensionUri: vscode.Uri;
  readonly graphBuilder: WorkspaceGraphBuilder;
  readonly semanticIndexer: WorkspaceSemanticIndexer;
  readonly logger: Logger;
  readonly getLastTreeSelectionNodeId: () => string | undefined;
  readonly ensureGraphInitialized: () => Promise<void>;
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

    await options.ensureGraphInitialized();

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
    const queryResult = await orchestrateHybridQuery({
      request,
      graph,
      semanticIndexer: options.semanticIndexer,
      logger: options.logger,
      budget: settings.budget,
      denylistPatterns: settings.denylistPatterns,
      getLastTreeSelectionNodeId: options.getLastTreeSelectionNodeId,
    });

    if (!request.model) {
      stream.markdown(queryResult.renderedMarkdown);
      return;
    }

    try {
      const modelRequest = await request.model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            'You are assisting with software architecture analysis. Use the provided VSContext query packet as evidence. Cite graph and semantic evidence directly, and state uncertainty explicitly when evidence is incomplete.',
          ),
          vscode.LanguageModelChatMessage.User(queryResult.modelPrompt),
        ],
        {},
        token,
      );

      for await (const fragment of modelRequest.text) {
        stream.markdown(fragment);
      }
    } catch (error) {
      options.logger.error('VSContext chat participant failed to send model request.', error);
      stream.markdown('The selected model did not complete this request. Here is the VSContext query packet that was prepared:');
      stream.markdown(queryResult.renderedMarkdown);
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.file(path.join(options.extensionUri.fsPath, 'resources', 'activity-bar.svg'));

  options.logger.info('VSContext chat participant registered.');
  return participant;
}

function getHelpMessage(): string {
  return getQueryHelpMessage();
}
