# Flow Line Source

Source-of-truth PlayCanvas export for the `flow-line-v1` template.

## Status

- verified in VIVERSE preview
- VIVERSE auth/profile chip working
- leaderboard wiring working against the published Flow Line app

## Notes

- Polish and validate here first.
- Freeze into `templates/flow-line-v1/` with `node scripts/build-template.mjs --source template-sources/flow-line/app --template flow-line-v1 --skip-diff` for first export.
- Keep `2453710.json` `clientId` blank in the source so preview hostname can resolve the App ID at runtime.
