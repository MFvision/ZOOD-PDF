import { readJson, writeJson } from '../state/preferences';
import { LIMITS } from './config';
import { relay, relayGet } from './relay';
import type { RelayOptions } from './relay';

/**
 * Ideas: anyone writes one, anyone upvotes, no account. The relay keeps one
 * vote per install for each idea and files every idea for ZOOD to read in
 * the private repository, where its labels say how it stands.
 */

export type IdeaStatus = 'open' | 'planned' | 'building' | 'shipped';
export const IDEA_STATUSES: readonly IdeaStatus[] = ['open', 'planned', 'building', 'shipped'];

export interface Idea {
  id: string;
  title: string;
  body: string;
  votes: number;
  status: IdeaStatus;
  /** This install voted for it. */
  voted: boolean;
  /** This install wrote it. */
  mine: boolean;
  created: number;
  /** The version it arrived in, once shipped. */
  shippedIn?: string | null;
}

export type IdeaSort = 'top' | 'new';

interface Listed {
  ok: true;
  ideas: Idea[];
}

function clean(raw: unknown): Idea | null {
  if (!raw || typeof raw !== 'object') return null;
  const one = raw as Partial<Idea>;
  if (typeof one.id !== 'string' || typeof one.title !== 'string') return null;
  return {
    id: one.id,
    title: one.title.slice(0, LIMITS.ideaTitle),
    body: typeof one.body === 'string' ? one.body.slice(0, LIMITS.ideaBody) : '',
    votes: typeof one.votes === 'number' && Number.isFinite(one.votes) ? Math.max(0, Math.floor(one.votes)) : 0,
    status: IDEA_STATUSES.includes(one.status as IdeaStatus) ? (one.status as IdeaStatus) : 'open',
    voted: one.voted === true,
    mine: one.mine === true,
    created: typeof one.created === 'number' ? one.created : 0,
    shippedIn: typeof one.shippedIn === 'string' ? one.shippedIn : null,
  };
}

export function sortIdeas(list: readonly Idea[], sort: IdeaSort): Idea[] {
  const rank = (idea: Idea) => (idea.status === 'shipped' ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || (sort === 'top' ? b.votes - a.votes || b.created - a.created : b.created - a.created));
}

export async function loadIdeas(options: RelayOptions = {}): Promise<Idea[]> {
  const answer = await relayGet<Listed>('ideas', {}, options);
  return (Array.isArray(answer.ideas) ? answer.ideas : []).map(clean).filter((one): one is Idea => one !== null);
}

export function validIdea(title: string, body: string): boolean {
  const length = title.trim().length;
  return length >= 4 && length <= LIMITS.ideaTitle && body.length <= LIMITS.ideaBody;
}

export async function postIdea(title: string, body: string, lang: string, options: RelayOptions = {}): Promise<Idea> {
  const answer = await relay<{ ok: true; idea: unknown }>('idea', { title: title.trim(), body: body.trim(), lang }, options);
  const idea = clean(answer.idea);
  if (!idea) throw new Error('bad idea');
  return idea;
}

/** Turns this install's vote on or off; the relay answers with the new count. */
export async function vote(id: string, on: boolean, options: RelayOptions = {}): Promise<number> {
  const answer = await relay<{ ok: true; votes: number }>('vote', { idea: id, on }, options);
  return Math.max(0, Math.floor(answer.votes));
}

/** The person's own draft of an idea, kept while they write it. */
const DRAFT_KEY = 'warraq.support.ideaDraft';
export function readIdeaDraft(): { title: string; body: string } {
  const kept = readJson<{ title?: unknown; body?: unknown }>(DRAFT_KEY, {});
  return { title: typeof kept.title === 'string' ? kept.title : '', body: typeof kept.body === 'string' ? kept.body : '' };
}
export function writeIdeaDraft(title: string, body: string): void {
  writeJson(DRAFT_KEY, { title, body });
}
