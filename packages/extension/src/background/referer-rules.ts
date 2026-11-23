// Hotlink-protected media hosts answer 403 without a Referer, and the
// extension's own probe and download requests send none. A session rule per
// media host gives the requests this extension makes from no tab (service
// worker, engine document) the page origin as Referer and as Origin: what
// the browser sends for the page's own player. The page's requests are not
// touched (tabIds: [-1]).
//
// The table is bounded and stored: a rule matches one exact host, a save or
// a check holds the rules its requests need until it ends, a held rule is
// never switched to another page's Referer, and idle rules beyond the limit
// go, oldest first. One holder gets a bounded number of rules, and so do all
// holders together. Ids are counted, never hashed, so two hosts cannot share one.
import type { Logger } from "../util/logger";
import type { RuleRecord } from "./state/records";

export interface SessionRulesApi {
  updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
  getSessionRules?(): Promise<readonly { readonly id: number }[]>;
}

export interface RefererRules {
  /** A one-off request: the page's Referer for this host, now. Settles when the rule is in place. */
  mirror(url: string, pageUrl: string): Promise<void>;
  /**
   * A save's or a check's request: the same, and the rule stays as it is
   * until release(holder). A check (see CHECK_HOLDER) that meets a rule
   * another check holds for another page waits for that check to end.
   */
  hold(holder: string, url: string, pageUrl: string): Promise<void>;
  release(holder: string): void;
  import(records: readonly RuleRecord[]): void;
  /** After a worker restart: let go of holders that no longer exist and drop browser rules the table does not know. */
  reconcile(live: ReadonlySet<string>): Promise<void>;
  records(): readonly RuleRecord[];
}

/** Rules nobody holds that are kept for the next probe of the same host. */
export const MAX_IDLE_RULES = 64;
/** Hosts one save or check may hold a rule for. Requests to further hosts go out without the page's Referer. */
export const MAX_HOLDER_RULES = 64;
/** Rules that may be held at the same time, by all saves and checks together. */
export const MAX_HELD_RULES = 256;
/** A holder with this prefix is a check: it lasts for one bounded request sequence and is never stored. */
export const CHECK_HOLDER = "probe:";

interface Entry { readonly id: number; referer: string; readonly holders: Set<string>; ready: Promise<void>; readonly freed: (() => void)[] }

const isCheck = (holder: string): boolean => holder.startsWith(CHECK_HOLDER);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exactly this host, on any port: never a parent domain's other hosts. */
export function hostFilter(host: string): string {
  return `^https?://([^/?#@]*@)?${escapeRegex(host.toLowerCase())}(:[0-9]+)?([/?#]|$)`;
}

