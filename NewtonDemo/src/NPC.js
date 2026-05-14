import * as THREE from 'three';
import { createInstance } from './character-loader.js';

const FLEE_RADIUS   = 3.0;
const FLEE_SPEED    = 1.6;
const WANDER_SPEED  = 0.5;
const PICKUP_RADIUS = 1.0;
const BOUNDS        = 4.5;

// Mixamo locomotion clips are authored for fast humanoid speeds (~1.5 m/s
// walk, ~3.5 m/s run). Our NPCs walk much slower → cycle at ~0.4× looks
// natural and stops the foot-skating effect. Exposed at module level so
// CharacterManager can let the GUI tune it live.
export const ANIM_SPEED = {
  walk: 0.4,
  run:  0.55,
};

// pmndrs/viverse normalises every loaded model to the same orientation —
// they all face -Z by default after `loadCharacterModel`. Same flip the
// hub uses on every NPC.
const FACING_FLIP = Math.PI;

export class NPC {
  constructor(scene, type, x, z) {
    this.scene = scene;
    this.type  = type;
    this.state = 'wander';
    this.velocity = new THREE.Vector3();
    this.angle = Math.random() * Math.PI * 2;
    this._t = Math.random() * 100;

    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    scene.add(this.group);

    this.mixer  = null;
    this.actions = {};
    this._currentActionName = null;
    this.holdOffsetY = -1.55;
    // Held only when the loaded model exposes an update() (VRMs do — needed
    // to copy animated humanoid bones into raw skin bones every frame).
    this._modelUpdate = null;

    // Ragdoll / throw physics state
    this.swingVel  = new THREE.Vector3(); // pendulum velocity while held
    this.thrownVel = new THREE.Vector3(); // ballistic velocity when thrown
    this.tumbleX   = 0;
    this.tumbleZ   = 0;
    this.recoverTime = 0;

    this._buildPlaceholder();
    this._loadModel();
  }

