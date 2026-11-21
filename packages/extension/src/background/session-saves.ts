import type { FileDownloadOffer } from "../types/messages";
import { stableAddress } from "../util/media-address";

export interface SavePermit {
  finish(saved: boolean): Promise<void>;
}

interface RepeatPrompt {
  id: string;
  filename: string;
  tabId: number;
  pageUrl: string;
}

export function namedFileIdentity(pageUrl: string, offer: FileDownloadOffer): string[] {
  return ["file", stableAddress(offer.linkedPage ?? pageUrl), offer.filename];
}

// A receipt is created only after Chrome confirms completion. Keep the digest
// in extension session storage so service-worker suspension doesn't erase it.
const active = new Set<string>();
const memoryReceipts = new Set<string>();
const prompts = new Map<string, {prompt: RepeatPrompt; resolve: (allow: boolean) => void}>();

async function publish(tabId: number, pageUrl: string): Promise<boolean> {
  return await chrome.runtime.sendMessage({type: "repeat-save-changed", tabId, pageUrl}).catch(() => false) === true;
}

async function presentRepeat(prompt: RepeatPrompt): Promise<void> {
  const {id, tabId, pageUrl} = prompt;
  if (await publish(tabId, pageUrl) || !prompts.has(id)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url !== pageUrl || !prompts.has(id)) return;
  if (tab.active && chrome.action.openPopup) {
    try { await chrome.action.openPopup({windowId: tab.windowId}); return; }
    catch { /* Some browsers only open the popup from a toolbar gesture. */ }
  }
  chrome.tabs.sendMessage(tabId, {type: "hotkey-feedback", outcome: "preparing",
    detail: "Already saved this session. Open SaveMedia to choose another copy."}, {frameId: 0}, () => void chrome.runtime.lastError);
}

export function repeatPrompt(tabId: number, pageUrl: string): RepeatPrompt | null {
  return [...prompts.values()].find(entry => entry.prompt.tabId === tabId && entry.prompt.pageUrl === pageUrl)?.prompt ?? null;
}

export function answerRepeat(id: string, allow: boolean): void {
  prompts.get(id)?.resolve(allow);
}

export function dismissRepeats(tabId: number): void {
  for (const entry of prompts.values()) if (entry.prompt.tabId === tabId) entry.resolve(false);
}

async function confirmRepeat(tabId: number, pageUrl: string, filename: string): Promise<boolean> {
  const id = crypto.randomUUID();
  const prompt = {tabId, pageUrl, filename, id};
  return new Promise(resolve => {
    const timeout = setTimeout(() => answerRepeat(id, false), 120_000);
    prompts.set(id, {prompt, resolve: allow => {
      clearTimeout(timeout);
      prompts.delete(id);
      void publish(tabId, pageUrl);
      resolve(allow);
    }});
    void presentRepeat(prompt);
  });
}

async function receiptKey(identity: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  return "saved:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hasReceipt(key: string): Promise<boolean> {
  return memoryReceipts.has(key) || (await chrome.storage.session?.get(key))?.[key] === true;
}

export async function savedThisSession(pageUrl: string, offer: FileDownloadOffer): Promise<boolean> {
  return hasReceipt(await receiptKey(namedFileIdentity(pageUrl, offer)));
}

export async function reserveSave(identity: readonly string[], tabId: number, pageUrl: string, filename: string): Promise<SavePermit | null> {
  const key = await receiptKey(identity);
  if (active.has(key)) return null;
  active.add(key);
  try {
    if (await hasReceipt(key)) {
      if (!await confirmRepeat(tabId, pageUrl, filename) || (await chrome.tabs.get(tabId)).url !== pageUrl) {
        active.delete(key);
        return null;
      }
    }
    return {finish: async saved => {
      try {
        if (saved) {
          // A storage quota error must never turn a completed file into a failure.
          try {
            if (chrome.storage.session) await chrome.storage.session.set({[key]: true});
            else memoryReceipts.add(key);
          } catch { memoryReceipts.add(key); }
        }
      } finally { active.delete(key); }
    }};
  } catch (error) {
    active.delete(key);
    throw error;
  }
}
