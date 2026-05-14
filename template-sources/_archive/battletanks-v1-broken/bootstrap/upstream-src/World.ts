import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

import { Scene } from "../../core-engine/upstream-src/system/Scene";
import { ThirdPersonViewCamera } from "../../core-engine/upstream-src/system/Camera";
import { Renderer } from "../../core-engine/upstream-src/system/Renderer";
import { Loop } from "../../core-engine/upstream-src/system/Loop";
import { displayElement, fadeElement, fadeBackGround } from "../../core-engine/upstream-src/utils/ui";

import { Ground } from "../../gameplay/upstream-src/Ground";
import { Wall } from "../../gameplay/upstream-src/Wall";
import {
  Powerup,
  HealthPowerup,
  WeaponPowerup,
  SpeedPowerup,
  AttackPowerup,
  DefensePowerup,
  PenetrationPowerup,
  GoalPowerup,
} from "../../gameplay/upstream-src/powerups";
import { Tank } from "../../gameplay/upstream-src/Tank";
import { Bullet } from "../../gameplay/upstream-src/Bullet";
import { HemiSphereLight, DirectionalLight } from "./lights";

class World {
  status: string;

  scene: Scene;
  ground: Ground;
  hemiLight: HemiSphereLight;
  directLight: DirectionalLight;

  walls: Wall[] = [];
  surrounding_walls: Wall[] = [];
  powerups: Powerup[] = [];
  tanks: Tank[] = [];
  bullets: Bullet[] = [];

  containers: HTMLElement[] = [];
  cameras: ThirdPersonViewCamera[] = [];
  renderers: Renderer[] = [];
  loop: Loop;

  meshDict: { [key: string]: THREE.Object3D } = {};
  audioDict: { [key: string]: AudioBuffer } = {};
  textureDict: { [key: string]: { [key: string]: THREE.Texture } } = {};

  listeners: THREE.AudioListener[] = [];
  bgAudios: THREE.Audio[] = [];

  sceneContainer: HTMLElement;
  menu: HTMLElement;
  replay: HTMLElement;
  instructions: HTMLElement;
  player_left_win_banner: HTMLElement;
  player_right_win_banner: HTMLElement;
  player_left_lost_banner: HTMLElement;
  player_right_lost_banner: HTMLElement;

  keyboard: { [key: string]: number } = {};

  constructor() {
    this.init();
  }

  ensureLayout() {
    if (document.getElementById("scene-container")) {
      return;
    }

    const root = document.getElementById("root") || document.body;
    root.innerHTML = `
      <div id="battle-shell" style="position:relative; width:100vw; height:100vh; overflow:hidden; background:radial-gradient(circle at top, #1d2840 0%, #0d1220 55%, #070b14 100%); color:#f6f7fb; font-family:Arial,sans-serif;">
        <div id="scene-container" style="display:flex; width:100%; height:100%;"></div>
        <div id="menu" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; background:rgba(7,11,20,0.78);">
          <div>
            <h1 style="margin:0 0 12px; font-size:40px;">Battle Tanks</h1>
            <p id="instructions" style="margin:0; font-size:16px; opacity:0.88;">Click to start. Player 1 uses WASD + Space. Player 2 uses arrows + Enter.</p>
            <p id="replayMessage" style="display:none; margin-top:12px;">Click to play again.</p>
          </div>
        </div>
        <div id="player1-win-banner" style="display:none; position:absolute; top:24px; left:24px; padding:12px 16px; background:rgba(28,201,125,0.88); border-radius:12px; font-weight:bold;">Player 1 wins</div>
        <div id="player2-win-banner" style="display:none; position:absolute; top:24px; right:24px; padding:12px 16px; background:rgba(28,201,125,0.88); border-radius:12px; font-weight:bold;">Player 2 wins</div>
        <div id="player1-lose-banner" style="display:none; position:absolute; top:24px; left:24px; padding:12px 16px; background:rgba(220,77,77,0.88); border-radius:12px; font-weight:bold;">Player 1 loses</div>
        <div id="player2-lose-banner" style="display:none; position:absolute; top:24px; right:24px; padding:12px 16px; background:rgba(220,77,77,0.88); border-radius:12px; font-weight:bold;">Player 2 loses</div>
      </div>
    `;

    const sceneContainer = document.getElementById("scene-container") as HTMLElement;
    for (let i = 0; i < 2; i++) {
      const sub = document.createElement("div");
      sub.className = "sub-container";
      sub.style.cssText = "position:relative; flex:1 1 50%; min-width:0; overflow:hidden;";
      sub.innerHTML = `
        <div style="position:absolute; inset:16px auto auto 16px; z-index:3; min-width:180px; padding:10px 12px; background:rgba(9,12,22,0.72); border:1px solid rgba(255,255,255,0.12); border-radius:12px; backdrop-filter:blur(8px);">
          <div style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; opacity:0.72;">Player ${i + 1}</div>
          <div style="margin-top:8px; font-size:13px;">Health</div>
          <div style="height:10px; background:rgba(255,255,255,0.12); border-radius:999px; overflow:hidden;">
            <div class="health__bar__fill" style="width:100%; height:100%; background:linear-gradient(90deg,#36d77d,#ffe167);"></div>
          </div>
          <div class="health__value" style="margin-top:4px; font-size:13px;">100</div>
          <div class="powerups" style="display:grid; gap:6px; margin-top:10px;"></div>
        </div>
      `;
      sceneContainer.appendChild(sub);
    }
  }

