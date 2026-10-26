import { useI18n } from '../i18n/useT';
import { dropIcon, dropNote, dropWord } from '../sort/dropItems';
import { clearUse, readUse } from '../sort/dropUse';
import { autoRows } from '../sort/stow';
import { DEFAULT_SETTINGS, DROP_ITEMS, DROP_ROW_MAX, updateSettings, useSettings } from '../state/settings';
import type { DropItem } from '../state/settings';
import { ActionRow, Group } from './controls';
import { LayoutBoard } from './LayoutBoard';

/**
 * Settings › Quick tools › Drop panel: the panel at the top of the screen
 * (`sort/StowPanel.tsx`) as a little picture of itself. Drag any target
 * into the big row, the small row or the bottom row, where it takes that
 * row's size, or under the panel to stop showing it. With Auto on, ZOOD
 * moves the most used up into the big row (counted on this computer only,
 * `sort/dropUse.ts`), and the picture shows that.
 */
export function DropPanelSettings() {
  const { t } = useI18n();
  const settings = useSettings();
  const rows = { big: settings.dropBig, small: settings.dropSmall, pills: settings.dropPills };
  const shown = settings.dropAuto ? autoRows(rows, readUse()) : rows;
  const placed = new Set<DropItem>([...rows.big, ...rows.small, ...rows.pills]);
  return (
    <Group title={t('dropPanel.group')} note={t('dropPanel.groupNote')}>
      <LayoutBoard<DropItem>
        label={t('dropPanel.board')}
        hint={settings.dropAuto ? t('dropPanel.boardAuto') : t('dropPanel.boardHint')}
        frame="island"
        zones={[
          { id: 'big', label: t('dropPanel.big'), size: 'big', max: DROP_ROW_MAX.big },
          { id: 'small', label: t('dropPanel.small'), size: 'small' },
          { id: 'pills', label: t('dropPanel.pills'), size: 'pill', max: DROP_ROW_MAX.pills },
        ]}
        layout={shown}
        hidden={DROP_ITEMS.filter((item) => !placed.has(item))}
        look={(item) => ({ icon: dropIcon(item), word: dropWord(item, t), note: dropNote(item, t) })}
        onChange={(next) => updateSettings({ dropBig: next.big ?? [], dropSmall: next.small ?? [], dropPills: next.pills ?? [] })}
        auto={{ on: settings.dropAuto, label: t('dropPanel.auto'), hint: t('dropPanel.autoNote'), onChange: (dropAuto) => updateSettings({ dropAuto }) }}
      />
      <ActionRow
        label={t('dropPanel.reset')}
        hint={t('dropPanel.resetNote')}
        action={t('dropPanel.resetAction')}
        onClick={() => {
          clearUse();
          updateSettings({ dropBig: [...DEFAULT_SETTINGS.dropBig], dropSmall: [...DEFAULT_SETTINGS.dropSmall], dropPills: [...DEFAULT_SETTINGS.dropPills], dropAuto: DEFAULT_SETTINGS.dropAuto });
        }}
      />
    </Group>
  );
}