export function createRefererRules(api: SessionRulesApi | undefined, extensionHost: string,
  options: { readonly onChange?: (records: readonly RuleRecord[]) => void; readonly logger?: Logger } = {}): RefererRules {
  const table = new Map<string, Entry>();
  // Browser calls run in the order they were made, so an id is free before it is used again.
  let chain: Promise<unknown> = Promise.resolve();
  const call = (update: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> => {
    const next = chain.then(() => api!.updateSessionRules(update));
    chain = next.catch(() => undefined);
    return next;
  };

  // A check's hold ends with the check, so it is not part of the stored table.
  const records = (): RuleRecord[] => [...table].map(([host, entry]) => ({ id: entry.id, host, referer: entry.referer,
    holders: [...entry.holders].filter(holder => !isCheck(holder)) }));
  const changed = (): void => options.onChange?.(records());

  function freeId(): number {
    const used = new Set([...table.values()].map(entry => entry.id));
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  function rule(id: number, host: string, origin: string): chrome.declarativeNetRequest.Rule {
    return {
      id,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        // The page's player sends both on its cross-origin requests; ours
        // otherwise name the extension as Origin, which a key or segment
        // server may refuse, and that refusal must not read as a licence.
        requestHeaders: [
          { header: "referer", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: `${origin}/` },
          { header: "origin", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: origin },
        ],
      },
      // -1 is TAB_ID_NONE: the page's own requests keep their Referer.
      condition: { regexFilter: hostFilter(host), initiatorDomains: [extensionHost], tabIds: [-1] },
    } as chrome.declarativeNetRequest.Rule;
  }

  function trim(): void {
    const idle = [...table].filter(([, entry]) => entry.holders.size === 0);
    for (const [host, entry] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_RULES))) {
      table.delete(host);
      void call({ removeRuleIds: [entry.id] }).catch(() => undefined);
    }
  }

  /** Whether `holder` may take one more rule: its own share and the share of all holders together. */
  function mayHold(holder: string, host: string): boolean {
    let own = 0;
    let held = 0;
    for (const [name, entry] of table) {
      if (entry.holders.has(holder) && name !== host) own++;
      if (entry.holders.size > 0 && name !== host) held++;
    }
    return own < MAX_HOLDER_RULES && (held < MAX_HELD_RULES || (table.get(host)?.holders.size ?? 0) > 0);
  }

  async function set(url: string, pageUrl: string, asked: string | null): Promise<void> {
    if (!api) return;
    let host: string;
    let origin: string;
    try {
      host = new URL(url).hostname;
      const page = new URL(pageUrl);
      if (page.protocol !== "https:" && page.protocol !== "http:") return;
      origin = page.origin;
    } catch {
      return;
    }
    if (!host) return;
    const referer = `${origin}/`;
    // Beyond its share a holder still gets the rule set, as a one-off request does, but holds nothing more.
    let holder = asked !== null && mayHold(asked, host) ? asked : null;
    if (asked !== null && holder === null) options.logger?.info("referer rule not held: limit reached", { host });
    for (;;) {
      const existing = table.get(host);
      if (existing?.referer === referer) {
        // Used again: the newest end of the order.
        table.delete(host);
        table.set(host, existing);
        if (holder && !existing.holders.has(holder)) {
          existing.holders.add(holder);
          if (!isCheck(holder)) changed();
        }
        return existing.ready;
      }
      const others = existing ? [...existing.holders].filter(other => other !== asked) : [];
      if (!existing || !others.length) {
        const entry: Entry = { id: existing?.id ?? freeId(), referer, holders: existing?.holders ?? new Set(), ready: Promise.resolve(),
          freed: existing?.freed ?? [] };
        if (holder) entry.holders.add(holder);
        table.delete(host);
        table.set(host, entry);
        entry.ready = call({ removeRuleIds: [entry.id], addRules: [rule(entry.id, host, origin)] }).catch(() => {
          // The browser refused the rule: the request goes out without it, and the next one tries again.
          if (table.get(host) === entry) { table.delete(host); for (const wake of entry.freed.splice(0)) wake(); changed(); }
        });
        trim();
        changed();
        return entry.ready;
      }
      // Another holder depends on the rule as it is. Two checks take turns: each lasts one bounded request
      // sequence. A check that already holds a rule never waits, so two checks cannot wait for each other.
      const holdsAnother = asked !== null && [...table.values()].some(entry => entry !== existing && entry.holders.has(asked));
      if (asked !== null && isCheck(asked) && others.every(isCheck) && !holdsAnother) {
        await new Promise<void>(resolve => { existing.freed.push(resolve); });
        holder = mayHold(asked, host) ? asked : null;
        continue;
      }
      // A running save holds it, or this check must not wait: the request goes out with the holder's Referer.
      options.logger?.info("referer rule held for another page", { host });
      return existing.ready;
    }
  }

  return {
    mirror: (url, pageUrl) => set(url, pageUrl, null),
    hold: (holder, url, pageUrl) => set(url, pageUrl, holder),
    release(holder) {
      let released = false;
      for (const entry of table.values()) {
        if (!entry.holders.delete(holder)) continue;
        released = true;
        // The checks that waited for this rule look at it again, in the order they came.
        for (const wake of entry.freed.splice(0)) wake();
      }
      if (!released) return;
      trim();
      if (!isCheck(holder)) changed();
    },
    import(stored) {
      for (const record of stored) {
        table.set(record.host, { id: record.id, referer: record.referer, holders: new Set(record.holders), ready: Promise.resolve(), freed: [] });
      }
    },
    async reconcile(live) {
      let dropped = false;
      // A stored holder that is no longer a running save. The checks of this worker instance are its own and stay.
      for (const entry of table.values()) {
        for (const holder of [...entry.holders]) if (!isCheck(holder) && !live.has(holder) && entry.holders.delete(holder)) dropped = true;
        for (const wake of entry.freed.splice(0)) wake();
      }
      if (api?.getSessionRules) {
        const known = new Set([...table.values()].map(entry => entry.id));
        const stale = (await api.getSessionRules().catch(() => [])).map(item => item.id).filter(id => !known.has(id));
        if (stale.length) await call({ removeRuleIds: stale }).catch(() => undefined);
      }
      trim();
      if (dropped) changed();
    },
    records,
  };
}
