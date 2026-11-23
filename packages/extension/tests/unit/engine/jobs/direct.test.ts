// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDirectJob, type DirectJobOptions } from "../../../../src/engine/jobs/direct";
import { noWaits } from "../../helpers/waits";
import type { TransferProgress } from "../../../../src/engine/job";

const fixture = new Uint8Array(readFileSync(new URL("../../../e2e/media-fixtures/direct/clip.mp4", import.meta.url)));
const mov = new Uint8Array(readFileSync(new URL("../../../e2e/media-fixtures/direct/test-pattern.mov", import.meta.url)));
const plan = { kind: "direct" as const, url: "https://cdn.example/clip.mp4", filename: "clip.mp4" };
const CHUNK = 4 * 1024 * 1024;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function job(tabId: number, fetchFile?: DirectJobOptions["fetchFile"], extra: Partial<DirectJobOptions> = {}): DirectJobOptions {
  return { onProgress: vi.fn(), signal: new AbortController().signal, tabId, ...(fetchFile ? { fetchFile } : {}), ...extra };
}

function stages(progress: ReturnType<typeof vi.fn>): TransferProgress["stage"][] {
  return progress.mock.calls.map(([event]) => (event as TransferProgress).stage);
}


describe("direct download recovery", () => {
  it("treats query parameters as part of the address, never as a download policy", async () => {
    const url = new URL(plan.url);
    url.searchParams.set("response_limit", "8192");
    url.searchParams.set("tags", `action:limited_view,size:${fixture.length}`);
    const fetchFile = vi.fn<typeof fetch>(async () => new Response(fixture));
    const result = await runDirectJob({...plan, url: url.href}, job(89, fetchFile));
    try {
      expect(fetchFile).toHaveBeenCalledTimes(1);
      const [address, options] = fetchFile.mock.calls[0]!;
      expect(address).toBe(url.href);
      expect(new Headers(options?.headers).get("range")).toBe("bytes=0-4095");
      expect(result.filename).toBe(plan.filename);
      expect(new Uint8Array(await (await fetchOriginal(result.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  describe("a page or data document in place of the file", () => {
    for (const [response, body, type] of [
      ["page", '<?xml version="1.0"?><html><body>Network access warning</body></html>', "video/quicktime"],
      ["data", JSON.stringify({ message: "Preparing the file" }).padEnd(69), "video/quicktime"],
    ] as const) {
      it.each([false, true])(`is refused as ${response} before any length check, kept nowhere (declares its length=%s)`, async declared => {
        const requests: (string | null)[] = [];
        const onRetained = vi.fn();
        const fetchFile = async (_url: string, init: RequestInit) => {
          const range = new Headers(init.headers).get("range");
          requests.push(range);
          // A valid discovery range without a validator: the save asks for the whole file.
          if (range) return new Response(mov.slice(0, 4096), { status: 206, headers: { "content-type": "video/quicktime",
            "content-range": `bytes 0-4095/${mov.length}` } });
          return new Response(body, { headers: { "content-type": type, ...(declared ? { "content-length": String(body.length) } : {}) } });
        };
        await expect(runDirectJob({ ...plan, url: "https://cdn.example/file.mov" }, job(70, fetchFile, { onRetained })))
          .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response });
        expect(requests).toEqual(["bytes=0-4095", null]);
        expect(onRetained).not.toHaveBeenCalled();
        // Retry save starts from byte zero: nothing of the document was kept.
        const fresh = vi.fn(async (_url: string, init: RequestInit) => {
          expect(new Headers(init.headers).get("range")).toBe("bytes=0-4095");
          return new Response(mov);
        });
        const saved = await runDirectJob({ ...plan, url: "https://cdn.example/file.mov" }, job(70, fresh));
        URL.revokeObjectURL(saved.blobUrl);
        expect(fresh).toHaveBeenCalledTimes(1);
      });
    }

    it("never keeps media-looking bytes too few to identify", async () => {
      const onRetained = vi.fn();
      const fetchFile = vi.fn(async () => new Response(fixture.slice(0, 10), { headers: { "content-length": String(fixture.length), etag: '"v1"' } }));
      await expect(runDirectJob(plan, job(71, fetchFile, { onRetained })))
        .rejects.toEqual({ code: "transfer_failed", severity: "terminal", reason: "ended-early", host: "cdn.example",
          receivedBytes: 10, totalBytes: fixture.length, httpStatus: null });
      expect(fetchFile).toHaveBeenCalledTimes(1);
      expect(onRetained).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("verifies a broken HTTP 200 prefix using a later ETag, and reads a changed file once from byte zero (changed=%s)", async changed => {
    const cut = 58013;
    const prefix = fixture.slice(0, cut);
    if (changed) prefix[17000] = prefix[17000]! ^ 1;
    const requests: string[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, fixture.length);
      const range = headers.get("range")!;
      requests.push(range);
      if (requests.length === 1) return new Response(prefix, {headers: {"content-length": String(fixture.length)}});
      expect(headers.get("if-range")).toBe(requests.length === 2 || range === "bytes=0-4095" ? null : '"fixture-v1"');
      return rangedResponse(fixture, start, end);
    };
    const options = job(49, fetchFile);
    const saved = await runDirectJob(plan, options);
    try {
      const checking = ["bytes=0-4095", `bytes=${cut}-${cut}`, `bytes=0-${cut - 1}`];
      expect(requests).toEqual(changed
        ? [...checking, "bytes=0-4095", `bytes=0-${fixture.length - 1}`]
        : [...checking, `bytes=${cut + 1}-${fixture.length - 1}`]);
      expect(stages(vi.mocked(options.onProgress)).filter(stage => stage.kind === "restarting"))
        .toEqual(changed ? [{ kind: "restarting", cause: "retained-rejected" }] : []);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it.each([false, true])("consumes the whole response to a resume request once (original ETag=%s)", async versioned => {
    const cut = 58013;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers).get("range"));
      return new Response(requests.length === 1 ? fixture.slice(0, cut) : fixture, {headers: {
        "content-length": String(fixture.length), ...(versioned ? {etag: '"fixture-v1"'} : {}),
      }});
    };
    const saved = await runDirectJob(plan, job(50, fetchFile));
    try {
      expect(requests).toEqual(["bytes=0-4095", versioned ? `bytes=${cut}-${fixture.length - 1}` : `bytes=${cut}-${cut}`]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it.each([false, true])("checks a digest-only resume before publishing, then reads once from byte zero (corrupt tail=%s)", async corrupt => {
    const digest = createHash("sha256").update(fixture).digest("base64");
    const cut = 58013;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.has("if-range")).toBe(false);
      const range = headers.get("range");
      requests.push(range);
      if (requests.length === 1) return new Response(fixture.slice(0, cut), {headers: {"content-length": String(fixture.length)}});
      const [start, end] = range ? bounds(headers, fixture.length) : [0, fixture.length - 1];
      const bytes = fixture.slice(start, end + 1);
      if (corrupt && end > cut) bytes[end - start] = bytes[end - start]! ^ 1;
      const checksum = {"repr-digest": `sha-256=:${digest}:`};
      return range ? new Response(bytes, {status: 206, headers: {"content-range": `bytes ${start}-${end}/${fixture.length}`,
        ...(start === cut ? checksum : {})}})
        : new Response(bytes, {headers: {"content-length": String(fixture.length), ...checksum}});
    };
    const result = runDirectJob(plan, job(51, fetchFile));
    const resumed = ["bytes=0-4095", `bytes=${cut}-${cut}`, `bytes=${cut + 1}-${fixture.length - 1}`];
    if (corrupt) {
      // The resumed file fails its checksum; the one clean read fails it too, and that is the answer.
      await expect(result).rejects.toMatchObject({code: "verification_checksum", algo: "sha256", expected: digest});
      expect(requests).toEqual([...resumed, "bytes=0-4095", null]);
    } else {
      const saved = await result;
      try { expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture); }
      finally { URL.revokeObjectURL(saved.blobUrl); }
      expect(requests).toEqual(resumed);
    }
  });

  it.each([false, true])("Retry save continues the furthest HTTP 200 prefix when the named file changes host (different file=%s)", async changed => {
    const waits = noWaits();
    const cut = 58013;
    const furthest = cut + 18;
    const key = "selected-file";
    const tab = changed ? 62 : 61;
    const onRetained = vi.fn();
    const firstRequests: (string | null)[] = [];
    const broken = async (_url: string, init: RequestInit) => {
      firstRequests.push(new Headers(init.headers).get("range"));
      return new Response(fixture.slice(0, firstRequests.length === 1 ? cut : furthest), {headers: {"content-length": String(fixture.length)}});
    };
    // The resume request comes back as HTTP 200 from byte zero and stops early again: the save stops, with the furthest bytes kept.
    await expect(runDirectJob(plan, job(tab, broken, { resumeKey: key, onRetained })))
      .rejects.toEqual({code: "transfer_failed", severity: "terminal", reason: "ended-early", host: "cdn.example",
        receivedBytes: furthest, totalBytes: fixture.length, httpStatus: 200});
    expect(firstRequests).toEqual(["bytes=0-4095", `bytes=${cut}-${cut}`]);
    expect(waits).not.toHaveBeenCalled();
    expect(onRetained).toHaveBeenCalledWith({bytes: furthest, total: fixture.length, expiresAt: expect.any(Number)});

    const next = {...plan, url: "https://another.example/issued-file.mp4"};
    const data = fixture.slice();
    if (changed) data[12000] = data[12000]! ^ 1;
    const requests: (string | null)[] = [];
    const resumed = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const range = headers.get("range");
      requests.push(range);
      const [start, end] = bounds(headers, data.length);
      expect(headers.get("if-range")).toBe(requests.length === 1 || range === "bytes=0-4095" ? null : '"fixture-v1"');
      return rangedResponse(data, start, end);
    };
    const saved = await runDirectJob(next, job(tab, resumed, { resumeKey: key }));
    try {
      const checking = [`bytes=${furthest}-${furthest}`, `bytes=0-${furthest - 1}`];
      // A different file rejects the kept bytes and is read once from byte zero.
      expect(requests).toEqual(changed ? [...checking, "bytes=0-4095", `bytes=0-${data.length - 1}`]
        : [...checking, `bytes=${furthest + 1}-${fixture.length - 1}`]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(data);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  describe("a short body the server does not let continue", () => {
    it.each([
      ["refuses the range", (_cut: number) => new Response(null, {status: 416, headers: {"content-range": `bytes */${fixture.length}`}}),
        "resume-refused", 416],
      ["grants a range without any validator", (cut: number) => new Response(fixture.slice(cut, cut + 1), {status: 206,
        headers: {"content-range": `bytes ${cut}-${cut}/${fixture.length}`}}), "resume-unverifiable", 206],
    ] as const)("stops plainly when the server %s, keeps nothing Retry save could not use, and never loops", async (_name, answer, reason, httpStatus) => {
      const waits = noWaits();
      const cut = 58013;
      const requests: (string | null)[] = [];
      const onRetained = vi.fn();
      const file = async (_url: string, init: RequestInit) => {
        const range = new Headers(init.headers).get("range");
        requests.push(range);
        if (range === "bytes=0-4095") return new Response(fixture.slice(0, cut), {headers: {"content-length": String(fixture.length)}});
        return answer(cut);
      };
      await expect(runDirectJob(plan, job(65, file, { onRetained }))).rejects.toEqual({ code: "transfer_failed", severity: "terminal",
        reason, host: "cdn.example", receivedBytes: cut, totalBytes: fixture.length, httpStatus });
      expect(requests).toEqual(["bytes=0-4095", `bytes=${cut}-${cut}`]);
      expect(waits).not.toHaveBeenCalled();
      // Retry save could not continue from those bytes, so no message promises them.
      expect(onRetained).not.toHaveBeenCalled();

      // Retry save reads the file from byte zero.
      requests.length = 0;
      const retried = async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const range = headers.get("range");
        requests.push(range);
        if (range === `bytes=${cut}-${cut}`) return answer(cut);
        const [start, end] = bounds(headers, fixture.length);
        return rangedResponse(fixture, start, end);
      };
      const saved = await runDirectJob(plan, job(65, retried));
      try {
        expect(requests).toEqual(["bytes=0-4095", `bytes=0-${fixture.length - 1}`]);
        expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
      } finally { URL.revokeObjectURL(saved.blobUrl); }
    });

    it("asks once for the first missing byte even when the server advertised no ranges, and continues when it grants it", async () => {
      const waits = noWaits();
      const cut = 58013;
      const options = job(63, vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        if (headers.get("range") === "bytes=0-4095") return new Response(fixture.slice(0, cut), {headers: {
          "content-length": String(fixture.length), etag: '"fixture-v1"', "accept-ranges": "none",
        }});
        expect(headers.get("range")).toBe(`bytes=${cut}-${fixture.length - 1}`);
        expect(headers.get("if-range")).toBe('"fixture-v1"');
        return rangedResponse(fixture, cut, fixture.length - 1);
      }));
      const saved = await runDirectJob(plan, options);
      try {
        expect(options.fetchFile).toHaveBeenCalledTimes(2);
        expect(waits).not.toHaveBeenCalled();
        expect(stages(vi.mocked(options.onProgress))).toContainEqual({ kind: "resuming" });
        expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
      } finally { URL.revokeObjectURL(saved.blobUrl); }
    });
  });

  it("stops plainly when the server refuses the range a validated response needs, keeps nothing, and Retry save starts from byte zero", async () => {
    const cut = 58013;
    const requests: (string | null)[] = [];
    const onRetained = vi.fn();
    const refused = () => new Response(null, {status: 416, headers: {"content-range": `bytes */${fixture.length}`}});
    const fetchFile = async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("range");
      requests.push(range);
      if (range) return refused();
      return new Response(breakingBody(fixture, cut), {headers: {"content-length": String(fixture.length), etag: '"v1"'}});
    };
    await expect(runDirectJob(plan, job(73, fetchFile, { onRetained }))).rejects.toEqual({ code: "transfer_failed", severity: "terminal",
      reason: "resume-refused", host: "cdn.example", receivedBytes: cut, totalBytes: fixture.length, httpStatus: 416 });
    expect(requests).toEqual(["bytes=0-4095", null, `bytes=${cut}-${fixture.length - 1}`]);
    expect(onRetained).not.toHaveBeenCalled();

    requests.length = 0;
    const retried = async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("range");
      requests.push(range);
      return range ? refused() : new Response(fixture, {headers: {"content-length": String(fixture.length), etag: '"v1"'}});
    };
    const saved = await runDirectJob(plan, job(73, retried));
    try {
      expect(requests).toEqual(["bytes=0-4095", null]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it.each([false, true])("treats a connection that drops while a server replays the whole file as an outage, never as an early end (recovers=%s)", async recovers => {
    noWaits();
    const requests: (string | null)[] = [];
    // The server ignores Range and states no validator. Its first body drops after 50,000 bytes, and each replay after 30,000.
    const fetchFile = async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers).get("range"));
      if (recovers && requests.length === 5) return new Response(fixture, {headers: {"content-length": String(fixture.length)}});
      return new Response(breakingBody(fixture, requests.length === 1 ? 50_000 : 30_000), {headers: {"content-length": String(fixture.length)}});
    };
    const options = job(74, fetchFile);
    const reconnects = () => stages(vi.mocked(options.onProgress)).filter(stage => stage.kind === "reconnecting");
    if (recovers) {
      const saved = await runDirectJob(plan, options);
      try { expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture); }
      finally { URL.revokeObjectURL(saved.blobUrl); }
      expect(reconnects()).toEqual([{ kind: "reconnecting", waitMs: 1000 }]);
    } else {
      await expect(runDirectJob(plan, options)).rejects.toEqual({ code: "network_unreachable", severity: "terminal", phase: "direct",
        url: "https://cdn.example", during: "transfer", receivedBytes: 50_000, totalBytes: fixture.length });
      expect(reconnects()).toHaveLength(5);
    }
    expect(requests.slice(1).every(range => range === "bytes=50000-50000")).toBe(true);
  });

  it.each([
    ["an ETag behind a redirect", { etag: '"v1"' }, "https://edge.cdn2.example/file.mp4?sig=abc"],
    ["only a Last-Modified date", { "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" }, undefined],
  ] as const)("continues after an outage within the job without reading the parts it holds again (%s)", async (_name, validator, redirect) => {
    noWaits();
    const data = bigFile(3);
    const missing = `bytes=${2 * CHUNK}-${3 * CHUNK - 1}`;
    let outage = 0;
    const requests: string[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, data.length);
      requests.push(headers.get("range")!);
      if (headers.has("if-range") && start === 2 * CHUNK && outage++ < 12) throw new TypeError("Failed to fetch");
      const response = new Response(data.slice(start, end + 1), { status: 206, headers: { "content-type": "video/mp4",
        "content-range": `bytes ${start}-${end}/${data.length}`, ...validator } });
      if (redirect) Object.defineProperty(response, "url", { value: redirect });
      return response;
    };
    const options = job(75, fetchFile);
    const saved = await runDirectJob(plan, options);
    try {
      expect(createHash("sha256").update(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).digest("hex"))
        .toBe(createHash("sha256").update(data).digest("hex"));
    } finally { URL.revokeObjectURL(saved.blobUrl); }
    expect(stages(vi.mocked(options.onProgress))).toContainEqual({ kind: "reconnecting", waitMs: 1000 });
    // The probe and the first two parts once each; every later request is for the missing part.
    expect(requests.slice(0, 3).sort()).toEqual(["bytes=0-4095", `bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${2 * CHUNK - 1}`].sort());
    expect(requests.slice(3).every(range => range === missing)).toBe(true);
    expect(requests.filter(range => range === missing)).toHaveLength(13);
  });

  it("reads a 200 that states a whole-file Content-Range as the file, and still names a page sent that way", async () => {
    const whole = { "content-range": `bytes 0-${fixture.length - 1}/${fixture.length}`, "content-length": String(fixture.length) };
    const saved = await runDirectJob(plan, job(76, async () => new Response(fixture, { headers: whole })));
    try { expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture); }
    finally { URL.revokeObjectURL(saved.blobUrl); }
    const page = "<html><body>Network access warning</body></html>";
    await expect(runDirectJob(plan, job(76, async () => new Response(page, { headers: { "content-range": "bytes 0-99/5000" } }))))
      .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page" });
  });

  it("reads the current file in place when a range request under the old ETag is answered with the whole new file", async () => {
    const cut = 58013;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push(headers.get("range"));
      if (requests.length === 1) return new Response(breakingBody(fixture, cut), {headers: {"content-length": String(fixture.length), etag: '"v1"'}});
      // If-Range names v1; the server has v2 now and sends it whole (RFC 9110 13.1.5).
      expect(headers.get("if-range")).toBe('"v1"');
      return new Response(mov, {headers: {"content-length": String(mov.length), etag: '"v2"'}});
    };
    const options = job(77, fetchFile);
    const saved = await runDirectJob(plan, options);
    try {
      expect(requests).toEqual(["bytes=0-4095", `bytes=${cut}-${fixture.length - 1}`]);
      expect(stages(vi.mocked(options.onProgress)).filter(stage => stage.kind === "restarting"))
        .toEqual([{ kind: "restarting", cause: "retained-rejected" }]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(mov);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it("saves the new version when the ETag changes between parts and the server then sends the file whole", async () => {
    const v1 = bigFile(3);
    const v2 = bigFile(3);
    v2[CHUNK + 5] = 1;
    let ranges = 0;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push(headers.get("range"));
      if (!headers.has("range")) return new Response(v2 as BodyInit, {headers: {"content-length": String(v2.length), etag: '"v2"'}});
      const [start, end] = bounds(headers, v1.length);
      if (headers.has("if-range") && ++ranges > 2) return new Response(v2 as BodyInit, {headers: {"content-length": String(v2.length), etag: '"v2"'}});
      return new Response(v1.slice(start, end + 1), {status: 206, headers: {"content-range": `bytes ${start}-${end}/${v1.length}`, etag: '"v1"'}});
    };
    const saved = await runDirectJob(plan, job(81, fetchFile));
    try {
      expect(createHash("sha256").update(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).digest("hex"))
        .toBe(createHash("sha256").update(v2).digest("hex"));
      expect(requests.at(-1)).toBeNull();
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it("keeps one failed save's bytes until a later failed save takes the slot, then tells the first", async () => {
    noWaits();
    const cut = 58013;
    const shortPart = (end: number) => new Response(fixture.slice(0, cut), {status: 206, headers: {
      "content-range": `bytes 0-${end}/${fixture.length}`, etag: '"fixture-v1"'}});
    const keepsCut = (tab: number, extra: Partial<DirectJobOptions>) => runDirectJob(plan, job(tab, async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, fixture.length);
      if (!headers.has("if-range")) return rangedResponse(fixture, start, end);
      if (start === 0) return shortPart(end);
      return new Response(null, {status: 503, headers: {"retry-after": "90"}});
    }, extra));
    const kept = vi.fn();
    const released = vi.fn();
    await expect(keepsCut(78, { onRetained: kept, onRetainedReleased: released })).rejects.toMatchObject({code: "server_busy"});
    expect(kept).toHaveBeenCalledOnce();

    // A save that recovers from an outage within its job holds its bytes itself: the first save keeps its slot.
    let drops = 0;
    const recovered = await runDirectJob(plan, job(79, async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, fixture.length);
      if (!headers.has("if-range")) return rangedResponse(fixture, start, end);
      if (start === 0) return shortPart(end);
      if (drops++ < 12) throw new TypeError("Failed to fetch");
      return rangedResponse(fixture, start, end);
    }));
    URL.revokeObjectURL(recovered.blobUrl);
    expect(released).not.toHaveBeenCalled();

    // A later failure that keeps bytes takes the slot, and the first save is told its bytes are gone.
    await expect(keepsCut(80, {})).rejects.toMatchObject({code: "server_busy"});
    expect(released).toHaveBeenCalledOnce();
  });

  it("reconnects after a network outage while bytes are kept, and cancelling the wait clears them", async () => {
    noWaits();
    const cut = 58013;
    const controller = new AbortController();
    const outage = vi.fn(async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).get("range") === "bytes=0-4095") {
        return new Response(fixture.slice(0, cut), {headers: {"content-length": String(fixture.length), etag: '"fixture-v1"'}});
      }
      throw new TypeError("Failed to fetch");
    });
    const onProgress = vi.fn(({stage}: TransferProgress) => {
      if (stage.kind === "reconnecting") queueMicrotask(() => controller.abort());
    });
    await expect(runDirectJob(plan, { onProgress, signal: controller.signal, tabId: 66, fetchFile: outage })).rejects.toMatchObject({name: "AbortError"});
    // One part request and its eleven retries, then the reconnect wait, cancelled.
    expect(outage).toHaveBeenCalledTimes(13);
    expect(stages(onProgress)).toContainEqual({ kind: "reconnecting", waitMs: 1000 });
    const fresh = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("range")).toBe("bytes=0-4095");
      return new Response(fixture);
    });
    const saved = await runDirectJob(plan, job(66, fresh));
    URL.revokeObjectURL(saved.blobUrl);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it.each(["closed", "read error"])("resumes a broken complete-file fallback from its first missing byte (%s)", async how => {
    const cut = 58013;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const range = headers.get("range");
      requests.push(range);
      if (range === "bytes=0-4095") return new Response(null, {status: 206, headers: {
        "content-range": `bytes 0-4095/${fixture.length}`, "content-length": String(fixture.length), etag: '"fixture-v1"',
      }});
      if (!range) {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) { sent = true; controller.enqueue(fixture.slice(0, cut)); }
            else if (how === "closed") controller.close();
            else controller.error(new TypeError("Connection lost"));
          },
        }, {highWaterMark: 0});
        return new Response(body, {headers: {"content-length": String(fixture.length), etag: '"fixture-v1"'}});
      }
      expect(headers.get("if-range")).toBe('"fixture-v1"');
      const [start, end] = bounds(headers, fixture.length);
      return rangedResponse(fixture, start, end);
    };
    const saved = await runDirectJob(plan, job(48, fetchFile));
    try {
      expect(requests).toEqual(["bytes=0-4095", null, `bytes=${cut}-${fixture.length - 1}`]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it.each(["probe", "part"])("switches to a verified whole file after contradictory lengths during the %s", async stage => {
    noWaits();
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const range = headers.get("range");
      requests.push(range);
      if (!range) return new Response(fixture, {headers: {etag: '"fixture-v1"'}});
      const [start, end] = bounds(headers, fixture.length);
      const response = rangedResponse(fixture, start, end);
      if ((stage === "part") !== headers.has("if-range")) return response;
      response.headers.set("content-length", String(fixture.length + 1));
      return new Response(Uint8Array.of(255), {status: 206, headers: response.headers});
    };
    const result = await runDirectJob(plan, job(45, fetchFile));
    try {
      expect(new Uint8Array(await (await fetchOriginal(result.blobUrl)).arrayBuffer())).toEqual(fixture);
      const part = `bytes=0-${fixture.length - 1}`;
      expect(requests).toEqual(["bytes=0-4095", ...(stage === "part" ? [part, part] : []), null]);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  it("retries a contradictory tail at the first missing byte and keeps the file prefix", async () => {
    noWaits();
    const cut = 58013;
    const tail = `bytes=${cut}-${fixture.length - 1}`;
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push(headers.get("range"));
      if (requests.length === 1) return new Response(fixture.slice(0, cut), {
        headers: {"content-type": "video/mp4", "content-length": String(fixture.length), etag: '"fixture-v1"'},
      });
      expect(headers.get("if-range")).toBe('"fixture-v1"');
      const [start, end] = bounds(headers, fixture.length);
      const response = rangedResponse(fixture, start, end);
      if (requests.length === 2) {
        response.headers.set("content-length", String(fixture.length));
        return new Response(Uint8Array.of(255), {status: 206, headers: response.headers});
      }
      return response;
    };
    const saved = await runDirectJob(plan, job(47, fetchFile));
    try {
      expect(requests).toEqual(["bytes=0-4095", tail, tail]);
      expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it("saves a complete-file response under a newer ETag: it reuses no earlier byte, so it is the current file", async () => {
    const fetchFile = async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).has("range")) return new Response(null, {status: 206, headers: {
        "content-range": `bytes 0-4095/${fixture.length}`, "content-length": "4096, 9", etag: '"v1"',
      }});
      return new Response(fixture, {headers: {etag: '"v2"'}});
    };
    const saved = await runDirectJob(plan, job(46, fetchFile));
    try { expect(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).toEqual(fixture); }
    finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it("refuses a complete-file response of the same version with an extra byte", async () => {
    const fetchFile = async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).has("range")) return new Response(null, {status: 206, headers: {
        "content-range": `bytes 0-4095/${fixture.length}`, "content-length": "4096, 9", etag: '"v1"',
      }});
      return new Response(new Blob([fixture, Uint8Array.of(0)]), {headers: {etag: '"v1"'}});
    };
    await expect(runDirectJob(plan, job(46, fetchFile)))
      .rejects.toMatchObject({code: "transfer_failed", reason: "body-long", host: "cdn.example"});
  });

  it("retries a truncated range and saves exactly the original bytes", async () => {
    noWaits();
    let attempts = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const range = headers.get("range") ?? "";
      requests.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return new Response("full requests fail", { status: 503 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), fixture.length - 1);
      let bytes = fixture.slice(start, end + 1);
      if (headers.has("if-range")) {
        expect(headers.get("if-range")).toBe('"fixture-v1"');
        if (++attempts === 1) bytes = bytes.slice(0, Math.floor(bytes.length / 2));
      }
      return new Response(bytes, { status: 206, headers: {
        "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${fixture.length}`,
        etag: '"fixture-v1"',
      } });
    }));
    const options = job(0);
    const result = await runDirectJob(plan, options);
    try {
      const saved = await (await fetchOriginal(result.blobUrl)).arrayBuffer();
      expect(new Uint8Array(saved)).toEqual(fixture);
      expect(attempts).toBe(2);
      expect(stages(vi.mocked(options.onProgress))).toContainEqual(expect.objectContaining({ kind: "retrying", part: { index: 1, count: 1 } }));
      expect(requests[0]).toBe("bytes=0-4095");
      expect(requests.slice(1)).toEqual([`bytes=0-${fixture.length - 1}`, `bytes=${Math.floor(fixture.length / 2)}-${fixture.length - 1}`]);
      expect(options.onProgress).toHaveBeenLastCalledWith({ stage: { kind: "finalizing" }, bytesWritten: fixture.length, bytesTotal: fixture.length });
    } finally {
      URL.revokeObjectURL(result.blobUrl);
    }
  });

  it("continues a broken whole response from its first missing byte", async () => {
    const cut = 58013;
    const requests: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      requests.push(headers.get("range")!);
      if (!headers.has("if-range")) return new Response(fixture.slice(0, cut), {
        headers: {"content-type": "video/mp4", "content-length": String(fixture.length), etag: '"fixture-v1"'},
      });
      const [start, end] = bounds(headers, fixture.length);
      return rangedResponse(fixture, start, end);
    });
    const result = await runDirectJob(plan, job(9, fetchFn));
    try {
      expect(requests).toEqual(["bytes=0-4095", `bytes=${cut}-${fixture.length - 1}`]);
      expect(new Uint8Array(await (await fetchOriginal(result.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  it.each([false, true])("confirms a matched range that supplies zero bytes once with a short range, then stops (declared=%s)", async declared => {
    const waits = noWaits();
    const cut = 8192;
    const total = 256 * 1024;
    let wholeRequests = 0;
    const ranges: string[] = [];
    const headers = {"content-length": String(total), etag: '"fixture-v1"'};
    const file = async (_url: string, init: RequestInit) => {
      const request = new Headers(init.headers);
      const range = request.get("range");
      if (!range || range === "bytes=0-4095") {
        if (!range) wholeRequests++;
        return new Response(fixture.slice(0, cut), {headers});
      }
      expect(request.get("if-range")).toBe(headers.etag);
      ranges.push(range);
      return new Response(new Uint8Array(), {status: 206, headers: {
        "content-range": `bytes ${range.slice(6)}/${total}`, etag: headers.etag, ...(declared ? {"content-length": "0"} : {}),
      }});
    };
    const options = job(declared ? 67 : 66, file);
    await expect(runDirectJob(plan, options))
      .rejects.toEqual({code: "range_body_empty", severity: "terminal", host: "cdn.example", reconnects: 0, rangeStart: cut,
        rangeEnd: cut + 65535, declaredBytes: declared ? 0 : null, totalBytes: total, reason: declared ? "declared-empty" : "stream-ended"});
    expect(wholeRequests).toBe(0);
    expect(ranges).toEqual([`bytes=${cut}-${total - 1}`, `bytes=${cut}-${cut + 65536 - 1}`]);
    expect(stages(vi.mocked(options.onProgress))).toContainEqual(expect.objectContaining({ kind: "retrying", part: { index: 1, count: 1 } }));
    expect(waits.mock.calls.map(([ms]) => ms)).toEqual([150]);
  });

  it("Retry save can finish a partial range while all byte-zero requests still return 503", async () => {
    noWaits();
    const cut = 58013;
    let retry = false;
    const requests: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, fixture.length);
      requests.push(start);
      if (!retry && !headers.has("if-range")) return rangedResponse(fixture, start, end);
      if (!retry && !start) return new Response(fixture.slice(0, cut), {status: 206, headers: {
        "content-range": `bytes 0-${end}/${fixture.length}`, etag: '"fixture-v1"'}});
      if (retry && start === cut) return rangedResponse(fixture, start, end);
      return new Response(null, {status: 503, headers: {"retry-after": "90"}});
    });
    const onRetained = vi.fn();
    await expect(runDirectJob(plan, job(10, fetchFn, { onRetained }))).rejects.toMatchObject({code: "server_busy", httpStatus: 503});
    expect(onRetained).toHaveBeenCalledWith({bytes: cut, total: fixture.length, expiresAt: expect.any(Number)});
    retry = true;
    requests.length = 0;
    const result = await runDirectJob(plan, job(10, fetchFn));
    try {
      expect(requests).toEqual([cut]);
      expect(new Uint8Array(await (await fetchOriginal(result.blobUrl)).arrayBuffer())).toEqual(fixture);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  describe("a resumed file that fails verification", () => {
    // Version A and B have the same length and, through a server fault, the
    // same ETag. Their boxes sit at different offsets, so A's first part
    // followed by B's second part is no valid MP4, while B alone is.
    const total = CHUNK + 64 * 1024;
    function version(boundary: number, fill: number): Uint8Array {
      const data = new Uint8Array(total).fill(fill);
      data.set(fixture);
      const view = new DataView(data.buffer);
      view.setUint32(fixture.length, boundary - fixture.length);
      data.set(new TextEncoder().encode("free"), fixture.length + 4);
      view.setUint32(boundary, total - boundary);
      data.set(new TextEncoder().encode("free"), boundary + 4);
      return data;
    }
    const a = version(CHUNK + 1024, 0);
    const b = version(CHUNK + 4096, 0xff);

    it.each([false, true])("is read once more from byte zero, and a second failure is the answer (second also broken=%s)", async broken => {
      let current = a;
      let first = true;
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const [start, end] = bounds(headers, total);
        requests.push(headers.get("range")!);
        // The first save gets part one, then a busy server with a long wait.
        if (first && headers.has("if-range") && start >= CHUNK) return new Response(null, {status: 503, headers: {"retry-after": "60"}});
        return rangedResponse(current, start, end);
      });
      await expect(runDirectJob(plan, job(72))).rejects.toMatchObject({code: "server_busy"});
      first = false;
      current = broken ? new Uint8Array(b).fill(0xff, CHUNK) : b;
      requests.length = 0;
      const options = job(72);
      const result = runDirectJob(plan, options);
      if (broken) {
        await expect(result).rejects.toMatchObject({code: "verification_container"});
      } else {
        const saved = await result;
        try {
          expect(createHash("sha256").update(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).digest("hex"))
            .toBe(createHash("sha256").update(b).digest("hex"));
        } finally { URL.revokeObjectURL(saved.blobUrl); }
      }
      // The kept part, the rejected assembly, then exactly one clean read: probe and both parts.
      expect(requests.slice(0, 2)).toEqual([`bytes=${CHUNK}-${total - 1}`, "bytes=0-4095"]);
      expect(requests.slice(2).sort()).toEqual([`bytes=${CHUNK}-${total - 1}`, `bytes=0-${CHUNK - 1}`].sort());
      expect(stages(vi.mocked(options.onProgress)).filter(stage => stage.kind === "restarting"))
        .toEqual([{ kind: "restarting", cause: "retained-rejected" }]);
    });
  });

  it("assembles concurrent ranges in file order when later chunks finish first", async () => {
    const data = new Uint8Array(fixture.length + 5 * 1024 * 1024);
    data.set(fixture);
    const view = new DataView(data.buffer);
    view.setUint32(fixture.length, data.length - fixture.length);
    data.set(new TextEncoder().encode("free"), fixture.length + 4);
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const completed: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, data.length);
      if (headers.has("if-range")) {
        if (start === 0) await first;
        else releaseFirst();
        completed.push(start);
      }
      return rangedResponse(data, start, end);
    }));
    const result = await runDirectJob(plan, job(0));
    try {
      const saved = await (await fetchOriginal(result.blobUrl)).arrayBuffer();
      expect(saved.byteLength).toBe(data.length);
      expect(createHash("sha256").update(new Uint8Array(saved)).digest("hex"))
        .toBe(createHash("sha256").update(data).digest("hex"));
      expect(completed).toEqual([4 * 1024 * 1024, 0]);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  it("drops new parts to one connection on a busy origin and adds connections back only as parts started since then complete", async () => {
    noWaits();
    const data = bigFile(10);
    let inFlight = 0;
    let busy = 3;
    const started = new Map<number, number>();
    const others: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, data.length);
      if (!headers.has("if-range")) return rangedResponse(data, start, end);
      // Part 0 is answered "busy" three times while the parts beside it run.
      if (start === 0 && busy > 0) {
        busy--;
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(null, {status: 503});
      }
      if (start !== 0 && busy > 0) others.push(start / CHUNK);
      started.set(start / CHUNK, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return rangedResponse(data, start, end);
    }));
    const result = await runDirectJob(plan, job(0));
    try {
      expect(createHash("sha256").update(new Uint8Array(await (await fetchOriginal(result.blobUrl)).arrayBuffer())).digest("hex"))
        .toBe(createHash("sha256").update(data).digest("hex"));
    } finally { URL.revokeObjectURL(result.blobUrl); }
    // Only the parts already running beside the busy part were sent while it
    // was busy: no new part started after its first 503.
    expect(others.sort()).toEqual([1, 2, 3]);
    // The first part started after that ran alone, then connections came back.
    expect(started.get(4)).toBe(1);
    expect(Math.max(...[5, 6, 7, 8, 9].map(part => started.get(part) ?? 0))).toBeGreaterThan(1);
  });

  it.each([false, true])("retries a late 503 using completed ranges only when the strong ETag matches (changed=%s)", async changed => {
    const data = new Uint8Array(CHUNK + fixture.length);
    data.set(fixture);
    new DataView(data.buffer).setUint32(fixture.length, CHUNK);
    data.set(new TextEncoder().encode("free"), fixture.length + 4);
    let firstAttempt = true;
    let receivedFirst!: () => void;
    const ready = new Promise<void>(resolve => { receivedFirst = resolve; });
    const requested: number[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, data.length);
      if (headers.has("if-range")) {
        requested.push(start);
        if (firstAttempt && start !== 0) {
          await ready;
          return new Response(null, { status: 503, headers: { "Retry-After": "60" } });
        }
      }
      const response = rangedResponse(data, start, end);
      if (!firstAttempt && changed) response.headers.set("etag", '"fixture-v2"');
      return response;
    });
    const onProgress = ({ bytesWritten }: TransferProgress) => { if (bytesWritten === CHUNK) receivedFirst(); };
    await expect(runDirectJob(plan, { onProgress, signal: new AbortController().signal, tabId: 7 }))
      .rejects.toMatchObject({code: "server_busy", httpStatus: 503});
    expect(requested.sort((a, b) => a - b)).toEqual([0, CHUNK]);
    firstAttempt = false;
    requested.length = 0;
    if (changed) data[fixture.length + 8] = 37;
    const saved = await runDirectJob(plan, job(7));
    try {
      expect(requested).toEqual(changed ? [CHUNK, 0, CHUNK] : [CHUNK]);
      expect(createHash("sha256").update(Buffer.from(await (await fetchOriginal(saved.blobUrl)).arrayBuffer())).digest("hex"))
        .toBe(createHash("sha256").update(data).digest("hex"));
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it("does not create a saved result for structurally invalid media", async () => {
    const data = fixture.slice();
    new DataView(data.buffer).setUint32(0, data.length + 100);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const [start, end] = bounds(new Headers(init.headers), data.length);
      return rangedResponse(data, start, end);
    }));
    await expect(runDirectJob(plan, job(0)))
      .rejects.toMatchObject({ code: "verification_container" });
  });

  it("aborts and joins sibling requests after a terminal range failure", async () => {
    let siblingsStopped = 0;
    let chunksStarted = 0;
    let allStarted!: () => void;
    const ready = new Promise<void>(resolve => { allStarted = resolve; });
    const total = 12 * 1024 * 1024;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (!headers.has("if-range")) return new Response(fixture.slice(0, 4096), { status: 206, headers: {
        "content-range": `bytes 0-4095/${total}`, etag: '"v1"',
      } });
      if (++chunksStarted === 3) allStarted();
      if (headers.get("range")!.startsWith("bytes=0-")) {
        await ready;
        return new Response("forbidden", { status: 403 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          siblingsStopped++;
          reject(init.signal!.reason);
        }, { once: true });
      });
    }));
    await expect(runDirectJob(plan, job(0)))
      .rejects.toMatchObject({ code: "access_denied", httpStatus: 403 });
    expect(siblingsStopped).toBe(2);
  });
});