  async init() {
    this.ensureLayout();
    this.sceneContainer = document.getElementById("scene-container") as HTMLElement;
    this.menu = document.getElementById("menu") as HTMLElement;
    this.replay = document.getElementById("replayMessage") as HTMLElement;
    this.instructions = document.getElementById("instructions") as HTMLElement;
    this.player_left_win_banner = document.getElementById("player1-win-banner") as HTMLElement;
    this.player_right_win_banner = document.getElementById("player2-win-banner") as HTMLElement;
    this.player_left_lost_banner = document.getElementById("player1-lose-banner") as HTMLElement;
    this.player_right_lost_banner = document.getElementById("player2-lose-banner") as HTMLElement;

    await this.loadAssets();

    this.scene = new Scene();

    this.ground = new Ground("main");
    this.scene.add(this.ground);

    this.hemiLight = new HemiSphereLight("main");
    this.directLight = new DirectionalLight("main");
    this.scene.add(this.hemiLight);
    this.scene.add(this.directLight);

    this.initializeTanks(this.tanks);
    this.tanks.forEach((tank) => this.scene.add(tank));

    for (let i = 0; i < this.tanks.length; i++) {
      const container_sub = this.sceneContainer.getElementsByClassName("sub-container")[i] as HTMLElement;
      this.tanks[i].post_init(container_sub);
      this.containers.push(container_sub);

      const camera = new ThirdPersonViewCamera(this.tanks[i], window.innerWidth / window.innerHeight / this.tanks.length);
      const renderer = new Renderer();
      renderer.renderer.setSize(window.innerWidth / this.tanks.length, window.innerHeight);
      renderer.renderer.setPixelRatio(window.devicePixelRatio);
      container_sub.appendChild(renderer.renderer.domElement);

      this.cameras.push(camera);
      this.renderers.push(renderer);

      const listener = new THREE.AudioListener();
      camera.camera.add(listener);
      this.listeners.push(listener);
    }

    this.loop = new Loop(this.scene, this.cameras, this.renderers);

    this.reset();
    this.start();

    fadeBackGround(this.menu, 1, 0.7, false, 1500);
    this.status = "paused";
    this.registerEventHandlers();

    window.dispatchEvent(new Event("resize"));
  }

  start() {
    this.loop.start();
  }

  pause() {
    this.bgAudios.forEach((bgAudio) => bgAudio.pause());
    const tanks_index = this.loop.updatableLists.indexOf(this.tanks);
    if (tanks_index !== -1) this.loop.updatableLists.splice(tanks_index, 1);
    const bullet_index = this.loop.updatableLists.indexOf(this.bullets);
    if (bullet_index !== -1) this.loop.updatableLists.splice(bullet_index, 1);
  }

  resume() {
    this.bgAudios.forEach((bgAudio) => bgAudio.play());
    const tanks_index = this.loop.updatableLists.indexOf(this.tanks);
    if (tanks_index === -1) this.loop.updatableLists.push(this.tanks);
    const bullet_index = this.loop.updatableLists.indexOf(this.bullets);
    if (bullet_index === -1) this.loop.updatableLists.push(this.bullets);
  }

  reset() {
    this.tanks.forEach((tank) => tank.reset());

    const powerups_index = this.loop.updatableLists.indexOf(this.powerups);
    if (powerups_index !== -1) this.loop.updatableLists.splice(powerups_index, 1);
    const bullet_index = this.loop.updatableLists.indexOf(this.bullets);
    if (bullet_index !== -1) this.loop.updatableLists.splice(bullet_index, 1);

    this.walls.forEach((wall) => wall.destruct());
    this.surrounding_walls.forEach((wall) => wall.destruct());
    this.powerups.forEach((powerup) => powerup.destruct());
    this.bullets.forEach((bullet) => bullet.destruct());

    this.walls = [];
    this.surrounding_walls = [];
    this.powerups = [];
    this.bullets = [];

    this.initializeWalls(this.walls, this.surrounding_walls);
    this.initializePowerups(this.powerups);
    this.walls.forEach((wall) => this.scene.add(wall));
    this.powerups.forEach((powerup) => this.scene.add(powerup));

    this.loop.updatableLists.push(this.powerups);
    this.loop.updatableLists.push(this.bullets);

    Tank.onTick = (tank: Tank, delta: number) => {
      tank.update(this.keyboard, this.scene, this.tanks, this.walls, this.surrounding_walls, this.bullets, delta);
    };

    Bullet.onTick = (bullet: Bullet, delta: number) => {
      bullet.update(this.ground, this.bullets, this.walls, this.tanks, delta);
    };

    Powerup.onTick = (powerup: Powerup, delta: number) => {
      powerup.update(this.powerups, this.tanks, this.walls);
    };
  }

