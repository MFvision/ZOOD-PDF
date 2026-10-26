import { clearUse } from '../sort/dropUse';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { DROP_ITEMS, updateSettings, useSettings } from '../state/settings';
import type { DropItem } from '../state/settings';
import { ActionRow, Group, OrderedList, Toggle } from './controls';

/**
 * Settings › Quick tools › Drop panel: what the panel at the top of the
 * screen shows (`sort/StowPanel.tsx`) and in what order, row by row (the
 * tiles, the formats, the rest of ZOOD), dragged into place; or the most
 * used first, counted on this computer (`sort/dropUse.ts`).
 */

const FORMAT_NAMES: Record<string, string> = { jpg: 'JPG', png: 'PNG', webp: 'WebP', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', txt: 'TXT' };

const ROWS: { key: 'tile' | 'format' | 'more'; label: TKey }[] = [
  { key: 'tile', label: 'dropPanel.tiles' },
  { key: 'format', label: 'dropPanel.formats' },
  { key: 'more', label: 'dropPanel.more' },
];

export function DropPanelSettings() {
  const { t } = useI18n();
  const settings = useSettings();
  const name = (item: DropItem): string => {
    const [row, id] = item.split(':') as [string, string];
    if (row === 'tile') return `${t(`stow.tile.${id}` as TKey)} · ${t(`dropPanel.tileNote.${id}` as TKey)}`;
    if (row === 'more') return t(`stow.more.${id}` as TKey);
    return id === 'merge' ? t('stow.merge') : (FORMAT_NAMES[id] ?? id);
  };
  return (
    <Group title={t('dropPanel.group')} note={t('dropPanel.groupNote')}>
      <Toggle label={t('dropPanel.byUse')} hint={t('dropPanel.byUseNote')} checked={settings.dropByUse} onChange={(dropByUse) => updateSettings({ dropByUse })} />
      {ROWS.map((row) => {
        const items = settings.dropOrder.filter((item) => item.startsWith(`${row.key}:`));
        return (
          <OrderedList<DropItem>
            key={row.key}
            label={t(row.label)}
            hint={settings.dropByUse ? t('dropPanel.orderByUse') : t('dropPanel.orderNote')}
            items={items}
            hidden={settings.dropHidden.filter((item) => item.startsWith(`${row.key}:`))}
            name={name}
            onChange={(next, hidden) => {
              // This row's new order, the other rows as they were.
              const order = ROWS.flatMap(({ key }) => (key === row.key ? next : settings.dropOrder.filter((item) => item.startsWith(`${key}:`))));
              const others = settings.dropHidden.filter((item) => !item.startsWith(`${row.key}:`));
              updateSettings({ dropOrder: order, dropHidden: [...others, ...hidden] });
            }}
          />
        );
      })}
      <ActionRow
        label={t('dropPanel.reset')}
        hint={t('dropPanel.resetNote')}
        action={t('dropPanel.resetAction')}
        onClick={() => {
          clearUse();
          updateSettings({ dropOrder: [...DROP_ITEMS], dropHidden: [], dropByUse: false });
        }}
      />
    </Group>
  );
}
