import * as THREE from "three";
import { Arena } from "./game/Arena.js";
import { Tank } from "./game/Tank.js";
import { ProjectileSystem } from "./game/ProjectileSystem.js";
import { GameState } from "./game/GameState.js";
import { createHud } from "./ui/createHud.js";
import { VIVERSE_CONFIG } from "./viverseConfig.js";
import { ViverseAuthController } from "./viverseAuth.js";
import { ViverseLeaderboardController } from "./viverseLeaderboard.js";
import { ViverseMultiplayerController } from "./viverseMultiplayer.js";

const root = document.querySelector("#app");
const hud = createHud(root);

let renderer = null;
let rendererReady = false;

try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance"
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  root.appendChild(renderer.domElement);
  rendererReady = true;
} catch (error) {
  console.error("[TankArena] Renderer initialization failed:", error);
}

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x081018, 22, 56);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 120);
const cameraTarget = new THREE.Vector3(0, 0, 0);

const arena = new Arena(scene);
const state = new GameState();
const projectiles = new ProjectileSystem(scene);
const leaderboard = new ViverseLeaderboardController();
const multiplayer = new ViverseMultiplayerController(handleMultiplayerState);

const tanks = [
  new Tank({
    id: "p1",
    color: "#38bdf8",
    position: new THREE.Vector3(-11, 0, 11),
    scene
  }),
  new Tank({
    id: "p2",
    color: "#fb7185",
    position: new THREE.Vector3(11, 0, -11),
    scene
  })
];

const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const pointerHit = new THREE.Vector3();
let lastFrameTime = performance.now();
let roundCounter = 0;
let leaderboardPanelOpen = false;
let roomPanelOpen = false;

const input = {
  pressed: new Set(),
  firing: false,
  heavyFire: false,
  pointerActive: false,
  pointerAiming: false,
  pointerWorld: new THREE.Vector3()
};

const auth = new ViverseAuthController((authState) => {
  const profileName = authState.profile?.displayName || "Guest";
  hud.refs.identity.textContent = authState.isAuthenticated ? profileName : "Guest";
  hud.refs.authAction.textContent =
    authState.isAuthenticated ? "Connected" : authState.status === "checking_auth" ? "Checking..." : "Login";
  hud.refs.authAction.disabled = authState.isAuthenticated || authState.status === "checking_auth";
  if (authState.isAuthenticated && authState.profile?.accessToken) {
    initializeLeaderboard(authState).catch((error) => {
      renderLeaderboardMessage(error?.message || "Leaderboard unavailable");
    });
    initializeMultiplayer(authState).catch((error) => {
      renderRoomStatus(error?.message || "Multiplayer unavailable");
    });
  }
});

hud.refs.appId.textContent = VIVERSE_CONFIG.appId ? `App ID: ${VIVERSE_CONFIG.appId}` : "No App ID";
hud.refs.start.addEventListener("click", () => startRound());
hud.refs.authAction.addEventListener("click", () => auth.login());
hud.refs.leaderboardToggle.addEventListener("click", () => toggleLeaderboardPanel(true));
hud.refs.leaderboardClose.addEventListener("click", () => toggleLeaderboardPanel(false));
hud.refs.roomToggle.addEventListener("click", () => toggleRoomPanel(true));
hud.refs.roomClose.addEventListener("click", () => toggleRoomPanel(false));
hud.refs.roomCreate.addEventListener("click", () => handleCreateRoom());
hud.refs.roomRefresh.addEventListener("click", () => handleRefreshRooms());
hud.refs.roomLeave.addEventListener("click", () => handleLeaveRoom());
hud.refs.roomStart.addEventListener("click", () => handleStartMatch());

window.addEventListener("keydown", (event) => {
  input.pressed.add(event.code);
  if (event.code === "Space") {
    input.firing = true;
    event.preventDefault();
  }
  if (event.code === "KeyE") {
    input.heavyFire = true;
    event.preventDefault();
  }
  if (event.code === "Enter" && !state.running) startRound();
});

window.addEventListener("keyup", (event) => {
  input.pressed.delete(event.code);
  if (event.code === "Space") input.firing = false;
  if (event.code === "KeyE") input.heavyFire = false;
});

window.addEventListener("pointerdown", (event) => {
  input.pointerActive = true;
  input.pointerAiming = true;
  input.firing = true;
  updatePointer(event);
});

window.addEventListener("pointermove", (event) => {
  if (!input.pointerActive) return;
  updatePointer(event);
});

