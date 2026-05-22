declare module "mp4box" {
  interface MP4File {
    onReady: (info: unknown) => void;
    onError: (err: string) => void;
    appendBuffer(buffer: ArrayBuffer): number;
    flush(): void;
  }
  function createFile(): MP4File;
  const _default: { createFile: typeof createFile };
  export default _default;
}
