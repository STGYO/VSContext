import { ExecutionTraceResult } from '../analysis/executionTrace';
import { Logger } from '../utils/logger';
import { openAnalysisPanel } from './analysisPanelTemplate';

export function openExecutionPanel(
  result: ExecutionTraceResult,
  logger: Logger,
  onOpenNode: (nodeId: string) => Promise<void>,
): void {
  openAnalysisPanel(
    {
      panelId: 'vscontext.executionTrace',
      panelTitle: 'Execution Trace Panel',
      heading: 'Execution Trace',
      summaryPrefix: 'Nodes visited',
      graphAriaLabel: 'Execution trace graph',
      emptyGraphMessage: 'No nodes available for this execution trace.',
    },
    result,
    logger,
    onOpenNode,
  );
}
