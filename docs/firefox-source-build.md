# Firefox source build

Use Node from `.nvmrc` and Bun from `package.json`. From the extracted source
archive root, run:

```sh
# The private store-publishing CLI is not needed to build the extension.
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
for (const file of ['package.json', 'bun.lock']) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^.*"@ancplua\/store-publish":.*\n/gm, ''));
}
JS
bun install --frozen-lockfile
bun run --filter @savemedia/core build
bun run --filter @savemedia/extension build:firefox
```

The extension is in `packages/extension/dist-firefox`. The submitted ZIP also
contains the root `LICENSE` and `NOTICE`. No publishing credentials are needed.
