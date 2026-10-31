import { FilePlus2, FolderOpen } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';

/**
 * "Open a PDF to use this tool", with the button that does it. A tool chosen
 * from Home before any file is open said only the sentence, and people went
 * looking for how (First Five, 2026-10-31: Sara pressed Convert on Home and
 * found no way on from there). `create` adds the way the other direction:
 * Word, Excel or pictures into a PDF, which is what Convert means to many.
 */
export function OpenFirst({ create = false }: { create?: boolean }) {
  const t = useT();
  const state = useAppState();
  const { requestOpenFile, requestCreateFiles } = useServices();
  if (state.document !== null) return <p className="tool-panel-note">{t('tool.openFirst')}</p>;
  return (
    <div className="tool-open-first">
      <p className="tool-panel-note">{t('tool.openFirst')}</p>
      <div className="tool-actions">
        <IconButton label={t('tool.openButton')} icon={<Icon of={FolderOpen} />} showLabel variant="primary" onClick={requestOpenFile} />
        {create && (
          <IconButton label={t('tool.createFromOffice')} icon={<Icon of={FilePlus2} />} showLabel onClick={requestCreateFiles} />
        )}
      </div>
    </div>
  );
}