  _buildPlaceholder() {
    this._placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.18, 0.9, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.4 })
    );
    this._placeholder.position.y = 0.75;
    this.group.add(this._placeholder);
  }

  async _loadModel() {
    try {
      const { model, instance, mixer, actions, scale, holdOffsetY } =
        await createInstance(this.type);

      instance.scale.setScalar(scale);
      this.holdOffsetY = holdOffsetY;
      this.mixer       = mixer;
      this.actions     = actions;

      // Slow the clip cycles so feet don't skate over the ground. Idle has
      // no XZ movement so its timing isn't speed-bound — leave at 1×.
      if (actions.walk) actions.walk.timeScale = ANIM_SPEED.walk;
      if (actions.run)  actions.run.timeScale  = ANIM_SPEED.run;
      // VRM update is required to propagate humanoid → skin bones each frame.
      this._modelUpdate = (typeof model?.update === 'function')
        ? model.update.bind(model)
        : null;

      this.group.remove(this._placeholder);
      this._placeholder.geometry.dispose();
      this._placeholder.material.dispose();
      this.group.add(instance);
      this._instance = instance;

      this._playAction('idle', 0);
    } catch (err) {
      console.warn(`[NPC] load failed (${this.type}):`, err);
      if (this._placeholder) {
        this._placeholder.material.color.setHex(0xff3344);
        this._placeholder.material.opacity = 1;
      }
    }
  }

  _playAction(name, fadeTime = 0.2) {
    const next = this.actions[name];
    if (!next || this._currentActionName === name) return;
    if (this._currentActionName) {
      const prev = this.actions[this._currentActionName];
      if (prev) prev.fadeOut(fadeTime);
    }
    next.reset().fadeIn(fadeTime).play();
    this._currentActionName = name;
  }

  update(delta, clawPos, clawClosed, options = {}) {
    this._t += delta;
    if (this.mixer) this.mixer.update(delta);
    // VRMs need this AFTER the mixer ticks so the freshly-animated humanoid
    // pose is pushed down into the actual skin bones the renderer reads.
    if (this._modelUpdate) this._modelUpdate(delta);

    const allowFlee   = options.flee === true;
    const armEffector = options.armEffector;
    const clawVel     = options.clawVelocity;
    const fx          = options.effects;

    // ── Thrown: ballistic flight + bouncy landing + trail + impact FX ──
    if (this.state === 'thrown') {
      this.thrownVel.y -= 9.8 * delta;                 // gravity
      this.group.position.addScaledVector(this.thrownVel, delta);
      this.group.rotation.x += this.tumbleX * delta;
      this.group.rotation.z += this.tumbleZ * delta;

      if (this._trail) this._trail.push(this.group.position);

      if (this.group.position.y <= 0) {
        this.group.position.y = 0;
        const impactSpeed = Math.abs(this.thrownVel.y);
        if (this.thrownVel.y < -1.0) {
          this.thrownVel.y *= -0.55;
          this.thrownVel.x *= 0.72;
          this.thrownVel.z *= 0.72;
          this.tumbleX    *= 0.7;
          this.tumbleZ    *= 0.7;
          // Bounce FX
          if (fx) {
            const intensity = Math.min(1.0, impactSpeed / 8);
            fx.puffs?.spawn(this.group.position, 14, 0.8 + intensity);
            fx.shake?.hit(0.15 + intensity * 0.25);
            fx.sfx?.boing(0.4 + intensity * 0.6);
          }
        } else {
          // Settled
          this.thrownVel.set(0, 0, 0);
          this.tumbleX = this.tumbleZ = 0;
          this.group.rotation.set(0, Math.random() * Math.PI * 2, 0);
          this.state = 'recovering';
          this.recoverTime = 0;
          // Final puff + thud
          if (fx) {
            fx.puffs?.spawn(this.group.position, 8, 0.5);
            fx.sfx?.thud(0.4);
          }
          // Drop trail
          if (this._trail) { this._trail.dispose(); this._trail = null; }
        }
      }
      if (this.actions.idle) this._playAction('idle', 0.05);
      return;
    }

    // ── Recovering: brief stunned period after landing ─────────────────
    if (this.state === 'recovering') {
      this.recoverTime += delta;
      if (this.actions.idle) this._playAction('idle', 0.1);
      if (this.recoverTime > 1.2) {
        this.state = 'wander';
        this.angle = Math.random() * Math.PI * 2;
      }
      return;
    }

    // ── Held: damped-pendulum ragdoll + drop check ─────────────────────
    if (this.state === 'held') {
      // Damped spring back to identity rotation (gravity pulls them
      // dangling straight) + tiny noise + reaction to claw motion.
      const damping   = 0.94;
      const stiffness = 0.07;
      const noise     = 0.012;

      this.swingVel.x = this.swingVel.x * damping
        - this.group.rotation.x * stiffness
        + (Math.random() - 0.5) * noise;
      this.swingVel.z = this.swingVel.z * damping
        - this.group.rotation.z * stiffness
        + (Math.random() - 0.5) * noise;

      // Inject claw motion so a fast whip makes the body lag/swing
      if (clawVel) {
        this.swingVel.x -= clawVel.z * 0.008;
        this.swingVel.z += clawVel.x * 0.008;
      }

      this.group.rotation.x = THREE.MathUtils.clamp(
        this.group.rotation.x + this.swingVel.x, -1.2, 1.2);
      this.group.rotation.z = THREE.MathUtils.clamp(
        this.group.rotation.z + this.swingVel.z, -1.2, 1.2);

      if (this.actions.idle) this._playAction('idle', 0.15);
      if (!clawClosed) this._dropFromClaw(clawVel, fx);
      return;
    }

    // Horizontal distance for AI/pickup; vertical gap separately so the claw
    // must actually be at NPC body height.
    const dx = this.group.position.x - clawPos.x;
    const dz = this.group.position.z - clawPos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const verticalGap = clawPos.y - this.group.position.y;
    const inPickupZone =
      horizDist < PICKUP_RADIUS &&
      verticalGap >  -0.3 &&
      verticalGap <   2.5;

    if (clawClosed && inPickupZone && armEffector) {
      this._pickupByClaw(armEffector);
      return;
    }

    const fleeing = allowFlee && horizDist < FLEE_RADIUS;
    this.state = fleeing ? 'flee' : 'wander';
    const speed = fleeing ? FLEE_SPEED : WANDER_SPEED;

    if (fleeing) {
      const away = this.group.position.clone().sub(clawPos);
      away.y = 0;
      away.lengthSq() < 0.001 ? away.set(1, 0, 0) : away.normalize();
      this.angle = Math.atan2(away.x, away.z);
    } else {
      this.angle += (Math.random() - 0.5) * delta * 1.8;
    }

    this.velocity.set(Math.sin(this.angle), 0, Math.cos(this.angle)).multiplyScalar(speed);
    this.group.position.addScaledVector(this.velocity, delta);

    const p = this.group.position;
    if (Math.abs(p.x) > BOUNDS || Math.abs(p.z) > BOUNDS) {
      this.angle += Math.PI + (Math.random() - 0.5) * 0.5;
      p.x = THREE.MathUtils.clamp(p.x, -BOUNDS, BOUNDS);
      p.z = THREE.MathUtils.clamp(p.z, -BOUNDS, BOUNDS);
    }

    // Face direction of travel — uniform flip thanks to pmndrs/viverse
    // normalising every model to face -Z.
    if (this.velocity.lengthSq() > 0.001) {
      this.group.rotation.y = Math.atan2(this.velocity.x, this.velocity.z) + FACING_FLIP;
    }

    if (this.actions.walk) this._playAction(fleeing ? 'run' : 'walk');
  }

  _pickupByClaw(effector) {
    this.state = 'held';
    effector.attach(this.group);
    this.group.position.set(0, this.holdOffsetY, 0);
    this.group.rotation.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.swingVel.set(0, 0, 0);
    if (this.actions.idle) this._playAction('idle', 0.1);
  }

  // If the claw is whipping fast at release, transfer that momentum to the
  // figure (throw). Otherwise just drop them gently.
  _dropFromClaw(clawVelocity, fx) {
    this.scene.attach(this.group);

    const speedSq = clawVelocity ? clawVelocity.lengthSq() : 0;
    if (speedSq > 4.0) {
      this.thrownVel.copy(clawVelocity).multiplyScalar(0.6);
      this.thrownVel.y = Math.max(this.thrownVel.y * 0.6, 0) + 2.2;
      this.tumbleX = (Math.random() - 0.5) * 8;
      this.tumbleZ = (Math.random() - 0.5) * 6;
      this.state = 'thrown';
      if (fx) {
        fx.sfx?.whoosh();
        if (fx.trails) this._trail = fx.trails.acquire(0xff8a3d);
      }
      return;
    }

    this.group.position.y = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.group.rotation.set(0, this.angle, 0);
    this.state = 'wander';
  }
}
