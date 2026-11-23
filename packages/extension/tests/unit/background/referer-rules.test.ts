import { describe, expect, it, vi } from "vitest";
import { createRefererRules, hostFilter, MAX_HELD_RULES, MAX_HOLDER_RULES, MAX_IDLE_RULES } from "../../../src/background/referer-rules";
import type { RuleRecord } from "../../../src/background/state/records";

type Update = chrome.declarativeNetRequest.UpdateRuleOptions;

function rules(overrides: { getSessionRules?: () => Promise<{ id: number }[]> } = {}) {
  const updateSessionRules = vi.fn(async (_options: Update) => {});
  const stored: RuleRecord[][] = [];
  const instance = createRefererRules({ updateSessionRules, ...overrides }, "extension-id", { onChange: records => { stored.push([...records]); } });
  const added = () => updateSessionRules.mock.calls.flatMap(([options]) => options.addRules ?? []);
  const removed = () => updateSessionRules.mock.calls.flatMap(([options]) => options.addRules ? [] : options.removeRuleIds ?? []);
  return { instance, updateSessionRules, stored, added, removed };
}

describe("Referer rules", () => {
  it("gives only the extension's own requests to exactly that media host the page origin as Referer and Origin", async () => {
    const { instance, updateSessionRules } = rules();
    await instance.mirror("https://media.example/v/clip.mp4?token=a", "https://www.example/watch/1");
    const options = updateSessionRules.mock.calls[0]![0];
    const rule = options.addRules![0]!;
    expect(options.removeRuleIds).toEqual([rule.id]);
    expect(rule.action.requestHeaders).toEqual([{ header: "referer", operation: "set", value: "https://www.example/" },
      { header: "origin", operation: "set", value: "https://www.example" }]);
    expect(rule.condition).toEqual({ regexFilter: hostFilter("media.example"), initiatorDomains: ["extension-id"], tabIds: [-1] });
  });

  it("matches one host, never the other hosts of a parent domain", () => {
    const matches = (host: string, url: string) => new RegExp(hostFilter(host), "i").test(url);
    expect(matches("media.example", "https://media.example/a.mp4")).toBe(true);
    expect(matches("media.example", "http://media.example:8080/a.mp4?x=1")).toBe(true);
    expect(matches("media.example", "https://user:pw@media.example/a.mp4")).toBe(true);
    expect(matches("media.example", "https://cdn.media.example/a.mp4")).toBe(false);
    expect(matches("media.example", "https://mediaXexample/a.mp4")).toBe(false);
    expect(matches("media.example", "https://evil.test/https://media.example/")).toBe(false);
    // A forged capture for a public suffix reaches that literal host only.
    expect(matches("co.uk", "https://bank.co.uk/login")).toBe(false);
    expect(matches("com", "https://shop.com/")).toBe(false);
    expect(matches("127.0.0.1", "http://127.0.0.1:4173/clip.mp4")).toBe(true);
    expect(matches("[::1]", "http://[::1]:4173/clip.mp4")).toBe(true);
  });

  it("writes a host's rule again only when the page origin changes, under the same id", async () => {
    const { instance, updateSessionRules, added } = rules();
    await instance.mirror("https://media.example/a.mp4?token=1", "https://www.example/watch/1");
    await instance.mirror("https://media.example/b.mp4?token=2", "https://www.example/watch/2");
    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    await instance.mirror("https://media.example/c.mp4", "https://other.example/embed/3");
    const [first, second] = added();
    expect(second!.id).toBe(first!.id);
    expect(second!.action.requestHeaders![0]!.value).toBe("https://other.example/");
  });

  it("gives every host its own counted id, so two hosts can never share a rule", async () => {
    const { instance, added } = rules();
    for (let index = 0; index < 40; index++) await instance.mirror(`https://h${index}.example/a.mp4`, "https://www.example/");
    const ids = added().map(rule => rule.id);
    expect(new Set(ids).size).toBe(40);
    expect(Math.max(...ids)).toBe(40);
  });

  it("keeps a bounded number of idle rules and removes the oldest from the browser", async () => {
    const { instance, removed } = rules();
    for (let index = 0; index < MAX_IDLE_RULES + 10; index++) await instance.mirror(`https://h${index}.example/a.mp4`, "https://www.example/");
    expect(instance.records()).toHaveLength(MAX_IDLE_RULES);
    expect(removed()).toHaveLength(10);
    expect(instance.records().map(record => record.host)).not.toContain("h0.example");
    // A used rule is the newest again.
    await instance.mirror("https://h10.example/b.mp4", "https://www.example/");
    await instance.mirror("https://fresh.example/a.mp4", "https://www.example/");
    expect(instance.records().map(record => record.host)).toContain("h10.example");
    expect(instance.records().map(record => record.host)).not.toContain("h11.example");
  });

  it("never switches or drops a rule a running save holds, and frees it when the save ends", async () => {
    const { instance, updateSessionRules, added } = rules();
    await instance.hold("job-a", "https://cdn.shared.example/a/seg1.ts", "https://a.example/watch");
    // Another tab's page on the same host: its check goes out with the running save's Referer.
    await instance.mirror("https://cdn.shared.example/b/clip.mp4", "https://b.example/watch");
    await instance.hold("job-b", "https://cdn.shared.example/b/clip.mp4", "https://b.example/watch");
    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    expect(instance.records()).toEqual([{ id: 1, host: "cdn.shared.example", referer: "https://a.example/", holders: ["job-a"] }]);
    // Held rules do not count against the idle limit.
    for (let index = 0; index < MAX_IDLE_RULES + 5; index++) await instance.mirror(`https://h${index}.example/a.mp4`, "https://www.example/");
    expect(instance.records().map(record => record.host)).toContain("cdn.shared.example");
    instance.release("job-a");
    await instance.mirror("https://cdn.shared.example/b/clip.mp4", "https://b.example/watch");
    expect(added().at(-1)!.action.requestHeaders![0]!.value).toBe("https://b.example/");
  });

  it("the save that holds a rule may change it", async () => {
    const { instance, added } = rules();
    await instance.hold("job-a", "https://media.example/a.ts", "https://a.example/");
    await instance.hold("job-a", "https://media.example/a.ts", "https://embed.example/");
    expect(added().at(-1)!.action.requestHeaders![0]!.value).toBe("https://embed.example/");
  });

  it("tries again after the browser rejected a rule", async () => {
    const updateSessionRules = vi.fn<(options: Update) => Promise<void>>().mockRejectedValueOnce(new Error("rule limit")).mockResolvedValue(undefined);
    const instance = createRefererRules({ updateSessionRules }, "extension-id");
    await instance.mirror("https://media.example/clip.mp4", "https://www.example/watch/1");
    expect(instance.records()).toEqual([]);
    await instance.mirror("https://media.example/clip.mp4", "https://www.example/watch/1");
    expect(updateSessionRules).toHaveBeenCalledTimes(2);
    expect(instance.records()).toHaveLength(1);
  });

  it("leaves requests alone for pages and media that are not on the web", async () => {
    const { instance, updateSessionRules } = rules();
    await instance.mirror("https://media.example/clip.mp4", "chrome-extension://abc/src/popup/index.html");
    await instance.mirror("blob:https://www.example/1234", "https://www.example/watch/1");
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it("after a worker restart: keeps the stored table, lets go of saves that are gone and removes rules it does not know", async () => {
    const first = rules();
    await first.instance.hold("job-a", "https://media.example/a.ts", "https://a.example/");
    await first.instance.hold("job-gone", "https://other.example/a.ts", "https://a.example/");
    const restarted = rules({ getSessionRules: async () => [{ id: 1 }, { id: 2 }, { id: 977 }] });
    restarted.instance.import(JSON.parse(JSON.stringify(first.stored.at(-1))) as RuleRecord[]);
    await restarted.instance.reconcile(new Set(["job-a"]));
    expect(restarted.removed()).toEqual([977]);
    expect(restarted.instance.records()).toEqual([
      { id: 1, host: "media.example", referer: "https://a.example/", holders: ["job-a"] },
      { id: 2, host: "other.example", referer: "https://a.example/", holders: [] },
    ]);
    // The known rule is in the browser already: the same request writes nothing.
    await restarted.instance.hold("job-a", "https://media.example/b.ts", "https://a.example/");
    expect(restarted.added()).toEqual([]);
  });

  it("a check holds its rule until it ends: another page's check of the same host waits its turn, and neither is stored", async () => {
    const { instance, added, stored } = rules();
    await instance.hold("probe:1:1", "https://cdn.shared.example/a.m3u8", "https://a.example/watch");
    const writes = stored.length;
    let second = "waiting";
    const other = instance.hold("probe:2:1", "https://cdn.shared.example/b.m3u8", "https://b.example/watch").then(() => { second = "held"; });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    // The first check's later requests still go out with its own page's Referer.
    expect(second).toBe("waiting");
    expect(added().map(rule => rule.action.requestHeaders![0]!.value)).toEqual(["https://a.example/"]);
    instance.release("probe:1:1");
    await other;
    expect(added().map(rule => rule.action.requestHeaders![0]!.value)).toEqual(["https://a.example/", "https://b.example/"]);
    // A check is never a stored holder: a worker restart cannot leave its rule held for ever.
    expect(instance.records()).toEqual([{ id: 1, host: "cdn.shared.example", referer: "https://b.example/", holders: [] }]);
    instance.release("probe:2:1");
    expect(stored.every(table => table.every(record => record.holders.length === 0))).toBe(true);
    expect(stored.length).toBe(writes + 1);
  });

  it("two checks that each hold a rule the other needs do not wait for each other", async () => {
    const { instance } = rules();
    await instance.hold("probe:1:1", "https://one.example/a.mp4", "https://a.example/");
    await instance.hold("probe:2:1", "https://two.example/b.mp4", "https://b.example/");
    // Each asks for the other's host, as a redirected file does. Both settle.
    await Promise.all([
      instance.hold("probe:1:1", "https://two.example/a.mp4", "https://a.example/"),
      instance.hold("probe:2:1", "https://one.example/b.mp4", "https://b.example/"),
    ]);
    expect(instance.records().map(record => record.referer).sort()).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("a check never waits for a running save: it goes out with the save's rule as it is", async () => {
    const { instance, updateSessionRules } = rules();
    await instance.hold("stream-1", "https://cdn.shared.example/a/seg1.ts", "https://a.example/watch");
    await instance.hold("probe:2:1", "https://cdn.shared.example/b.mp4", "https://b.example/watch");
    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    expect(instance.records()).toEqual([{ id: 1, host: "cdn.shared.example", referer: "https://a.example/", holders: ["stream-1"] }]);
  });

  it("gives one save a bounded number of held rules, and all saves together a bounded number", async () => {
    const { instance } = rules();
    // A playlist that spreads its segments over hundreds of hosts.
    for (let index = 0; index < MAX_HOLDER_RULES + 40; index++) await instance.hold("stream-wide", `https://s${index}.cdn.example/seg.ts`, "https://a.example/");
    const held = () => instance.records().filter(record => record.holders.length > 0);
    expect(held()).toHaveLength(MAX_HOLDER_RULES);
    // The hosts beyond the save's share got their rule as a one-off request does, within the idle limit.
    expect(instance.records().length).toBeLessThanOrEqual(MAX_HOLDER_RULES + MAX_IDLE_RULES);
    const jobs = Math.ceil(MAX_HELD_RULES / MAX_HOLDER_RULES) + 2;
    for (let job = 0; job < jobs; job++) {
      for (let index = 0; index < MAX_HOLDER_RULES; index++) await instance.hold(`stream-${job}`, `https://j${job}-${index}.cdn.example/seg.ts`, "https://a.example/");
    }
    expect(held().length).toBeLessThanOrEqual(MAX_HELD_RULES);
    expect(instance.records().length).toBeLessThanOrEqual(MAX_HELD_RULES + MAX_IDLE_RULES);
    // A save that ends frees its share for the next one.
    instance.release("stream-wide");
    await instance.hold("stream-next", "https://next.cdn.example/seg.ts", "https://a.example/");
    expect(instance.records().find(record => record.host === "next.cdn.example")!.holders).toEqual(["stream-next"]);
  });
});
