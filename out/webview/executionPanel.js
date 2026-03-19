"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openExecutionPanel = openExecutionPanel;
const analysisPanelTemplate_1 = require("./analysisPanelTemplate");
function openExecutionPanel(result, logger, onOpenNode) {
    (0, analysisPanelTemplate_1.openAnalysisPanel)({
        panelId: 'vscontext.executionTrace',
        panelTitle: 'Execution Trace Panel',
        heading: 'Execution Trace',
        summaryPrefix: 'Nodes visited',
        graphAriaLabel: 'Execution trace graph',
        emptyGraphMessage: 'No nodes available for this execution trace.',
    }, result, logger, onOpenNode);
}
//# sourceMappingURL=executionPanel.js.map