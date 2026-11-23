# Firefox source build

Use Node from `.nvmrc` and Bun from `package.json`. From the extracted source
archive root, run:

```sh
bun install --frozen-lockfile
bun run --filter @savemedia/core build
SAVEMEDIA_STORE_BUILD=1 bun run --filter @savemedia/extension build:firefox
```

`SAVEMEDIA_STORE_BUILD=1` makes this a store build, as the submitted package
is: store builds leave out one site reader. Without it the build carries that
reader and differs from the submitted package.

The extension is in `packages/extension/dist-firefox`. The submitted ZIP also
contains the root `LICENSE` and `NOTICE`. No publishing credentials are needed.
