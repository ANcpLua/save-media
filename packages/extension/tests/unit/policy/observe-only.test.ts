import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// savemedia observes a page and never operates it: no click, no made-up
// input event, no playback control, no new frame or window. This test reads
// the code that runs inside pages and fails on any of those.

const CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/content");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["a click on a page element", /\.click\s*\(/],
  ["a made-up mouse, pointer, keyboard, touch or input event", /new\s+(?:\w+\.)?(?:Mouse|Pointer|Keyboard|Touch|Input|Wheel|Submit)Event\b/],
  ["an older way to make up an event", /createEvent\s*\(|initMouseEvent|initKeyboardEvent/],
  ["a form submission", /\.(?:submit|requestSubmit)\s*\(/],
  ["starting, pausing or seeking a player", /\.(?:play|pause|load|fastSeek)\s*\(\s*\)|\.currentTime\s*=[^=]|\.playbackRate\s*=[^=]/],
  ["muting or changing the volume", /\.(?:muted|volume)\s*=[^=]/],
  ["a new frame", /createElement\s*\(\s*["'`](?:iframe|frame|object|embed)["'`]/],
  ["a new window or tab", /window\.open\s*\(|\.open\s*\(\s*["'`]https?:/],
  ["a navigation of the page", /location\.(?:href|assign|replace)\s*(?:=[^=]|\()/],
  ["a fullscreen or picture-in-picture request", /requestFullscreen|requestPictureInPicture|exitFullscreen/],
  ["a focus change in the page", /\.(?:focus|blur)\s*\(\s*\)/],
];

/** The one event the page scripts send: their own channel from the page's world to the bridge. It reaches no listener of the page's controls. */
const OWN_CHANNEL = /dispatchEvent\(new scope\.CustomEvent\(EME_EVENT,/;

describe("the code that runs inside pages only observes", () => {
  const sources = files(CONTENT).map(path => ({ name: relative(CONTENT, path), text: readFileSync(path, "utf8") }));

  it("finds the page scripts it is meant to read", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map(source => source.name)).toEqual(expect.arrayContaining(["bridge.ts", "main.ts", "pointer-media.ts", "frame-facts.ts"]));
  });

  it.each(FORBIDDEN)("contains no %s", (_what, pattern) => {
    const hits = sources.flatMap(source => source.text.split("\n").flatMap((line, index) =>
      pattern.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line) ? [`${source.name}:${index + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });

  it("sends no event into the page except its own message between its two worlds", () => {
    const hits = sources.flatMap(source => source.text.split("\n").flatMap((line, index) =>
      /dispatchEvent\s*\(/.test(line) && !OWN_CHANNEL.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line) ? [`${source.name}:${index + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
    // And that one event is the only one.
    expect(sources.filter(source => /dispatchEvent\s*\(/.test(source.text)).map(source => source.name)).toEqual(["page/eme-proof.ts"]);
  });
});
