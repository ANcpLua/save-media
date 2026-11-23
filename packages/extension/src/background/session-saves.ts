// One save per file at a time, and a question before the same file is saved
// twice in a browser session. Reservations, receipts and open questions are
// plain records, so a worker restart keeps them: an open question can still
// be answered, and a running save still knows which receipt to write.
import { canonicalAddress } from "../util/media-address";
import type { BackgroundToContentMessage, RepeatPromptView } from "../types/messages";
import { REPEAT } from "../ui/text";
import type { SessionStore } from "./state/session-store";
import { stateKeys, STATE_PREFIX, type ConfirmRequest, type PermitData, type PromptRecord } from "./state/records";

export type { PermitData } from "./state/records";

export interface SavePermit {
  readonly receiptKey?: string;
  readonly resumeKey?: string | null;
  finish(saved: boolean): Promise<void>;
}

export function namedFileIdentity(pageUrl: string, filename: string): string[] {
  return ["file", canonicalAddress(pageUrl), filename];
}

const active = new Set<string>();
/** Receipts the browser's session storage would not take. Every other receipt is read from that storage when it is needed. */
const memoryReceipts = new Set<string>();
const prompts = new Map<string, PromptRecord>();
const waiters = new Map<string, (allow: boolean) => void>();
/** Receipts whose repeat the user allowed after a restart: the next reservation of each passes without a question. */
const confirmed = new Set<string>();
let store: SessionStore | undefined;
let redispatch: ((request: ConfirmRequest) => Promise<void>) | undefined;
let onQuestion: ((tabId: number) => void) | undefined;
let onAsked: ((tabId: number) => void) | undefined;

/**
 * Where the records are stored, how an allowed repeat is started again when
 * nobody waits for the answer, who is told that a question was put to the
 * user of a tab (`onQuestion`), and who shows that the question waits in the
 * popup when the popup could not be opened (`onAsked`).
 */
export function configureSaves(options: { readonly store?: SessionStore; readonly redispatch?: (request: ConfirmRequest) => Promise<void>;
  readonly onQuestion?: (tabId: number) => void; readonly onAsked?: (tabId: number) => void }): void {
  store = options.store;
  redispatch = options.redispatch;
  onQuestion = options.onQuestion;
  onAsked = options.onAsked;
}

/**
 * The stored records of an earlier worker instance. `activeReceipts` belong
 * to running saves and resumes. An open question holds its file's
 * reservation, as it did before the restart: the same Save does not ask twice.
 */
export function importSaves(state: { readonly prompts: readonly PromptRecord[]; readonly activeReceipts: readonly string[] }): void {
  for (const prompt of state.prompts) {
    prompts.set(prompt.id, prompt);
    active.add(prompt.receiptKey);
  }
  for (const key of state.activeReceipts) active.add(key);
}

/** For tests: forget everything. */
export function resetSaves(): void {
  for (const set of [active, memoryReceipts, confirmed]) set.clear();
  prompts.clear();
  waiters.clear();
  store = undefined;
  redispatch = undefined;
  onQuestion = undefined;
  onAsked = undefined;
}

const savePrompts = (): void => store?.put(stateKeys.prompts, [...prompts.values()]);

async function publish(tabId: number, pageUrl: string): Promise<boolean> {
  return await chrome.runtime.sendMessage({type: "repeat-save-changed", tabId, pageUrl}).catch(() => false) === true;
}

async function presentRepeat(prompt: PromptRecord): Promise<void> {
  const {id, tabId, pageUrl} = prompt;
  if (await publish(tabId, pageUrl) || !prompts.has(id)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url !== pageUrl || !prompts.has(id)) return;
  if (tab.active && chrome.action.openPopup) {
    try { await chrome.action.openPopup({windowId: tab.windowId}); return; }
    catch { /* Some browsers only open the popup from a toolbar gesture. */ }
  }
  // The popup could not be opened: the page says where the question waits. Shown again on each press while it is open.
  if (onAsked) onAsked(tabId);
  else chrome.tabs.sendMessage(tabId, {type: "hotkey-feedback", outcome: "asked", detail: REPEAT.toast} satisfies BackgroundToContentMessage,
    {frameId: 0}, () => void chrome.runtime.lastError);
}

export function repeatPrompt(tabId: number, pageUrl: string): RepeatPromptView | null {
  const record = [...prompts.values()].find(prompt => prompt.tabId === tabId && prompt.pageUrl === pageUrl);
  return record ? { id: record.id, filename: record.filename, tabId, pageUrl } : null;
}

function close(id: string): PromptRecord | undefined {
  const record = prompts.get(id);
  if (!record) return undefined;
  prompts.delete(id);
  savePrompts();
  void publish(record.tabId, record.pageUrl);
  return record;
}