const fetchOriginal = globalThis.fetch;

function bounds(headers: Headers, size: number): [number, number] {
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
  if (!match) throw new Error("range required");
  return [Number(match[1]), Math.min(Number(match[2]), size - 1)];
}

/** A valid MP4 padded with a free box to `parts` whole chunks. */
function bigFile(parts: number): Uint8Array {
  const data = new Uint8Array(parts * CHUNK);
  data.set(fixture);
  const view = new DataView(data.buffer);
  view.setUint32(fixture.length, data.length - fixture.length);
  data.set(new TextEncoder().encode("free"), fixture.length + 4);
  return data;
}

/** A body that delivers `at` bytes, then fails like a dropped connection. */
function breakingBody(bytes: Uint8Array, at: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes.slice(0, at)); }
      else controller.error(new TypeError("network changed"));
    },
  }, {highWaterMark: 0});
}

function rangedResponse(data: Uint8Array, start: number, end: number): Response {
  return new Response(data.slice(start, end + 1), { status: 206, headers: {
    "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${data.length}`, etag: '"fixture-v1"',
  } });
}

describe("direct download memory", () => {
  /** A body delivered in small pieces, as a network delivers it. */
  function pieces(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
    }, { highWaterMark: 0 });
  }
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  it("saves a whole-file response larger than what it holds as byte arrays, byte for byte", async () => {
    // Five chunks is 20 MiB: more than one fold of the bytes into Blobs.
    const data = bigFile(5);
    const fetchFile = vi.fn(async () => new Response(pieces(data, 64 * 1024), { headers: { "content-type": "video/mp4" } }));
    const saved = await runDirectJob(plan, job(301, fetchFile));
    try {
      expect(fetchFile).toHaveBeenCalledTimes(1);
      expect(sha(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer()))).toBe(sha(data));
    } finally { URL.revokeObjectURL(saved.blobUrl); }
  });

  it.each([false, true])("checks a stated checksum over a file of several windows without reading it whole (wrong checksum=%s)", async wrong => {
    const data = bigFile(3);
    const digest = createHash("sha256").update(wrong ? data.subarray(1) : data).digest("base64");
    const whole = vi.spyOn(crypto.subtle, "digest");
    // A server that ignores Range and states the file's checksum.
    const fetchFile = async () => new Response(pieces(data, 256 * 1024), { headers: { "content-type": "video/mp4",
      "content-length": String(data.length), "repr-digest": `sha-256=:${digest}:` } });
    const run = runDirectJob(plan, job(wrong ? 303 : 302, fetchFile));
    if (wrong) {
      await expect(run).rejects.toMatchObject({ code: "verification_checksum", algo: "sha256" });
    } else {
      const saved = await run;
      try { expect(sha(new Uint8Array(await (await fetchOriginal(saved.blobUrl)).arrayBuffer()))).toBe(sha(data)); }
      finally { URL.revokeObjectURL(saved.blobUrl); }
    }
    // The browser's digest takes one buffer: it is used for short address digests only, never for the file.
    for (const [, input] of whole.mock.calls) expect((input as ArrayBufferView).byteLength).toBeLessThan(4096);
  });
});
