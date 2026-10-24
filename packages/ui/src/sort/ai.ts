import { decide, quickReady, SURE } from '../ask/quick';
import { stemOf } from './plan';
import type { FileLook, SortFile, Topic } from './plan';

/**
 * The on-device model's part in a sort: for a document the rules could not
 * place (no topic word in its name or its first page), the small decider
 * (`ask/quick.ts`, the one that picks Ask ZOOD's quick actions) is asked
 * what kind of document it is. Only on this computer, only with the words
 * the host read; nothing is sent anywhere. Without the model downloaded,
 * the rules' folders stand.
 */

const QUESTION = 'What kind of document is this?';

const OPTIONS: Record<Topic | 'other', string> = {
  invoices: 'an invoice, a receipt or a bill / فاتورة أو إيصال',
  bank: 'a bank statement or a transfer / كشف حساب أو حوالة',
  contracts: 'a contract or an agreement / عقد أو اتفاقية',
  ids: 'an ID, a passport, a residence permit or a licence / هوية أو جواز أو إقامة أو رخصة',
  travel: 'a ticket, a booking or a boarding pass / تذكرة أو حجز',
  medical: 'a medical report, a prescription or lab results / تقرير طبي أو وصفة',
  cvs: 'a CV or a resume / سيرة ذاتية',
  certificates: 'a certificate or a diploma / شهادة',
  other: 'something else: a letter, a report, a book, notes / شيء آخر',
};

/** The most words of a file the model is given. */
const WORDS = 700;

export function stateOf(file: SortFile, look: FileLook): string {
  const text = look.texts.slice(0, 2).join('\n').replace(/\s+/g, ' ').trim().slice(0, WORDS);
  return `File name: ${stemOf(file.name)}\nFirst page: ${text}`;
}

/** Whether the model is there to ask. */
export async function sorterReady(): Promise<boolean> {
  return (await quickReady().catch(() => null)) !== null;
}

/**
 * The model's guess for each file it can read that the rules left without a
 * topic; `onGuess` hears each one as it comes (a few seconds each on a slow
 * computer). Stops when `signal` aborts.
 */
export async function guessTopics(
  files: readonly SortFile[],
  looks: ReadonlyMap<number, FileLook>,
  known: ReadonlyMap<number, Topic | null>,
  onGuess: (file: number, topic: Topic | null) => void,
  signal: AbortSignal,
): Promise<void> {
  const model = await quickReady().catch(() => null);
  if (!model) return;
  for (const file of files) {
    if (signal.aborted) return;
    const look = looks.get(file.index);
    if (known.get(file.index) || !look || look.texts.join('').trim().length < 20) continue;
    const ranked = await decide(model, stateOf(file, look), QUESTION, OPTIONS).catch(() => null);
    const top = ranked?.[0];
    const topic = top && top.p >= SURE && top.key !== 'other' && top.key in OPTIONS ? (top.key as Topic) : null;
    onGuess(file.index, topic);
  }
}
