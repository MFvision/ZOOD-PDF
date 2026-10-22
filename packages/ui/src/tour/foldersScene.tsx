import { ArrowUpRight, Cloud, FolderOpen, MousePointer2, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCloud } from '../cloud/CloudContext';
import { Icon } from '../components/Icon';
import { FolderCard } from '../home/FolderCard';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { Glow, Replay, Steps, usePhases } from './scenes';

/**
 * Folders in the tour: real folder cards to play with. The steps lean the
 * first one open, fan it, then show "New folder" taking a page; hovering
 * and clicking them does the same by hand. The cloud drives step is there
 * only in a build that has a drive.
 */
export function FoldersScene({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const cloud = useCloud();
  const steps: { icon: LucideIcon; text: TKey }[] = [
    { icon: MousePointer2, text: 'tour.folders.s1' },
    { icon: FolderOpen, text: 'tour.folders.s2' },
    { icon: Plus, text: 'tour.folders.s3' },
    ...(cloud.providers.length > 0 ? [{ icon: Cloud, text: 'tour.folders.s4' as TKey }] : []),
  ];
  const { phase, pick, playing, replay } = usePhases(steps.length, 2200);
  return (
    <div className="tour-scene tour-split">
      <div>
        <Steps steps={steps} phase={phase} onPick={pick} />
        <div className="tour-support-open">
          <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={onOpen}>
            <Icon of={FolderOpen} size={14} />
            {t('tour.folders.open')}
          </button>
          {!playing && <Replay onClick={replay} />}
        </div>
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="tour-folders">
          <FolderCard
            name={t('tour.folders.demo1')}
            detail={t('folders.count', { count: 12 })}
            tone="navy"
            pages={[]}
            badge={<Icon of={ArrowUpRight} size={14} mirror />}
            peek={phase === 0}
            open={phase === 1}
            onOpen={() => pick(1)}
          />
          <FolderCard
            name={t('tour.folders.demo2')}
            detail={t('folders.count', { count: 4 })}
            tone="sand"
            pages={[]}
            badge={<Icon of={ArrowUpRight} size={14} mirror />}
            onOpen={() => pick(1)}
          />
          <FolderCard name={t('folders.add')} detail={t('folders.addDetail')} tone="add" pages={[]} badge={<Icon of={Plus} size={15} />} peek={phase === 2} onOpen={() => pick(2)} />
          {cloud.providers.map((provider) => (
            <FolderCard
              key={provider}
              name={t(`cloud.name.${provider}`)}
              detail={t('folders.signIn')}
              tone={provider}
              pages={[]}
              badge={<Icon of={Cloud} size={14} />}
              peek={phase === 3}
              onOpen={() => pick(3)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
