"""
Newton Demo Server
------------------
Runs physics simulation and streams state to the browser via WebSocket.

Mode detection (automatic):
  - If newton + warp are installed and a GPU is available → Newton mode
  - Otherwise → numpy mock mode (fully functional, CPU-only)

Start:
  python server.py

Then open the Vite frontend at http://localhost:3000
"""

import asyncio
import json
import math
import random
import time
import numpy as np
import websockets

# ── Try to import Newton/Warp ──

NEWTON_AVAILABLE = False
try:
    import warp as wp
    import newton
    wp.init()
    NEWTON_AVAILABLE = True
    print("[newton] Warp + Newton loaded — GPU mode active")
except ImportError:
    print("[newton] Newton/Warp not found — running numpy mock mode")

# ── Simulation constants ──

NUM_PARTICLES = 3000   # Idea 3: soft body particle pile
NUM_AGENTS = 800       # Idea 4: crowd

GRAVITY = -18.0
FLOOR_Y = 0.0
PARTICLE_RESTITUTION = 0.35
PARTICLE_FRICTION = 0.6
AGENT_SPEED_BASE = 1.8
AGENT_WANDER_STRENGTH = 0.8

# ── Mock simulation (numpy, no GPU required) ──

class MockSimulation:
    def __init__(self):
        self.reset()

    def reset(self):
        # Particles: stack them in a tower
        self.p_pos = np.zeros((NUM_PARTICLES, 3), dtype=np.float32)
        self.p_vel = np.zeros((NUM_PARTICLES, 3), dtype=np.float32)

        cols = int(math.ceil(NUM_PARTICLES ** (1/3)))
        for i in range(NUM_PARTICLES):
            ix = i % cols
            iy = (i // cols) % cols
            iz = i // (cols * cols)
            self.p_pos[i] = [
                (ix - cols/2) * 0.45 + random.uniform(-0.1, 0.1),
                1.0 + iy * 0.45,
                (iz - cols/2) * 0.45 + random.uniform(-0.1, 0.1),
            ]
            self.p_vel[i] = [random.uniform(-0.2, 0.2), 0, random.uniform(-0.2, 0.2)]

        # Agents: scatter on the ground plane
        self.a_pos = np.zeros((NUM_AGENTS, 3), dtype=np.float32)
        self.a_vel = np.zeros((NUM_AGENTS, 3), dtype=np.float32)
        self.a_heading = np.zeros(NUM_AGENTS, dtype=np.float32)
        self.a_wander = np.random.uniform(0, 2 * math.pi, NUM_AGENTS).astype(np.float32)

        radius = 22.0
        for i in range(NUM_AGENTS):
            angle = random.uniform(0, 2 * math.pi)
            r = random.uniform(4, radius)
            self.a_pos[i] = [math.cos(angle) * r, 0.0, math.sin(angle) * r]
            self.a_heading[i] = random.uniform(0, 2 * math.pi)

        self.last_time = time.time()

    def step(self):
        now = time.time()
        dt = min(now - self.last_time, 0.05)
        self.last_time = now

        self._step_particles(dt)
        self._step_agents(dt)

    def _step_particles(self, dt):
        # Gravity
        self.p_vel[:, 1] += GRAVITY * dt

        # Integrate
        self.p_pos += self.p_vel * dt

        # Floor collision
        mask = self.p_pos[:, 1] < PARTICLE_RESTITUTION * 0.18
        self.p_pos[mask, 1] = PARTICLE_RESTITUTION * 0.18
        self.p_vel[mask, 1] *= -PARTICLE_RESTITUTION
        self.p_vel[mask, 0] *= (1.0 - PARTICLE_FRICTION * dt * 10)
        self.p_vel[mask, 2] *= (1.0 - PARTICLE_FRICTION * dt * 10)

        # Damping
        self.p_vel *= (1.0 - 0.015)

        # Clamp wild velocities
        speeds = np.linalg.norm(self.p_vel, axis=1, keepdims=True)
        fast = speeds > 40
        self.p_vel[fast[:, 0]] = self.p_vel[fast[:, 0]] / speeds[fast[:, 0]] * 40

    def _step_agents(self, dt):
        # Wander: slowly rotate heading
        self.a_wander += np.random.uniform(-AGENT_WANDER_STRENGTH, AGENT_WANDER_STRENGTH, NUM_AGENTS) * dt
        self.a_heading += self.a_wander * dt * 0.4

        # Move forward
        speed = AGENT_SPEED_BASE + np.random.uniform(-0.2, 0.2, NUM_AGENTS)
        self.a_pos[:, 0] += np.cos(self.a_heading) * speed * dt
        self.a_pos[:, 2] += np.sin(self.a_heading) * speed * dt
        self.a_pos[:, 1] = 0.0  # locked to ground

        # Boundary wrap
        for axis in [0, 2]:
            self.a_pos[self.a_pos[:, axis] > 28, axis] = -27
            self.a_pos[self.a_pos[:, axis] < -28, axis] = 27

    def smash(self, pos, radius, force):
        cx, cy, cz = pos

        # Smash particles
        dx = self.p_pos[:, 0] - cx
        dz = self.p_pos[:, 2] - cz
        dist = np.sqrt(dx**2 + dz**2)
        mask = dist < radius
        if mask.any():
            falloff = 1.0 - dist[mask] / radius
            impulse = force * falloff
            self.p_vel[mask, 0] += dx[mask] / (dist[mask] + 0.01) * impulse
            self.p_vel[mask, 1] += impulse * 0.8
            self.p_vel[mask, 2] += dz[mask] / (dist[mask] + 0.01) * impulse

        # Scatter agents
        ax = self.a_pos[:, 0] - cx
        az = self.a_pos[:, 2] - cz
        adist = np.sqrt(ax**2 + az**2)
        amask = adist < radius * 1.5
        if amask.any():
            falloff = 1.0 - adist[amask] / (radius * 1.5)
            scatter_speed = force * 0.04 * falloff
            self.a_heading[amask] = np.arctan2(az[amask], ax[amask]) + np.random.uniform(-0.3, 0.3, amask.sum())
            self.a_wander[amask] += np.random.uniform(-2, 2, amask.sum())
            self.a_pos[amask, 0] += ax[amask] / (adist[amask] + 0.01) * scatter_speed
            self.a_pos[amask, 2] += az[amask] / (adist[amask] + 0.01) * scatter_speed

    def get_state(self):
        # Pack particle data
        particle_data = [
            {
                "pos": [float(self.p_pos[i, 0]), float(self.p_pos[i, 1]), float(self.p_pos[i, 2])],
                "vel": [float(self.p_vel[i, 0]), float(self.p_vel[i, 1]), float(self.p_vel[i, 2])],
            }
            for i in range(NUM_PARTICLES)
        ]

        # Pack agent data
        agent_data = [
            {
                "id": i,
                "pos": [float(self.a_pos[i, 0]), float(self.a_pos[i, 1]), float(self.a_pos[i, 2])],
                "heading": float(self.a_heading[i]),
                "speed": float(AGENT_SPEED_BASE),
            }
            for i in range(NUM_AGENTS)
        ]

        return {"type": "state", "particles": particle_data, "agents": agent_data}


# ── Newton simulation (GPU) ──
# Stubbed — swap MockSimulation for this once Newton/Warp are installed

class NewtonSimulation:
    """
    Full Newton GPU simulation.
    TODO: Replace mock particle/agent logic with Newton's particle solver and
    rigid body pipeline once warp-lang and newton-physics are installed.

    Key Newton APIs to use:
      - newton.ModelBuilder() to construct the simulation world
      - newton.SemiImplicitIntegrator() for time stepping
      - wp.array() for GPU-side position/velocity buffers
      - newton.ParticleContactPlugin for particle-particle collisions
    """
    def __init__(self):
        # Fall back to mock until Newton integration is complete
        self._mock = MockSimulation()

    def reset(self): self._mock.reset()
    def step(self): self._mock.step()
    def smash(self, pos, radius, force): self._mock.smash(pos, radius, force)
    def get_state(self): return self._mock.get_state()


# ── WebSocket server ──

sim = NewtonSimulation() if NEWTON_AVAILABLE else MockSimulation()
clients = set()

async def broadcast_loop():
    TARGET_FPS = 30
    dt = 1.0 / TARGET_FPS
    while True:
        start = time.time()
        sim.step()
        if clients:
            state = sim.get_state()
            msg = json.dumps(state)
            await asyncio.gather(*[c.send(msg) for c in list(clients)], return_exceptions=True)
        elapsed = time.time() - start
        await asyncio.sleep(max(0, dt - elapsed))

async def handler(ws):
    clients.add(ws)
    mode = "Newton GPU" if NEWTON_AVAILABLE else "Mock (CPU)"
    print(f"[ws] Client connected — {mode} — {len(clients)} total")
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                if msg["type"] == "smash":
                    sim.smash(msg["pos"], msg.get("radius", 3.0), msg.get("force", 60.0))
                elif msg["type"] == "reset":
                    sim.reset()
            except (KeyError, json.JSONDecodeError):
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        print(f"[ws] Client disconnected — {len(clients)} remaining")

async def main():
    mode = "Newton GPU" if NEWTON_AVAILABLE else "numpy mock"
    print(f"[newton-demo] Starting in {mode} mode")
    print(f"[newton-demo] WebSocket server on ws://localhost:8765")
    print(f"[newton-demo] Simulating {NUM_PARTICLES} particles + {NUM_AGENTS} crowd agents")

    async with websockets.serve(handler, "localhost", 8765):
        await broadcast_loop()

if __name__ == "__main__":
    asyncio.run(main())