/**
 * The user's answer. A save that still waits for it goes on. After a worker
 * restart nobody waits: an allowed repeat is started again from the stored
 * request. An unknown id answers { ok: false } and the popup reads the state again.
 */
export async function answerRepeat(id: string, allow: boolean): Promise<{ readonly ok: boolean }> {
  const record = close(id);
  if (!record) return { ok: false };
  const waiter = waiters.get(id);
  waiters.delete(id);
  if (waiter) { waiter(allow); return { ok: true }; }
  // Nobody waits: the question held the reservation itself. The confirmed start takes it again.
  active.delete(record.receiptKey);
  if (allow && redispatch) {
    confirmed.add(record.receiptKey);
    try { await redispatch(record.request); }
    finally { confirmed.delete(record.receiptKey); }
  }
  return { ok: true };
}

/** The tab navigated or closed: its open questions end with "no". */
export function dismissRepeats(tabId: number): void {
  for (const record of [...prompts.values()]) {
    if (record.tabId !== tabId) continue;
    close(record.id);
    const waiter = waiters.get(record.id);
    waiters.delete(record.id);
    if (waiter) waiter(false);
    // A question restored after a worker restart held the reservation itself.
    else active.delete(record.receiptKey);
  }
}

/** Ask once. The question stays open until it is answered, or the tab navigates or closes: no clock ends it. */
function confirmRepeat(prompt: Omit<PromptRecord, "v" | "id">): Promise<boolean> {
  const record: PromptRecord = { v: 1, id: crypto.randomUUID(), ...prompt };
  return new Promise(resolve => {
    prompts.set(record.id, record);
    waiters.set(record.id, resolve);
    savePrompts();
    // The press that asked is answered by the question: the tab's next Alt+S is a new press.
    onQuestion?.(record.tabId);
    void presentRepeat(record);
  });
}

async function receiptKey(identity: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  return "saved:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A receipt lives in the browser's session storage, so it is there for every worker instance of the session. */
async function hasReceipt(key: string): Promise<boolean> {
  if (memoryReceipts.has(key)) return true;
  const stored = STATE_PREFIX + key;
  return (await chrome.storage?.session?.get(stored).catch(() => undefined))?.[stored] === true;
}

export async function savedThisSession(pageUrl: string, filename: string): Promise<boolean> {
  return hasReceipt(await receiptKey(namedFileIdentity(pageUrl, filename)));
}

/** A permit from its stored data: what a restored job finishes with. */
export function permitFrom(data: PermitData): SavePermit {
  return { ...data, finish: async saved => {
    try {
      // A receipt is written only after the browser confirmed the file.
      // A storage quota error must never turn a completed file into a failure: memory keeps the receipt then.
      if (saved) {
        try {
          if (chrome.storage?.session) await chrome.storage.session.set({ [STATE_PREFIX + data.receiptKey]: true });
          else memoryReceipts.add(data.receiptKey);
        } catch { memoryReceipts.add(data.receiptKey); }
      }
    } finally { active.delete(data.receiptKey); }
  } };
}

/**
 * Reserve a save. Null when the same file is being saved already, or when
 * the user declined to save it a second time. `request` is what to start
 * again should the answer arrive after a worker restart. `allowRepeat`: the
 * user already chose "Save another copy", so nothing is asked.
 */
export async function reserveSave(identity: readonly string[], tabId: number, pageUrl: string, filename: string,
  options: { readonly request?: ConfirmRequest; readonly allowRepeat?: boolean } = {}): Promise<SavePermit | null> {
  const key = await receiptKey(identity);
  if (active.has(key)) {
    // The file's question is still open: it is shown again, not asked a second time.
    const open = [...prompts.values()].find(prompt => prompt.receiptKey === key);
    if (open) void presentRepeat(open);
    return null;
  }
  active.add(key);
  try {
    // "Save another copy" in the popup is the answer already: the question is asked once, never twice.
    if (await hasReceipt(key) && !confirmed.delete(key) && !options.allowRepeat) {
      const allowed = await confirmRepeat({ tabId, pageUrl, filename, receiptKey: key, request: options.request ?? { kind: "page", tabId, pageUrl } });
      if (!allowed || (await chrome.tabs.get(tabId)).url !== pageUrl) {
        active.delete(key);
        return null;
      }
    }
    // The selected file's download link can point to a different server on
    // the next click. Anchor its checkpoint to the publisher page and name.
    const resumeKey = identity[0] === "file" ? await receiptKey(["resume", canonicalAddress(pageUrl), filename]) : key;
    return permitFrom({ receiptKey: key, resumeKey });
  } catch (error) {
    active.delete(key);
    throw error;
  }
}
