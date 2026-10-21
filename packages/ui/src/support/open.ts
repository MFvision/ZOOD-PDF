/**
 * Which tab (and which article) Help & Support opens at. Set just before the
 * dialog opens, read once by it, like the tour's `openAt.ts`.
 */

export type SupportTab = 'ask' | 'learn' | 'report' | 'ideas';

let startAt: { tab: SupportTab; article?: string; question?: string } | null = null;

export function openSupportAt(tab: SupportTab, open: () => void, extra: { article?: string; question?: string } = {}): void {
  startAt = { tab, ...extra };
  open();
}

export function takeSupportStart(): { tab: SupportTab; article?: string; question?: string } {
  const taken = startAt ?? { tab: 'ask' as const };
  startAt = null;
  return taken;
}
