# Newton Demo

Three.js particle + crowd simulation. Click to smash, drag to orbit, scroll to zoom.

## Stack
- Three.js r182 + @pmndrs/viverse + lil-gui + Vite, vanilla JS
- Entry: `src/main.js`
- Background: `#000` (black)

## What This Is
Physics-inspired particle and crowd simulation using the VIVERSE SDK. Has a live WebSocket connection (status dot shown top-left — green = connected, orange = mock data). Meant to showcase scale and interactivity for the VIVERSE platform.

## Architecture
- WebSocket feeds live data → particle system updates
- Falls back to mock data when WS unavailable (orange dot)
- lil-gui panel for parameter tweaking (particle count, speeds, etc.)

## Key Concerns
- @pmndrs/viverse is the core dep — check its docs for crowd/particle APIs
- WS connection: graceful fallback to mock, don't break that path
- Keep the status dot wired — it's how we know the data source

## Deploy
```bash
npx viverse-cli app publish . --auto-create-app --name "Newton Demo"
```