window.addEventListener("pointerup", () => {
  input.pointerActive = false;
  input.pointerAiming = false;
  input.firing = false;
  input.heavyFire = false;
});

window.addEventListener("resize", () => {
  if (!rendererReady) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

startRound();
auth.initialize();

if (rendererReady) {
  animate();
} else {
  setStatus("3D renderer unavailable in this environment.");
}

function updatePointer(event) {
  pointerNdc.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointerNdc.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  raycaster.ray.intersectPlane(pointerPlane, pointerHit);
  input.pointerWorld.copy(pointerHit);
}

function startRound() {
  roundCounter += 1;
  leaderboard.resetResultGuard();
  arena.regenerateLayout(roundCounter);
  state.resetRound();
  const p1 = tanks[0];
  const p2 = tanks[1];
  p1.position.set(-11, 0, 11);
  p1.bodyAngle = Math.PI * 0.25;
  p1.turretAngle = p1.bodyAngle;
  p2.position.set(11, 0, -11);
  p2.bodyAngle = -Math.PI * 0.75;
  p2.turretAngle = p2.bodyAngle;
  p1.cooldown = 0;
  p2.cooldown = 0;
  projectiles.dispose();
  setStatus("Round live. Move, aim, and fire.");
}

function getMoveVector() {
  return {
    throttle: (input.pressed.has("KeyW") ? 1 : 0) + (input.pressed.has("KeyS") ? -1 : 0),
    turn: (input.pressed.has("KeyA") ? 1 : 0) + (input.pressed.has("KeyD") ? -1 : 0)
  };
}

function getTurretTurn() {
  return (
    (input.pressed.has("ArrowLeft") || input.pressed.has("KeyJ") ? 1 : 0) +
    (input.pressed.has("ArrowRight") || input.pressed.has("KeyL") ? -1 : 0)
  );
}

function updatePlayer(dt) {
  const player = tanks[0];
  const drive = getMoveVector();
  const turretTurn = getTurretTurn();
  player.drive(drive, dt, arena);
  collectMaterialsFor(player.id, player.position);

  if (turretTurn !== 0) {
    input.pointerAiming = false;
    player.rotateTurret(turretTurn, dt);
  } else if (input.pointerAiming && input.pointerWorld.lengthSq() > 0.001) {
    player.aimAt(input.pointerWorld);
  }

  if (input.heavyFire) {
    if (state.consumeHeavyShot(player.id)) {
      player.tryFire(projectiles, { heavy: true });
      input.heavyFire = false;
      setStatus("Heavy round fired. It can pierce walls.");
    }
  } else if (input.firing) {
    player.tryFire(projectiles);
  }
}

function updateBot(dt) {
  const bot = tanks[1];
  const player = tanks[0];
  const time = performance.now() * 0.001;
  const wobble = new THREE.Vector3(Math.sin(time * 0.62), 0, Math.cos(time * 0.48)).multiplyScalar(2.8);
  const perceivedTarget = player.position.clone().add(wobble);
  const toPlayer = perceivedTarget.clone().sub(bot.position);
  const preferredDistance = 12.5;
  const move = new THREE.Vector3();

  if (toPlayer.length() > preferredDistance + 3.2) {
    move.copy(toPlayer.normalize());
  } else if (toPlayer.length() < preferredDistance - 3.2) {
    move.copy(toPlayer.normalize().multiplyScalar(-1));
  } else {
    move.set(Math.sin(time * 0.38), 0, Math.cos(time * 0.5)).normalize();
  }

  bot.driveToward(move, dt, arena);
  bot.aimAt(perceivedTarget);
  collectMaterialsFor(bot.id, bot.position);
  const botState = state.getPlayer(bot.id);
  if (botState?.heavyReady && Math.random() < dt * 0.16) {
    if (state.consumeHeavyShot(bot.id)) {
      bot.tryFire(projectiles, { heavy: true });
    }
  }
  if (Math.random() < dt * 0.45) {
    bot.tryFire(projectiles);
  }
}

function updateCamera() {
  const midpoint = tanks[0].position.clone().add(tanks[1].position).multiplyScalar(0.5);
  cameraTarget.lerp(midpoint, 0.08);
  camera.position.lerp(
    new THREE.Vector3(cameraTarget.x + 17, 26, cameraTarget.z + 17),
    0.08
  );
  camera.lookAt(cameraTarget.x, 0.5, cameraTarget.z);
}

function onHit(targetId, projectile) {
  state.applyDamage(targetId, projectile?.damage || 18);
  const target = state.getPlayer(targetId);
  if (!state.running) {
    if (state.winner === "draw") {
      setStatus("Draw. Tap Start Round to replay.");
    } else {
      const winner = state.getPlayer(state.winner);
      setStatus(`${winner?.name || "Winner"} wins. Tap Start Round to replay.`);
      if (winner?.id === "p1") {
        submitLeaderboardResult().catch((error) => {
          setStatus(`Win recorded locally. Leaderboard submit failed: ${error?.message || "unknown error"}`);
        });
      }
    }
  } else if (target) {
    setStatus(`${target.name} hit for ${projectile?.damage || 18}.`);
  }
}

function syncHud() {
  const p1 = state.getPlayer("p1");
  const p2 = state.getPlayer("p2");
  hud.refs.p1Name.textContent = `${p1.name} • ${p1.score}`;
  hud.refs.p2Name.textContent = `${p2.name} • ${p2.score}`;
  hud.refs.p1Hp.textContent = `${p1.hp}`;
  hud.refs.p2Hp.textContent = `${p2.hp}`;
  hud.refs.p1Weapon.textContent = `Materials: ${p1.materials} • Heavy: ${p1.heavyReady ? "Ready" : "No"}`;
  hud.refs.p2Weapon.textContent = `Materials: ${p2.materials} • Heavy: ${p2.heavyReady ? "Ready" : "No"}`;
  hud.refs.p1Bar.style.width = `${p1.hp}%`;
  hud.refs.p2Bar.style.width = `${p2.hp}%`;
  hud.refs.timer.textContent = `${Math.max(0, Math.ceil(state.roundTime - state.elapsed))}`;
  hud.refs.start.textContent = state.running ? "Restart Round" : "Start Round";
}

function collectMaterialsFor(playerId, position) {
  if (!state.running) return;
  const collected = arena.collectMaterialAt(position);
  if (!collected) return;
  const updated = state.collectMaterial(playerId, 1);
  if (!updated) return;
  const player = state.getPlayer(playerId);
  if (updated.heavyReady) {
    setStatus(`${player?.name || "Player"} charged a heavy round.`);
  } else {
    setStatus(`${player?.name || "Player"} collected material (${updated.materials}/3).`);
  }
}

function setStatus(text) {
  hud.refs.status.textContent = text;
}

async function initializeLeaderboard(authState) {
  if (!VIVERSE_CONFIG.appId) {
    renderLeaderboardMessage("Leaderboard disabled until App ID is configured.");
    return;
  }

  await leaderboard.initialize({
    sdk: authState.sdk || auth.getSdk(),
    authClient: authState.authClient || auth.getClient(),
    accessToken: authState.profile?.accessToken
  });
  renderLeaderboardMessage("Loading rankings...");
  const rankings = await leaderboard.fetchTop();
  renderLeaderboardRows(rankings);
}

async function initializeMultiplayer(authState) {
  if (!VIVERSE_CONFIG.appId) {
    renderRoomStatus("Multiplayer disabled until App ID is configured.");
    return;
  }
  await multiplayer.initialize({
    sdk: authState.sdk || auth.getSdk(),
    profile: authState.profile
  });
  renderRoomStatus("Connected. Create a room or join one below.");
}

function toggleLeaderboardPanel(forceOpen) {
  leaderboardPanelOpen = typeof forceOpen === "boolean" ? forceOpen : !leaderboardPanelOpen;
  hud.refs.leaderboardPanel.classList.toggle("hud__leaderboard--hidden", !leaderboardPanelOpen);
  if (leaderboardPanelOpen && leaderboard.rankings.length > 0) {
    renderLeaderboardRows(leaderboard.rankings);
  }
}

function toggleRoomPanel(forceOpen) {
  roomPanelOpen = typeof forceOpen === "boolean" ? forceOpen : !roomPanelOpen;
  hud.refs.roomPanel.classList.toggle("hud__leaderboard--hidden", !roomPanelOpen);
}

function renderLeaderboardMessage(message) {
  hud.refs.leaderboardBody.innerHTML = `<div class="hud__leaderboard-muted">${message}</div>`;
}

function renderLeaderboardRows(rankings) {
  if (!rankings || rankings.length === 0) {
    renderLeaderboardMessage("No scores yet. Win a round while logged in to create the first entry.");
    return;
  }

  hud.refs.leaderboardBody.innerHTML = rankings
    .map((entry, index) => {
      const rank = entry.rank || entry.ranking || index + 1;
      const name =
        entry.display_name ||
        entry.displayName ||
        entry.user_name ||
        entry.username ||
        entry.name ||
        "Player";
      const value = entry.value ?? entry.score ?? entry.points ?? 0;
      return `
        <div class="hud__leaderboard-row">
          <div>#${rank}</div>
          <div>${name}</div>
          <div>${value}</div>
        </div>
      `;
    })
    .join("");
}

function handleMultiplayerState(statePatch) {
  const actorCount = statePatch.actors?.length || 0;
  const currentRoom = statePatch.currentRoom;
  hud.refs.roomStart.disabled = !statePatch.canStart;
  hud.refs.roomLeave.disabled = !currentRoom;
  hud.refs.roomCreate.disabled = statePatch.status === "connecting";
  hud.refs.roomRefresh.disabled = statePatch.status === "connecting";

  if (currentRoom) {
    renderRoomStatus(
      `${statePatch.isHost ? "Host" : "Guest"} in ${currentRoom.name} • ${actorCount}/${currentRoom.maxPlayers}`
    );
  } else if (statePatch.error) {
    renderRoomStatus(statePatch.error);
  } else if (statePatch.isConnected) {
    renderRoomStatus("Connected. Create a room or join one below.");
  }

  renderRoomRows(statePatch.rooms || [], currentRoom);
}

function renderRoomStatus(message) {
  hud.refs.roomStatus.textContent = message;
}

function renderRoomRows(rooms, currentRoom) {
  if (!rooms || rooms.length === 0) {
    hud.refs.roomBody.innerHTML = `<div class="hud__leaderboard-muted">No open rooms found.</div>`;
    return;
  }

  hud.refs.roomBody.innerHTML = rooms
    .map((room) => {
      const actorCount = Array.isArray(room.actors) ? room.actors.length : 0;
      const isCurrent = currentRoom?.id === room.id;
      return `
        <div class="hud__room-card">
          <strong>${room.name}</strong>
          <div class="hud__leaderboard-muted">${actorCount}/${room.maxPlayers} players</div>
          ${
            isCurrent
              ? `<div class="hud__leaderboard-muted">You are in this room</div>`
              : `<button class="hud__chip" data-room-join="${room.id}">Join</button>`
          }
        </div>
      `;
    })
    .join("");

  for (const button of hud.refs.roomBody.querySelectorAll("[data-room-join]")) {
    button.addEventListener("click", () => handleJoinRoom(button.getAttribute("data-room-join")));
  }
}

async function handleCreateRoom() {
  try {
    await multiplayer.createRoom();
  } catch (error) {
    renderRoomStatus(error?.message || "Create room failed");
  }
}

async function handleRefreshRooms() {
  try {
    await multiplayer.refreshRooms();
  } catch (error) {
    renderRoomStatus(error?.message || "Refresh failed");
  }
}

async function handleJoinRoom(roomId) {
  try {
    await multiplayer.joinRoom(roomId);
  } catch (error) {
    renderRoomStatus(error?.message || "Join failed");
  }
}

async function handleLeaveRoom() {
  try {
    await multiplayer.leaveRoom();
  } catch (error) {
    renderRoomStatus(error?.message || "Leave failed");
  }
}

async function handleStartMatch() {
  try {
    await multiplayer.startMatch();
    renderRoomStatus("Start match requested.");
  } catch (error) {
    renderRoomStatus(error?.message || "Start match failed");
  }
}

async function submitLeaderboardResult() {
  const profile = auth.getProfile();
  if (!profile?.accessToken) return;

  const resultKey = `round-${roundCounter}-winner-${state.winner}-elapsed-${Math.ceil(state.elapsed)}`;
  const submitted = await leaderboard.submitWin({
    resultKey,
    value: 1
  });
  if (!submitted) return;

  const rankings = await leaderboard.fetchTop();
  renderLeaderboardRows(rankings);
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  if (state.running) {
    updatePlayer(dt);
    updateBot(dt);
    projectiles.update(dt, arena, tanks, onHit);
    state.tick(dt);
  }

  for (const tank of tanks) {
    tank.update(dt);
  }

  if (!state.running && state.winner === "draw") {
    setStatus("Draw. Tap Start Round to replay.");
  }

  updateCamera();
  syncHud();
  if (!rendererReady) return;
  renderer.render(scene, camera);
}
