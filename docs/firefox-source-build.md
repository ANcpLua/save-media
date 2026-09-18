# Firefox source build

Use Node from `.nvmrc` and Bun from `package.json`. From the extracted source
archive root, run:

```sh
bun install --frozen-lockfile
bun run --filter @savemedia/core build
bun run --filter @savemedia/extension build:firefox
```

The extension is in `packages/extension/dist-firefox`. The submitted ZIP also
contains the root `LICENSE` and `NOTICE`. No publishing credentials are needed.