  async loadAssets() {
    const promises: Promise<void>[] = [];
    const gltfLoader = new GLTFLoader();

    const gltfPromise = (path: string) =>
      new Promise<THREE.Group>((resolve, reject) => {
        gltfLoader.load(path, (gltf) => resolve(gltf.scene), undefined, reject);
      });

    promises.push(
      gltfPromise("assets/tank_model_new/scene.gltf")
        .then((mesh) => {
          this.meshDict["Tank"] = mesh.children[0] ? mesh.children[0].clone() : mesh.clone();
        })
        .catch(() => {
          this.meshDict["Tank"] = new THREE.Mesh(
            new THREE.BoxGeometry(24, 36, 18),
            new THREE.MeshStandardMaterial({ color: 0x61dafb })
          );
        })
    );

    promises.push(
      gltfPromise("assets/bullet_model/scene.gltf")
        .then((mesh) => {
          this.meshDict["Bullet"] = mesh.children[0]?.children[0]?.children[0]?.children[0]?.children[0]?.clone() || mesh.clone();
        })
        .catch(() => {
          this.meshDict["Bullet"] = new THREE.Mesh(
            new THREE.SphereGeometry(4, 16, 16),
            new THREE.MeshStandardMaterial({ color: 0xf4d35e })
          );
        })
    );

    promises.push(
      gltfPromise("assets/powerup_model/scene.gltf")
        .then((mesh) => {
          this.meshDict["Powerup"] = mesh.children[0]?.children[0]?.children[0]?.clone() || mesh.clone();
        })
        .catch(() => {
          const group = new THREE.Group();
          for (let i = 0; i < 14; i++) {
            const node = new THREE.Mesh(
              new THREE.IcosahedronGeometry(4, 0),
              new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((i % 7) / 7, 0.75, 0.58) })
            );
            group.add(node);
          }
          this.meshDict["Powerup"] = group;
        })
    );

    this.textureDict["ground"] = {};
    this.textureDict["wall"] = {};

    await Promise.allSettled(promises);
  }

  initializeWalls(walls: Wall[], surrounding_walls: Wall[]) {
    const margin_size = 1500;
    const addWall = (size: THREE.Vector3, position: THREE.Vector3, rotation = new THREE.Euler(0, 0, 0), boundary = false) => {
      const wall = new Wall("main", this.textureDict["wall"], size, position, rotation);
      walls.push(wall);
      if (boundary) {
        surrounding_walls.push(wall);
      }
    };

    addWall(new THREE.Vector3(20, margin_size + 20, 100), new THREE.Vector3(margin_size / 2, 0, 0), new THREE.Euler(0, 0, 0), true);
    addWall(new THREE.Vector3(20, margin_size + 20, 100), new THREE.Vector3(-margin_size / 2, 0, 0), new THREE.Euler(0, 0, 0), true);
    addWall(new THREE.Vector3(20, margin_size + 20, 100), new THREE.Vector3(0, margin_size / 2, 0), new THREE.Euler(0, 0, Math.PI / 2), true);
    addWall(new THREE.Vector3(20, margin_size + 20, 100), new THREE.Vector3(0, -margin_size / 2, 0), new THREE.Euler(0, 0, Math.PI / 2), true);

    addWall(new THREE.Vector3(20, 540, 100), new THREE.Vector3(0, -220, 0));
    addWall(new THREE.Vector3(20, 360, 100), new THREE.Vector3(-220, 80, 0), new THREE.Euler(0, 0, Math.PI / 2));
    addWall(new THREE.Vector3(20, 360, 100), new THREE.Vector3(220, 80, 0), new THREE.Euler(0, 0, Math.PI / 2));
    addWall(new THREE.Vector3(20, 320, 100), new THREE.Vector3(0, 220, 0));
    addWall(new THREE.Vector3(20, 220, 100), new THREE.Vector3(-320, -260, 0));
    addWall(new THREE.Vector3(20, 220, 100), new THREE.Vector3(320, -260, 0));
  }

  pickPowerupMesh(index: number) {
    const source = this.meshDict["Powerup"];
    if (!source) {
      return new THREE.Mesh(new THREE.IcosahedronGeometry(4, 0), new THREE.MeshStandardMaterial({ color: 0xffe066 }));
    }

    if ("children" in source && source.children[index]) {
      return source.children[index];
    }

    return source;
  }

  initializePowerups(powerups: Powerup[]) {
    powerups.push(
      new HealthPowerup("main", this.pickPowerupMesh(9), new THREE.Vector3(300, 50, 15), this.listeners, this.audioDict["Powerup"]),
      new WeaponPowerup("main", this.pickPowerupMesh(1), new THREE.Vector3(-300, 50, 15), this.listeners, this.audioDict["Powerup"]),
      new SpeedPowerup("main", this.pickPowerupMesh(13), new THREE.Vector3(450, -450, 15), this.listeners, this.audioDict["Powerup"]),
      new AttackPowerup("main", this.pickPowerupMesh(2), new THREE.Vector3(50, -100, 15), this.listeners, this.audioDict["Powerup"]),
      new DefensePowerup("main", this.pickPowerupMesh(0), new THREE.Vector3(50, 50, 15), this.listeners, this.audioDict["Powerup"]),
      new PenetrationPowerup("main", this.pickPowerupMesh(11), new THREE.Vector3(-300, -300, 15), this.listeners, this.audioDict["Powerup"]),
      new GoalPowerup("main", this.pickPowerupMesh(3), new THREE.Vector3(-560, 560, 15), this.listeners, this.audioDict["Powerup"])
    );
  }

  initializeTanks(tanks: Tank[]) {
    const tank1 = new Tank("player1", this.meshDict["Tank"], this.meshDict["Bullet"], this.listeners, this.audioDict, {
      proceedUpKey: "KeyW",
      proceedDownKey: "KeyS",
      rotateLeftKey: "KeyA",
      rotateRightKey: "KeyD",
      firingKey: "Space",
    });
    const tank2 = new Tank("player2", this.meshDict["Tank"], this.meshDict["Bullet"], this.listeners, this.audioDict);
    tanks.push(tank1);
    tanks.push(tank2);
  }

  registerEventHandlers() {
    const beginOrResumeGame = (event?: Event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (this.status !== "paused" && this.status !== "gameover") return;

      if (this.status === "gameover") {
        this.reset();
        for (const element of [this.player_left_win_banner, this.player_right_win_banner, this.player_left_lost_banner, this.player_right_lost_banner]) {
          if (element.style.display !== "none") {
            fadeElement(element, 1, 0, true, 500);
          }
        }
      }

      fadeElement(this.menu, 1, 0, true, 500);
      fadeElement(this.replay, 1, 0, true, 500);
      fadeElement(this.instructions, 1, 0, true, 500);
      this.resume();
      this.status = "playing";
    };

    this.menu.style.cursor = "pointer";
    this.menu.addEventListener("pointerdown", beginOrResumeGame);
    this.replay.addEventListener("pointerdown", beginOrResumeGame);

    document.addEventListener("gameover", (e) => {
      if (!(e instanceof CustomEvent)) return;
      if (e.detail.winner === "player1") {
        displayElement(this.player_left_win_banner, 0, 1, true, 500);
        displayElement(this.player_right_lost_banner, 0, 1, true, 500);
      } else if (e.detail.winner === "player2") {
        displayElement(this.player_left_lost_banner, 0, 1, true, 500);
        displayElement(this.player_right_win_banner, 0, 1, true, 500);
      }
      setTimeout(() => {
        for (const element of [this.player_left_win_banner, this.player_right_win_banner, this.player_left_lost_banner, this.player_right_lost_banner]) {
          if (element.style.display !== "none") {
            fadeElement(element, 1, 0, true, 1000);
          }
        }
      }, 5000);
      this.pause();
      this.status = "gameover";
      displayElement(this.menu, 0, 1, true, 500);
      displayElement(this.replay, 0, 1, true, 500);
      displayElement(this.instructions, 0, 1, true, 500);
    });

    window.addEventListener("keydown", (event) => {
      if ((event.code === "Space" || event.code === "Enter") && (this.status === "paused" || this.status === "gameover")) {
        beginOrResumeGame(event);
        return;
      }
      this.keyboard[event.code] = 1;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Enter", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
        event.preventDefault();
      }
    });
    window.addEventListener("keyup", (event) => {
      this.keyboard[event.code] = 0;
    });
    window.addEventListener("resize", () => {
      this.cameras.forEach((camera) => {
        camera.camera.aspect = window.innerWidth / window.innerHeight / this.tanks.length;
        camera.camera.updateProjectionMatrix();
      });
      this.renderers.forEach((renderer) => {
        renderer.renderer.setSize(window.innerWidth / this.tanks.length, window.innerHeight);
        renderer.renderer.setPixelRatio(window.devicePixelRatio);
      });
    });
  }
}

export { World };
