import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Layers as LayersIcon, Lock, RotateCcw, Save } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { switched } from './tree';
import type { Layer, LayerNode } from './tree';
import './docpanes.css';

/**
 * Layers: the file's optional content groups, in the order it lists them,
 * read by Warraq's core. Showing or hiding one is view state: the reading
 * view is given a copy whose default configuration says so, and the file
 * keeps its own until the person saves the visibility with it.
 */
export function LayersPane() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { client, documentBytes, documentPassword, embedShowing, layersShown } = services;
  const [found, setFound] = useState<{ layers: Layer[]; order: LayerNode[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The copy the view shows, so each box says what is on screen.
  useEffect(() => {
    if (!documentBytes) return;
    let cancelled = false;
    client
      .callStatic<{ layers: Layer[]; order: LayerNode[] }>('layers.list', { password: documentPassword ?? null }, [documentBytes.slice(0)])
      .then(({ result }) => !cancelled && setFound(result))
      .catch(() => !cancelled && setFound({ layers: [], order: [] }));
    return () => {
      cancelled = true;
    };
  }, [client, documentBytes, documentPassword]);

  const ready = embedShowing && state.switching === null && !busy;

  const act = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setFailed(false);
    try {
      await work();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (found === null) return <p className="docpane-note">{t('pane.loading')}</p>;
  if (found.layers.length === 0) return <p className="docpane-note">{t('layers.none')}</p>;
  const byId = new Map(found.layers.map((layer) => [layer.id, layer]));

  const row = (layer: Layer) => (
    <label className="docpane-layer">
      <input
        type="checkbox"
        checked={layer.visible}
        disabled={!ready || layer.locked}
        onChange={() => {
          const visible = switched(found.layers, layer.id);
          // Ticked at once; the view follows when its copy is open.
          const before = found;
          setFound({ ...found, layers: found.layers.map((l) => ({ ...l, visible: visible.includes(l.id) })) });
          void act(() => services.showLayers(visible)).then((ok) => {
            if (!ok) setFound(before);
          });
        }}
      />
      <bdi dir="auto">{layer.name || '—'}</bdi>
      {layer.locked && (
        <span className="badge" title={t('layers.locked')}>
          <Icon of={Lock} size={11} /> {t('layers.locked')}
        </span>
      )}
      {layer.print !== null && layer.print !== layer.visible && <span className="badge">{t(layer.print ? 'layers.prints' : 'layers.noPrint')}</span>}
      {layer.export === false && <span className="badge">{t('layers.noExport')}</span>}
    </label>
  );

  const nodes = (list: LayerNode[], depth: number): ReactNode[] =>
    list.map((node, index) => {
      const children = node.children.length > 0 ? <ul role="group">{nodes(node.children, depth + 1)}</ul> : null;
      if ('label' in node) {
        return (
          <li key={`g${depth}-${index}`} role="treeitem" aria-level={depth + 1} aria-expanded="true" className="docpane-group">
            <bdi dir="auto">{node.label}</bdi>
            {children}
          </li>
        );
      }
      const layer = byId.get(node.id);
      if (!layer) return <li key={node.id} hidden />;
      return (
        <li key={node.id} role="treeitem" aria-level={depth + 1} aria-expanded={children ? true : undefined}>
          {row(layer)}
          {children}
        </li>
      );
    });

  return (
    <div className="docpane">
      <ul className="docpane-list docpane-layers" role="tree" aria-label={t('pane.layers')}>
        {nodes(found.order, 0)}
      </ul>
      {!embedShowing && <p className="docpane-note">{t('layers.readingOnly')}</p>}
      {layersShown !== null && (
        <div className="docpane-actions">
          <IconButton
            label={t('layers.keep')}
            icon={<Icon of={Save} />}
            showLabel
            variant="primary"
            disabled={!ready}
            onClick={() => {
              services.keepLayerVisibility();
              dispatch({ type: 'TOAST', key: 'layers.kept' });
            }}
          />
          <IconButton label={t('layers.reset')} icon={<Icon of={RotateCcw} />} showLabel disabled={!ready} onClick={() => void act(services.resetLayers)} />
        </div>
      )}
      {failed && (
        <p className="field-error" role="alert">
          {t('layers.failed')}
        </p>
      )}
      <p className="docpane-note">
        <Icon of={LayersIcon} size={12} /> {t('layers.viewNote')}
      </p>
    </div>
  );
}
