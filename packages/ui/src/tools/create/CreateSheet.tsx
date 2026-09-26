/**
 * Create PDF sheet: pick or drop Word/Excel/PowerPoint/HTML/Markdown/text/CSV files and pictures
 * (JPEG/PNG/multi-page TIFF), reorder them, choose the page setup, and "Create". The engine
 * (warraq-create) lays the documents out with its own Arabic-first layout engine; the new PDF
 * opens unsaved in the viewer and is saved through the host bridge like any other document.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../services/AppContext';
import type { OpenedFile } from '../../services/host';
import { setDropClaim, takePendingCreateFiles } from '../../services/toolSheets';
import { EngineError } from '../../services/engine';
import { formatBytes, type MessageKey } from '../../i18n';
import { IconButton, Sheet, Tile } from '../../app/primitives';
import { Icon, type IconName } from '../../app/icons';
import {
  CREATE_ACCEPT,
  DEFAULT_SETTINGS,
  KIND_LABEL,
  createErrorKey,
  createKind,
  createPdfs,
  move,
  type CreateKind,
  type CreateSettings,
  type Margins,
  type Orientation,
  type PageSize,
} from './create';

interface Item extends OpenedFile {
  key: string;
  kind: CreateKind;
}

const KIND_ICON: Record<CreateKind, IconName> = {
  word: 'doc',
  excel: 'grid',
  powerpoint: 'pages',
  web: 'globe',
  markdown: 'edit',
  text: 'doc',
  table: 'grid',
  picture: 'scan',
};

let itemCounter = 0;

function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange,
  name,
}: {
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  name: string;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="segmented" role="radiogroup" aria-label={legend} data-testid={`create-${name}`}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? 'on' : ''}
            data-value={o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<CreateSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const addRef = useRef<(files: OpenedFile[]) => void>(() => {});
  const seeded = useRef(false);

  const add = (files: OpenedFile[]) => {
    const ok: Item[] = [];
    for (const f of files) {
      const kind = createKind(f.name);
      if (!kind) {
        app.toast(t('create.skipped', { name: f.name }), 'error');
        continue;
      }
      ok.push({ ...f, kind, key: `f${++itemCounter}` });
    }
    if (ok.length) setItems((cur) => [...cur, ...ok]);
  };
  // Keep the latest `add` for the drop handler (runs before the effect below, in order).
  useEffect(() => {
    addRef.current = add;
  });

  // Files given when the sheet opened (dropped on the window) and later drops go to the list.
  useEffect(() => {
    if (!seeded.current) {
      seeded.current = true;
      const initial = takePendingCreateFiles();
      if (initial.length) addRef.current(initial);
    }
    setDropClaim((files) => {
      addRef.current(files);
      return true;
    });
    return () => setDropClaim(null);
  }, []);

  const choose = async () => {
    try {
      add(await app.host.openFiles({ multiple: true, accept: CREATE_ACCEPT }));
    } catch (e) {
      app.toast(t('toast.openFailed', { name: e instanceof Error ? e.message : '' }), 'error');
    }
  };

  const create = async () => {
    if (!items.length || busy) return;
    setBusy(true);
    try {
      const out = await createPdfs(app.engine(), items, settings, app.state.locale);
      onClose();
      for (const d of out) await app.openNewDocument(d.name, d.bytes);
      app.toast(t('create.done', { count: out.length }), 'success');
    } catch (e) {
      const code = e instanceof EngineError ? e.code : undefined;
      app.toast(t(createErrorKey(code)), 'error');
      setBusy(false);
    }
  };

  const set = <K extends keyof CreateSettings>(k: K, v: CreateSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const opt = <T extends string>(prefix: string, values: T[]) =>
    values.map((v) => ({ value: v, label: t(`${prefix}.${v}` as MessageKey) }));

  return (
    <Sheet
      title={t('create.title')}
      onClose={() => !busy && onClose()}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-testid="create-run" disabled={!items.length || busy} onClick={() => void create()}>
            {busy ? t('create.working') : t('create.run')}
          </button>
        </>
      }
    >
      <p className="sheet-sub">{t('create.subtitle')}</p>
      <div className="create-drop" data-testid="create-drop">
        <Icon name="create" size={28} />
        <span>{t('create.drop')}</span>
        <button type="button" className="btn" data-testid="create-choose" onClick={() => void choose()} disabled={busy}>
          {t('create.choose')}
        </button>
        <span className="fineprint">{t('create.formats')}</span>
      </div>
      {items.length > 0 && (
        <section aria-label={t('create.files')}>
          <h3 className="create-count">{t('create.count', { count: items.length })}</h3>
          <ol className="create-list" data-testid="create-list">
            {items.map((it, i) => (
              <li key={it.key} className="create-item" data-name={it.name}>
                <Tile icon={KIND_ICON[it.kind]} colour={it.kind === 'picture' ? 'orange' : it.kind === 'excel' || it.kind === 'table' ? 'green' : 'blue'} size="sm" />
                <span className="create-item-text">
                  <bdi className="create-item-name">{it.name}</bdi>
                  <span className="create-item-meta">
                    {t(KIND_LABEL[it.kind])} · {formatBytes(it.bytes.byteLength, app.state.locale)}
                  </span>
                </span>
                <span className="create-item-actions">
                  <IconButton icon="moveUp" size={16} label={t('create.moveUp', { name: it.name })} disabled={i === 0 || busy} onClick={() => setItems((l) => move(l, i, -1))} />
                  <IconButton
                    icon="moveDown"
                    size={16}
                    label={t('create.moveDown', { name: it.name })}
                    disabled={i === items.length - 1 || busy}
                    onClick={() => setItems((l) => move(l, i, 1))}
                  />
                  <IconButton icon="trash" size={16} label={t('create.remove', { name: it.name })} disabled={busy} onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="create-options">
        <Segmented name="size" legend={t('create.pageSize')} value={settings.pageSize} options={opt<PageSize>('create.pageSize', ['auto', 'a4', 'letter'])} onChange={(v) => set('pageSize', v)} />
        <Segmented
          name="orientation"
          legend={t('create.orientation')}
          value={settings.orientation}
          options={opt<Orientation>('create.orientation', ['auto', 'portrait', 'landscape'])}
          onChange={(v) => set('orientation', v)}
        />
        <Segmented name="margins" legend={t('create.margins')} value={settings.margins} options={opt<Margins>('create.margins', ['normal', 'narrow', 'wide'])} onChange={(v) => set('margins', v)} />
      </div>
      <div className="create-checks">
        {items.length > 1 && (
          <label className="check">
            <input type="checkbox" data-testid="create-merge" checked={settings.merge} onChange={(e) => set('merge', e.target.checked)} />
            <span>{t('create.merge')}</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" data-testid="create-page-numbers" checked={settings.pageNumbers} onChange={(e) => set('pageNumbers', e.target.checked)} />
          <span>{t('create.pageNumbers')}</span>
        </label>
      </div>
      <p className="fineprint">{t('create.privacy')}</p>
    </Sheet>
  );
}
