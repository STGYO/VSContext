import { ImpactAnalysisResult } from '../analysis/impactAnalysis';
import { Logger } from '../utils/logger';
import { openAnalysisPanel } from './analysisPanelTemplate';

export function openImpactPanel(
  result: ImpactAnalysisResult,
  logger: Logger,
  onOpenNode: (nodeId: string) => Promise<void>,
): void {
  openAnalysisPanel(
    {
      panelId: 'vscontext.impactAnalysis',
      panelTitle: 'Impact Analysis Panel',
      heading: 'Impact Analysis',
      summaryPrefix: 'Affected nodes',
      graphAriaLabel: 'Impact analysis graph',
      emptyGraphMessage: 'No nodes available for this impact analysis.',
    },
    result,
    logger,
    onOpenNode,
  );
}
