// TrackGenerator.js
// Derives a procedural kart track from a Gaussian Splat collision mesh.
// The floor is extracted from the voxel mesh face normals, the convex hull
// of those floor points is contracted inward to form the racing line, and
// a flat ribbon road + crashcat guardrail bodies are built around the spline.

import * as THREE from 'three';
import { rigidBody, box as physBox, MotionType } from 'crashcat';

// ── Constants ────────────────────────────────────────────────────────────────

const TRACK_WIDTH  = 7;          // metres, full road width
const INSET        = 2.0;        // metres to contract hull before building road
const GUARD_SEGS   = 80;         // guardrail physics boxes per side
const ROAD_SEGMENTS = 200;       // ribbon geometry segments

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * generateProceduralTrack
 *
 * @param {THREE.Group|THREE.Mesh} voxelMesh  - BVH collision mesh from arena-loader
 * @param {number}                 floorY     - world Y of the walkable floor
 * @param {object}                 world      - crashcat physics world
 * @param {THREE.Scene}            scene      - THREE scene to add road meshes into
 * @returns {{ spline, spawnPoint, spawnAngle, dispose } | null}
 */
export function generateProceduralTrack( voxelMesh, floorY, world, scene ) {

  // 1. Extract floor point cloud
  const pts = extractFloorPoints( voxelMesh );
  if ( pts.length < 3 ) return null;

  // 2. Convex hull (CCW)
  let hull = convexHull2D( pts );
  if ( hull.length < 3 ) return null;

  // 3. Contract hull inward
  const contracted = contractPolygon( hull, INSET );
  const finalHull  = contracted !== null ? contracted : hull;

  // 4. Spline along hull
  const spline = buildSpline( finalHull, floorY );

  // 5. Road ribbon
  const roadGeo  = buildRibbonGeo( spline, TRACK_WIDTH / 2, 0.01, ROAD_SEGMENTS );
  const roadMat  = new THREE.MeshStandardMaterial( {
    color:     0x252530,
    roughness: 0.95,
    metalness: 0,
    side:      THREE.DoubleSide,
  } );
  const roadMesh = new THREE.Mesh( roadGeo, roadMat );
  roadMesh.receiveShadow = true;
  scene.add( roadMesh );

  // 6. Centre stripe ribbon
  const stripeGeo  = buildRibbonGeo( spline, 0.12, 0.02, ROAD_SEGMENTS );
  const stripeMat  = new THREE.MeshStandardMaterial( {
    color:       0xffffff,
    roughness:   1.0,
    transparent: true,
    opacity:     0.7,
    side:        THREE.DoubleSide,
  } );
  const stripeMesh = new THREE.Mesh( stripeGeo, stripeMat );
  scene.add( stripeMesh );

  // 7. Guardrail physics bodies
  const guardHalfW = TRACK_WIDTH / 2 + 0.25 + 0.1;
  buildGuardrailBodies( spline, guardHalfW, floorY, world );

  // 8. Spawn
  const p0      = spline.getPoint( 0 );
  const t0      = spline.getTangent( 0 );
  const spawnPoint = new THREE.Vector3( p0.x, floorY + 0.5, p0.z );
  const spawnAngle = Math.atan2( t0.x, t0.z );

  // 9. Dispose helper
  function dispose() {

    scene.remove( roadMesh );
    scene.remove( stripeMesh );
    roadGeo.dispose();
    roadMat.dispose();
    stripeGeo.dispose();
    stripeMat.dispose();

  }

  return { spline, spawnPoint, spawnAngle, dispose };

}

// ── Step 1: Extract floor points from voxel mesh ─────────────────────────────

/**
 * Traverse all child meshes of voxelMesh.
 * For each triangular face, sum the Y components of the three vertex normals.
 * If (sumY / 3) > 0.5 the face is roughly floor-facing.
 * Snap the XZ centroid to a 0.5 m grid and deduplicate via a Map.
 *
 * @param {THREE.Object3D} voxelMesh
 * @returns {THREE.Vector2[]}
 */
