# redpointfish-v1 Template Contract

Polished multiplayer poker template extracted from `req_1774359378877` (RedPointFish lineage).

## Purpose

Provide a reusable VIVERSE game baseline with:
- resilient VIVERSE auth bootstrap
- multiplayer room lifecycle (create/join/start/leave)
- single-player fallback mode
- leaderboard submission for multiplayer and single-player outcomes

## Guardrails

- Keep auth bootstrap resilience behavior intact in `src/hooks/useViverseAuth.js`.
- Preserve matchmaking actor/room lifecycle safety in `src/hooks/useMultiplayer.js`.
- Keep diagnostic visibility in `src/components/ViverseDiagnostic.jsx`.
- Preserve deterministic App ID wiring through env (`VITE_VIVERSE_CLIENT_ID`).
- Keep the root page scrollable on small viewports. Do not lock the app shell with `overflow: hidden` or fixed `h-screen` containers unless all gameplay content still remains reachable.

## Customization Surface

- UI style/theme/branding
- game balancing and turn logic
- leaderboard naming (must follow platform naming constraints)
- lobby UX and error handling
