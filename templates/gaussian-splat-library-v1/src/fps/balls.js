import * as THREE from 'three';

const BALL_RADIUS  = 0.12;   // m
const BALL_SPEED   = 15;     // m/s
const GRAVITY      = -20;    // m/s²
const RESTITUTION  = 0.55;   // energy kept on bounce (normal)
const FRICTION     = 0.85;   // speed kept on bounce (tangential)
const MAX_AGE      = 20;     // s before auto-remove
const MAX_BOUNCES  = 30;
const MAX_BALLS    = 30;

const COLORS = [
    0xff3333, 0x33ff88, 0x44aaff,
    0xffaa00, 0xdd44ff, 0x00eeff,
    0xffff33, 0xff88bb,
];

const _dir  = new THREE.Vector3();
const _orig = new THREE.Vector3();

export function createBallShooter(scene, raycastFn) {
    const balls = [];
    let colorIdx = 0;
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 14, 10);

    function shoot(origin, direction) {
        // Drop oldest if at limit
        while (balls.length >= MAX_BALLS) {
            const old = balls.shift();
            scene.remove(old.mesh);
            old.mesh.material.dispose();
        }

        const color = COLORS[colorIdx++ % COLORS.length];
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.3,
            roughness: 0.25,
        }));
        mesh.castShadow = true;
        // Spawn slightly in front of camera so it doesn't clip the view
        mesh.position.copy(origin).addScaledVector(direction, 0.45);
        scene.add(mesh);
        balls.push({ mesh, vel: direction.clone().multiplyScalar(BALL_SPEED), age: 0, bounces: 0 });
    }

    function _stepBall(b, subDt) {
        b.vel.y += GRAVITY * subDt;
        const speed = b.vel.length();
        if (speed < 0.001) return;

        _dir.copy(b.vel).divideScalar(speed);
        // Start ray slightly behind the ball so we catch surfaces it just entered
        _orig.copy(b.mesh.position).addScaledVector(_dir, -BALL_RADIUS);
        const castLen = speed * subDt + BALL_RADIUS * 2;

        const hit = raycastFn(_orig, _dir, castLen);
        const surfaceDist = hit ? hit.distance - BALL_RADIUS : Infinity;

        if (surfaceDist <= speed * subDt + 0.001) {
            b.mesh.position.copy(hit.point).addScaledVector(hit.normal, BALL_RADIUS * 1.05);
            const vn = b.vel.dot(hit.normal);
            if (vn < 0) {
                const nComp = hit.normal.clone().multiplyScalar(vn);
                const tComp = b.vel.clone().sub(nComp);
                b.vel.copy(tComp).multiplyScalar(FRICTION)
                     .addScaledVector(hit.normal, -vn * RESTITUTION);
                b.bounces++;
            }
        } else {
            b.mesh.position.addScaledVector(b.vel, subDt);
        }
    }

    function update(dt) {
        dt = Math.min(dt, 0.05);

        for (let i = balls.length - 1; i >= 0; i--) {
            const b = balls[i];
            b.age += dt;

            if (b.age > MAX_AGE || b.bounces > MAX_BOUNCES) {
                scene.remove(b.mesh);
                b.mesh.material.dispose();
                balls.splice(i, 1);
                continue;
            }

            // Sub-step so a fast ball never travels more than one radius per step
            const speed = b.vel.length();
            const steps = Math.max(1, Math.ceil(speed * dt / BALL_RADIUS));
            const subDt  = dt / steps;
            for (let s = 0; s < steps; s++) _stepBall(b, subDt);
        }
    }

    function clear() {
        for (const b of balls) { scene.remove(b.mesh); b.mesh.material.dispose(); }
        balls.length = 0;
    }

    function dispose() { clear(); geo.dispose(); }

    return { shoot, update, clear, dispose };
}
