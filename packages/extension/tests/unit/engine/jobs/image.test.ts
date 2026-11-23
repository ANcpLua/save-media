// The image job runs in the engine document, which has a DOMParser: the default (jsdom) environment gives one.
import { describe, expect, it, vi } from "vitest";
import { imageFilename, runImageJob } from "../../../../src/engine/jobs/image";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const signal = () => new AbortController().signal;
const bytesOf = (blob: Blob) => new Promise<Uint8Array>(resolve => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.readAsArrayBuffer(blob);
});
const respond = (body: BodyInit, init: ResponseInit = {}) => vi.fn(async () => new Response(body, init));

describe("the image job", () => {
  it("fetches once, with the user's cookies, and returns a Blob of exactly the verified bytes", async () => {
    const fetchFn = respond(PNG, { headers: { "content-type": "image/png", "content-disposition": "attachment; filename=\"yt-dlp.conf\"" } });
    const result = await runImageJob("https://site.example/pointer/card.png?v=2", signal(), fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("https://site.example/pointer/card.png?v=2", expect.objectContaining({ credentials: "include" }));
    if (result.kind !== "image") throw new Error("expected an image");
    expect(result).toMatchObject({ filename: "card.png", imageType: "png" });
    expect(result.blob.type).toBe("image/png");
    expect(await bytesOf(result.blob)).toEqual(PNG);
  });

  it("names the file itself: the stem of the address, the extension of what the bytes are, never the server's name", () => {
    expect(imageFilename("https://site.example/img/photo.php?id=7", "jpeg")).toBe("photo.jpg");
    expect(imageFilename("https://site.example/img/setup.exe", "png")).toBe("setup.png");
    expect(imageFilename("https://site.example/img/Sommer%20Foto.JPG", "jpeg")).toBe("Sommer Foto.jpg");
    // Path separators hidden in the name never survive into the file name.
    expect(imageFilename("https://site.example/img/..%2F..%2Fevil", "gif")).toBe("image.gif");
    expect(imageFilename("https://site.example/img/a%2Fb%5Cc.png", "png")).toBe("a_b_c.png");
    expect(imageFilename("https://site.example/", "webp")).toBe("image.webp");
    expect(imageFilename("https://site.example/...", "png")).toBe("image.png");
    expect(imageFilename("data:image/png;base64,AAAA", "png")).toBe("image.png");
  });

  it("corrects a wrong extension to the type the bytes are", async () => {
    const result = await runImageJob("https://site.example/a/picture.jpg", signal(), respond(PNG, { headers: { "content-type": "image/jpeg" } }));
    expect(result).toMatchObject({ kind: "image", filename: "picture.png" });
  });

  it.each([
    ["a web page served as image/png", "<!doctype html><html><body>Sign in</body></html>", "page"],
    ["a Windows program served as image/jpeg", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 0x50, 0x45, 0, 0]), "program"],
    ["an archive served as image/webp", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]), "program"],
    ["a script served as image/gif", "window.location = 'https://evil.example'", "data"],
    ["an SVG that carries script", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "data"],
    ["a polyglot that only starts like text", "yt-dlp --exec 'rm -rf ~'", "data"],
    ["bytes of no known kind", new Uint8Array([1, 2, 3, 0, 9, 9, 9, 9]), "unknown"],
  ] as const)("refuses %s", async (_name, body, received) => {
    const result = await runImageJob("https://site.example/pointer/fake.png", signal(), respond(body as BodyInit, { headers: { "content-type": "image/png" } }));
    expect(result).toEqual({ kind: "refused", received });
  });

  it("accepts a plain SVG and a data: image, verified the same way", async () => {
    const svg = await runImageJob("https://site.example/logo", signal(), respond("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\"/></svg>"));
    expect(svg).toMatchObject({ kind: "image", filename: "logo.svg", imageType: "svg" });
    const fetchFn = respond(PNG);
    const data = await runImageJob("data:image/png;base64,iVBORw0KGgo=", signal(), fetchFn);
    expect(data).toMatchObject({ kind: "image", filename: "image.png" });
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]).not.toHaveProperty("credentials");
  });

  it("stops above the size limit and reports it, instead of holding an endless response", async () => {
    await expect(runImageJob("https://site.example/huge.png", signal(), respond(new Uint8Array(4096)), 1024))
      .rejects.toMatchObject({ code: "output_too_large_for_browser", limitBytes: 1024 });
  });

  it("reports a refused request by its status", async () => {
    await expect(runImageJob("https://site.example/gone.png", signal(), respond("gone", { status: 404 })))
      .rejects.toMatchObject({ code: "http_error", httpStatus: 404 });
  });

  it("refuses a disguised program by its first bytes, without downloading the rest of it", async () => {
    let pulled = 0;
    const installer = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new Uint8Array(4096);
        if (pulled++ === 0) chunk.set([0x4d, 0x5a, 0x90, 0x00]);
        controller.enqueue(chunk);
      },
    });
    const result = await runImageJob("https://site.example/pointer/photo.png", signal(), respond(installer, { headers: { "content-type": "image/png" } }));
    expect(result).toEqual({ kind: "refused", received: "program" });
    expect(pulled).toBeLessThan(5);
  });

  it("builds a large image's Blob from the chunks it received", async () => {
    const chunks = [PNG, new Uint8Array(5000).fill(7), new Uint8Array(3000).fill(9)];
    let at = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (at < chunks.length) controller.enqueue(chunks[at++]!); else controller.close(); } });
    const result = await runImageJob("https://site.example/big.png", signal(), respond(body));
    if (result.kind !== "image") throw new Error("expected an image");
    const bytes = await bytesOf(result.blob);
    expect(bytes.byteLength).toBe(PNG.byteLength + 8000);
    expect([...bytes.subarray(0, 8)]).toEqual([...PNG.subarray(0, 8)]);
    expect(bytes.at(-1)).toBe(9);
  });

  it("keeps nothing of an image request that a redirect led from a public page into the user's network", async () => {
    const redirected = vi.fn(async () => Object.defineProperty(new Response(PNG), "url", { value: "https://192.168.1.1/status.png" }));
    await expect(runImageJob("https://cdn.example/go.png", signal(), redirected, undefined, "https://news.example/story"))
      .rejects.toMatchObject({ code: "private_network_target", host: "192.168.1.1" });
    // The same redirect to a server the browser itself was answered from for this tab is that server's image.
    await expect(runImageJob("https://cdn.example/go.png", signal(), redirected, undefined, "https://news.example/story",
      url => new URL(url).origin === "https://192.168.1.1")).resolves.toMatchObject({ kind: "image" });
    // A page on the user's own network may show its own images.
    await expect(runImageJob("https://192.168.1.20/a.png", signal(), redirected, undefined, "https://192.168.1.20/album"))
      .resolves.toMatchObject({ kind: "image" });
  });
});
