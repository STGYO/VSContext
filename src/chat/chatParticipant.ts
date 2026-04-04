import * as path from 'path';
import * as vscode from 'vscode';

import { WorkspaceGraphBuilder } from '../graph/graphBuilder';
import { Logger } from '../utils/logger';
import { CrossLinkResolver } from '../utils/crossLinkResolver';
import { getChatContextSettings } from './contextFilters';
import { getQueryHelpMessage, orchestrateHybridQuery, type HybridQueryResult } from './queryOrchestrator';
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
const MODEL_REQUEST_ATTEMPTS = 2;
const MODEL_REQUEST_RETRY_DELAY_MS = 100;

export function registerVSContextChatParticipant(
  options: RegisterChatParticipantOptions,
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    try {
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

      const crossLinkResolver = new CrossLinkResolver(graph, options.logger);

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

      const enhancedMarkdown = crossLinkResolver.enhanceMarkdownWithCrossLinks(queryResult.renderedMarkdown);

      if (!request.model) {
        stream.markdown(enhancedMarkdown);
        return;
      }

      await sendModelResponseWithRetry(request.model, queryResult, enhancedMarkdown, stream, token, options.logger);
    } catch (error) {
      options.logger.error('VSContext chat participant failed to process the request.', error);
      stream.markdown('VSContext could not complete this request. Open the VSContext output channel, wait for indexing to finish, and try again or run /help for command usage.');
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

async function sendModelResponseWithRetry(
  model: NonNullable<vscode.ChatRequest['model']>,
  queryResult: HybridQueryResult,
  fallbackMarkdown: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  logger: Logger,
): Promise<void> {
  for (let attempt = 1; attempt <= MODEL_REQUEST_ATTEMPTS; attempt += 1) {
    if (token.isCancellationRequested) {
      return;
    }

    try {
      const modelRequest = await model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            'You are assisting with software architecture analysis. Use the provided VSContext query packet as evidence. Cite graph and semantic evidence directly, and state uncertainty explicitly when evidence is incomplete.',
          ),
          vscode.LanguageModelChatMessage.User(queryResult.modelPrompt),
        ],
        {},
        token,
      );

      if (!modelRequest) {
        throw new Error('The selected model was not available.');
      }

      let renderedModelResponse = '';
      for await (const fragment of modelRequest.text) {
        renderedModelResponse += fragment;
      }

      if (renderedModelResponse.trim().length > 0) {
        stream.markdown(renderedModelResponse);
      }
      return;
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }

      if (attempt < MODEL_REQUEST_ATTEMPTS) {
        logger.warn(`[VSContext] Chat model request attempt ${attempt} failed; retrying once. ${describeError(error)}`);
        await delay(MODEL_REQUEST_RETRY_DELAY_MS);
        continue;
      }

      logger.error('VSContext chat participant failed after retrying the model request.', error);
      stream.markdown('The selected model could not complete this request after two attempts. Here is the VSContext query packet that was prepared:');
      stream.markdown(fallbackMarkdown);
      return;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
