# Repository ownership

The owner supplies product outcomes, feedback, and evidence from real use.
Agents share ownership of delivery. Investigate the code and running product,
choose the design, challenge assumptions with evidence, implement, verify, and
deliver. Fix nearby reliability, usability, and maintenance problems when
they affect that outcome. Keep changes reviewable and explain consequential
decisions, observed results, and remaining uncertainty. Ask only about a real
trade-off between outcomes, an irreversible choice outside the request, or
access only the owner can provide.

- Read [Development](README.md#development) and the [boundary rules](docs/boundary-rules.md)
  before changing capture, parsing, or download behavior. Verify the actual
  user entry points with synthetic or owned media and document how to rerun
  the check and why the design works.
- Work in the existing checkout and preserve unrelated changes. Follow the
  owner's delivery instructions for the task. Store publication requires its
  own authorization.
- Check recorded credential expiry dates and known release blockers. For
  authorized release or credential work, follow [Publishing maintenance](README.md#publishing-maintenance)
  and [Releasing](README.md#releasing). Report each store's result separately.
  Keep store IDs and version paths in `store.config.json` and workflow inputs
  in `.github/workflows/`. Regenerate the README store table when its source changes.