export function extractFloorPoints( voxelMesh ) {

  const gridSize  = 0.5;
  const snapMap   = new Map();

  const _vA = new THREE.Vector3();
  const _vB = new THREE.Vector3();
  const _vC = new THREE.Vector3();
  const _nA = new THREE.Vector3();
  const _nB = new THREE.Vector3();
  const _nC = new THREE.Vector3();

  voxelMesh.updateMatrixWorld( true );

  voxelMesh.traverse( ( child ) => {

    if ( ! child.isMesh ) return;

    const geo   = child.geometry;
    const mtx   = child.matrixWorld;

    const posAttr = geo.getAttribute( 'position' );
    const nrmAttr = geo.getAttribute( 'normal' );
    if ( ! posAttr ) return;

    const idx = geo.index;

    const faceCount = idx ? idx.count / 3 : posAttr.count / 3;

    for ( let f = 0; f < faceCount; f ++ ) {

      let ia, ib, ic;
      if ( idx ) {

        ia = idx.getX( f * 3 );
        ib = idx.getX( f * 3 + 1 );
        ic = idx.getX( f * 3 + 2 );

      } else {

        ia = f * 3;
        ib = f * 3 + 1;
        ic = f * 3 + 2;

      }

      _vA.fromBufferAttribute( posAttr, ia ).applyMatrix4( mtx );
      _vB.fromBufferAttribute( posAttr, ib ).applyMatrix4( mtx );
      _vC.fromBufferAttribute( posAttr, ic ).applyMatrix4( mtx );

      let sumY = 0;

      if ( nrmAttr ) {

        _nA.fromBufferAttribute( nrmAttr, ia );
        _nB.fromBufferAttribute( nrmAttr, ib );
        _nC.fromBufferAttribute( nrmAttr, ic );

        // Transform normals by normal matrix (inverse transpose)
        const normalMatrix = new THREE.Matrix3().getNormalMatrix( mtx );
        _nA.applyMatrix3( normalMatrix ).normalize();
        _nB.applyMatrix3( normalMatrix ).normalize();
        _nC.applyMatrix3( normalMatrix ).normalize();

        sumY = ( _nA.y + _nB.y + _nC.y ) / 3;

      } else {

        // Compute face normal from geometry
        const edge1 = _vB.clone().sub( _vA );
        const edge2 = _vC.clone().sub( _vA );
        const faceNormal = new THREE.Vector3().crossVectors( edge1, edge2 ).normalize();
        sumY = faceNormal.y;

      }

      if ( sumY > 0.5 ) {

        // XZ centroid of this face
        const cx = ( _vA.x + _vB.x + _vC.x ) / 3;
        const cz = ( _vA.z + _vB.z + _vC.z ) / 3;

        // Snap to grid
        const gx = Math.round( cx / gridSize );
        const gz = Math.round( cz / gridSize );
        const key = `${ gx },${ gz }`;

        if ( ! snapMap.has( key ) ) {

          snapMap.set( key, new THREE.Vector2( gx * gridSize, gz * gridSize ) );

        }

      }

    }

  } );

  return Array.from( snapMap.values() );

}

// ── Step 2: Convex hull — Graham scan ────────────────────────────────────────

/**
 * Returns the CCW convex hull of a set of 2D points using Graham scan.
 *
 * @param {THREE.Vector2[]} pts
 * @returns {THREE.Vector2[]}
 */
export function convexHull2D( pts ) {

  if ( pts.length < 3 ) return pts.slice();

  // Find pivot: lowest Y, then leftmost X
  let pivot = pts[ 0 ];
  for ( const p of pts ) {

    if ( p.y < pivot.y || ( p.y === pivot.y && p.x < pivot.x ) ) pivot = p;

  }

  // Sort by polar angle from pivot
  const sorted = pts
    .filter( p => p !== pivot )
    .sort( ( a, b ) => {

      const angleA = Math.atan2( a.y - pivot.y, a.x - pivot.x );
      const angleB = Math.atan2( b.y - pivot.y, b.x - pivot.x );
      if ( Math.abs( angleA - angleB ) > 1e-9 ) return angleA - angleB;
      // Tie-break: closer first
      const dA = ( a.x - pivot.x ) ** 2 + ( a.y - pivot.y ) ** 2;
      const dB = ( b.x - pivot.x ) ** 2 + ( b.y - pivot.y ) ** 2;
      return dA - dB;

    } );

  const stack = [ pivot ];

  for ( const p of sorted ) {

    while ( stack.length >= 2 ) {

      const a = stack[ stack.length - 2 ];
      const b = stack[ stack.length - 1 ];
      // Cross product of (b-a) × (p-a) — negative = clockwise, pop
      const cross = ( b.x - a.x ) * ( p.y - a.y ) - ( b.y - a.y ) * ( p.x - a.x );
      if ( cross <= 0 ) stack.pop();
      else break;

    }

    stack.push( p );

  }

  return stack;

}

