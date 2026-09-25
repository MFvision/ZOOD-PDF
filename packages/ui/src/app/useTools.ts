import { useCallback } from 'react';
import { useApp } from '../services/AppContext';
import { toolById, type ToolDef, type ToolId } from '../tools/registry';
import { withToolTarget } from '../services/toolBus';

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
      withToolTarget(target, () => runTool(tool, app.viewer(target)));
    },
    [app],
  );
}

export function runTool(tool: ToolDef, viewer: { exec(cmd: string): void } | undefined): boolean {
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
