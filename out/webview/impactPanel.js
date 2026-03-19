"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openImpactPanel = openImpactPanel;
const analysisPanelTemplate_1 = require("./analysisPanelTemplate");
function openImpactPanel(result, logger, onOpenNode) {
    (0, analysisPanelTemplate_1.openAnalysisPanel)({
        panelId: 'vscontext.impactAnalysis',
        panelTitle: 'Impact Analysis Panel',
        heading: 'Impact Analysis',
        summaryPrefix: 'Affected nodes',
        graphAriaLabel: 'Impact analysis graph',
        emptyGraphMessage: 'No nodes available for this impact analysis.',
    }, result, logger, onOpenNode);
}
//# sourceMappingURL=impactPanel.js.map