// ── Step 3: Contract polygon inward ──────────────────────────────────────────

/**
 * Insets each vertex of a CCW polygon inward by `amount` metres.
 * The inward normal at each vertex is derived from the averaged edge tangents.
 * For a CCW polygon, inward normal = rotate tangent 90° CCW: (-ty, tx).
 *
 * Falls back to null if the contracted area < 25 m².
 *
 * @param {THREE.Vector2[]} hull   - CCW polygon
 * @param {number}          amount - inset distance in metres
 * @returns {THREE.Vector2[] | null}
 */
export function contractPolygon( hull, amount ) {

  const n = hull.length;
  const result = [];

  for ( let i = 0; i < n; i ++ ) {

    const prev = hull[ ( i - 1 + n ) % n ];
    const curr = hull[ i ];
    const next = hull[ ( i + 1 ) % n ];

    // Edge tangents (normalised)
    const tIn  = new THREE.Vector2( curr.x - prev.x, curr.y - prev.y ).normalize();
    const tOut = new THREE.Vector2( next.x - curr.x, next.y - curr.y ).normalize();

    // Average tangent
    const tAvg = new THREE.Vector2( tIn.x + tOut.x, tIn.y + tOut.y ).normalize();

    // Inward normal for CCW: rotate tangent 90° CCW → (-ty, tx)
    const inward = new THREE.Vector2( - tAvg.y, tAvg.x );

    result.push( new THREE.Vector2(
      curr.x + inward.x * amount,
      curr.y + inward.y * amount,
    ) );

  }

  // Shoelace area check
  const area = Math.abs( _shoelaceArea( result ) );
  if ( area < 25 ) return null;

  return result;

}

function _shoelaceArea( pts ) {

  let sum = 0;
  const n = pts.length;
  for ( let i = 0; i < n; i ++ ) {

    const a = pts[ i ];
    const b = pts[ ( i + 1 ) % n ];
    sum += ( a.x * b.y ) - ( b.x * a.y );

  }
  return sum / 2;

}

// ── Step 4: Build CatmullRom spline ──────────────────────────────────────────

/**
 * Subsample hull to at most 20 waypoints, lift into 3D at floorY,
 * and wrap into a closed CatmullRomCurve3.
 *
 * @param {THREE.Vector2[]} hull2d
 * @param {number}          floorY
 * @returns {THREE.CatmullRomCurve3}
 */
export function buildSpline( hull2d, floorY ) {

  const MAX_WP = 20;
  let pts2d = hull2d;

  if ( hull2d.length > MAX_WP ) {

    // Subsample evenly
    const step = hull2d.length / MAX_WP;
    pts2d = [];
    for ( let i = 0; i < MAX_WP; i ++ ) {

      pts2d.push( hull2d[ Math.round( i * step ) % hull2d.length ] );

    }

  }

  const pts3d = pts2d.map( p => new THREE.Vector3( p.x, floorY, p.y ) );

  return new THREE.CatmullRomCurve3( pts3d, true, 'catmullrom', 0.5 );

}

// ── Step 5: Ribbon geometry ───────────────────────────────────────────────────

/**
 * Extrudes a flat ribbon along a closed CatmullRomCurve3.
 *
 * @param {THREE.CatmullRomCurve3} spline
 * @param {number}                 halfWidth - half the ribbon width
 * @param {number}                 yOffset   - raise ribbon above floorY
 * @param {number}                 segments  - number of segments along spline
 * @returns {THREE.BufferGeometry}
 */
