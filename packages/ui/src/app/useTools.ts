import { useCallback } from 'react';
import { useApp } from '../services/AppContext';
import { toolById, type ToolDef, type ToolId } from '../tools/registry';

/** Starts a tool: on the current document, or after the user picks a file. */
export function useStartTool() {
  const app = useApp();
  return useCallback(
    (id: ToolId, docId?: string) => {
      const tool: ToolDef | undefined = toolById(id);
      if (!tool || tool.status !== 'ready') return;
      if (tool.core && !tool.needsDocument) {
        void tool.core.open();
        return;
      }
      const target = docId ?? app.state.order[app.state.order.length - 1];
      if (!target) {
        void app.openFromHost(id);
        return;
      }
      if (app.state.route.name !== 'document' || app.state.route.id !== target) {
        app.dispatch({ type: 'SET_ROUTE', route: { name: 'document', id: target } });
      }
      runTool(tool, app.viewer(target), (panel) => app.dispatch({ type: 'SET_PANEL', id: target, panel }));
    },
    [app],
  );
}

export function runTool(tool: ToolDef, viewer: { exec(cmd: string): void } | undefined, openPanel?: (panel: string) => void): boolean {
  if (tool.panel && openPanel) {
    openPanel(tool.panel);
    return true;
  }
  if (tool.viewer && viewer) {
    for (const cmd of tool.viewer.commands) viewer.exec(cmd);
    return true;
  }
  if (tool.core) {
    void tool.core.open();
    return true;
  }
  return false;
}
