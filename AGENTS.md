# Repository ownership

The owner supplies product outcomes, feedback, and evidence from real use.
Agents share ownership of delivery. Investigate the code and running product,
choose the design, challenge assumptions with evidence, implement, verify, and
deliver. Fix nearby reliability, usability, and maintenance problems when
they affect that outcome. Keep changes reviewable and explain consequential
decisions, observed results, and remaining uncertainty. Ask only about a real
trade-off between outcomes, an irreversible choice outside the request, or
access only the owner can provide.

- Read [Development](README.md#development) and the [policy](docs/boundary-rules.md)
  before changing capture, parsing, download behaviour or user-facing text.
  `docs/boundary-rules.md` is the owner's policy and overrides other docs.
  Verify the actual user entry points with synthetic or owned media and
  document how to rerun the check and why the design works.
- User-facing text has one home per kind. `JobError` failures: core
  `errors/messages.ts` and `errors/network-block.ts`. Everything else,
  including Local downloader failures and image refusals: extension
  `ui/text.ts`, `ui/toast-text.ts` and `util/transfer-progress.ts`. Follow the
  wording rules at the top of those
  files: plain words, what the user can do, codes only under Technical
  details, and never a pointer to a site's own buttons.
- Work in the existing checkout and preserve unrelated changes. Follow the
  owner's delivery instructions for the task. Store publication requires its
  own authorization.
- Check recorded credential expiry dates and known release blockers. For
  authorized release or credential work, follow [Publishing maintenance](README.md#publishing-maintenance)
  and [Releasing](README.md#releasing). Report each store's result separately.
  Keep store IDs and version paths in `store.config.json` and workflow inputs
  in `.github/workflows/`. Regenerate the README store table when its source changes.
- Bun is the only JavaScript runtime here. Scripts start tools with `bun --bun`
  or `bunx --bun`, never with `node`, `npm` or `npx`; CI fails on any call to
  node.