export function buildRibbonGeo( spline, halfWidth, yOffset, segments ) {

  const up = new THREE.Vector3( 0, 1, 0 );
  const _t  = new THREE.Vector3();
  const _r  = new THREE.Vector3();

  const vertCount = ( segments + 1 ) * 2;
  const positions = new Float32Array( vertCount * 3 );
  const uvs       = new Float32Array( vertCount * 2 );
  const indices   = [];

  for ( let i = 0; i <= segments; i ++ ) {

    const t  = i / segments;
    const pt = spline.getPoint( t );
    spline.getTangent( t, _t );
    _t.normalize();

    _r.crossVectors( _t, up ).normalize();

    const base = i * 2;

    // Left vertex
    positions[ base * 3 ]     = pt.x - _r.x * halfWidth;
    positions[ base * 3 + 1 ] = pt.y + yOffset;
    positions[ base * 3 + 2 ] = pt.z - _r.z * halfWidth;

    // Right vertex
    positions[ ( base + 1 ) * 3 ]     = pt.x + _r.x * halfWidth;
    positions[ ( base + 1 ) * 3 + 1 ] = pt.y + yOffset;
    positions[ ( base + 1 ) * 3 + 2 ] = pt.z + _r.z * halfWidth;

    uvs[ base * 2 ]         = 0;
    uvs[ base * 2 + 1 ]     = t;
    uvs[ ( base + 1 ) * 2 ] = 1;
    uvs[ ( base + 1 ) * 2 + 1 ] = t;

    if ( i < segments ) {

      const a = base;
      const b = base + 1;
      const c = base + 2;
      const d = base + 3;

      // CCW winding — normals point up (+Y)
      indices.push( a, b, c );
      indices.push( b, d, c );

    }

  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
  geo.setAttribute( 'uv',       new THREE.BufferAttribute( uvs, 2 ) );
  geo.setIndex( indices );
  geo.computeVertexNormals();

  return geo;

}

// ── Step 6: Guardrail physics bodies ─────────────────────────────────────────

/**
 * Creates GUARD_SEGS crashcat box bodies along each side of the spline.
 *
 * @param {THREE.CatmullRomCurve3} spline
 * @param {number}                 guardHalfW - lateral offset from spline centre
 * @param {number}                 floorY
 * @param {object}                 world      - crashcat world
 */
export function buildGuardrailBodies( spline, guardHalfW, floorY, world ) {

  const up = new THREE.Vector3( 0, 1, 0 );
  const _pt   = new THREE.Vector3();
  const _ptN  = new THREE.Vector3();
  const _tang = new THREE.Vector3();
  const _right = new THREE.Vector3();

  const GUARD_HEIGHT    = 1.25;  // half-height of guardrail box
  const GUARD_THICKNESS = 0.25;  // half-thickness
  const bodyY = floorY - 0.125 + GUARD_HEIGHT;

  for ( let seg = 0; seg < GUARD_SEGS; seg ++ ) {

    const t0 = seg / GUARD_SEGS;
    const t1 = ( seg + 1 ) / GUARD_SEGS;
    const tM = ( t0 + t1 ) / 2;

    spline.getPoint( tM, _pt );
    spline.getPoint( t0, _ptN );
    const ptEnd = spline.getPoint( t1 );

    // Segment length
    const segLen = _ptN.distanceTo( ptEnd );
    const halfLen = segLen / 2 + 0.1;

    spline.getTangent( tM, _tang );
    _tang.normalize();

    _right.crossVectors( _tang, up ).normalize();

    // Yaw angle from tangent for quaternion
    const yaw = Math.atan2( _tang.x, _tang.z );
    const hy  = Math.sin( yaw / 2 );
    const hw  = Math.cos( yaw / 2 );

    for ( const side of [ - 1, 1 ] ) {

      const px = _pt.x + _right.x * guardHalfW * side;
      const pz = _pt.z + _right.z * guardHalfW * side;

      rigidBody.create( world, {
        shape: physBox.create( { halfExtents: [ GUARD_THICKNESS, GUARD_HEIGHT, halfLen ] } ),
        motionType: MotionType.STATIC,
        objectLayer: world._OL_STATIC,
        position:   [ px, bodyY, pz ],
        quaternion: [ 0, hy, 0, hw ],
        friction:    0.0,
        restitution: 0.2,
      } );

    }

  }

}
