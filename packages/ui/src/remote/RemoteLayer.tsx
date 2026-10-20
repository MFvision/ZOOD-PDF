import { useState } from 'react';
import './remote.css';
import { Presentation, Smartphone } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Popover } from '../components/Popover';
import { useI18n } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { remoteAvailable } from './host';
import { PresentMode } from './PresentMode';
import { RemotePanel } from './RemotePanel';
import { updateRemote, useRemoteView } from './store';
import { startPresenting, useRemoteController } from './useRemoteController';

/**
 * The phone remote and Present mode, mounted once in the shell: what a
 * phone's message does, and Present mode over everything while it is on.
 */
export function RemoteLayer() {
  const view = useRemoteView();
  const { reading, page, turnTo, present } = useRemoteController();
  if (!view.presenting) return null;
  return <PresentMode reading={reading} page={page} onTurn={turnTo} onClose={() => present(false)} />;
}

/**
 * The toolbar's two buttons: Present, and the phone remote's panel (the
 * desktop only: a browser cannot be reached from a phone).
 */
export function RemoteButtons() {
  const { t } = useI18n();
  const state = useAppState();
  const view = useRemoteView();
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const connected = (view.status?.phones.length ?? 0) > 0;

  return (
    <div className="toolbar-group toolbar-optional">
      {state.document !== null && (
        <IconButton label={t('present.start')} icon={<Icon of={Presentation} />} onClick={() => startPresenting(state.currentPage)} />
      )}
      {remoteAvailable() && (
        <>
          <span ref={setAnchor} className="remote-anchor">
          <IconButton
            className={connected ? 'remote-button-connected' : undefined}
            label={connected ? t('remote.connectedButton') : t('remote.button')}
            icon={<Icon of={Smartphone} />}
            pressed={view.panelOpen}
            onClick={() => updateRemote((v) => ({ panelOpen: !v.panelOpen }))}
          />
          </span>
          <Popover anchor={anchor} open={view.panelOpen} onClose={() => updateRemote({ panelOpen: false })} label={t('remote.title')} className="remote-popover">
            <RemotePanel />
          </Popover>
        </>
      )}
    </div>
  );
}
