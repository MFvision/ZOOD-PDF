import { keyValueStore } from '../../state/idb';
import type { Turn } from './store';

/**
 * A document's conversation kept on this device after the app closes, when
 * Settings › AI › Keep chat history is on: the turns only (what was asked and
 * answered, with their citations), under the file's key. Off by default, so
 * a conversation lives only as long as the app is open unless the person
 * chooses otherwise. "Delete all chat history" empties it.
 */
export const savedChats = keyValueStore<Turn[]>('zood-chats');
