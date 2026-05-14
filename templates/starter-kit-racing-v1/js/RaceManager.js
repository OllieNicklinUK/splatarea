import * as THREE from 'three';

import { CELL_RAW, GRID_SCALE, ORIENT_DEG, TRACK_CELLS } from './Track.js';

const _finishNormal = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();

function formatTime( elapsedMs ) {

	const totalMs = Math.max( 0, Math.floor( elapsedMs ) );
	const minutes = Math.floor( totalMs / 60000 );
	const seconds = Math.floor( ( totalMs % 60000 ) / 1000 );
	const centiseconds = Math.floor( ( totalMs % 1000 ) / 10 );
	return `${ String( minutes ).padStart( 2, '0' ) }:${ String( seconds ).padStart( 2, '0' ) }.${ String( centiseconds ).padStart( 2, '0' ) }`;

}

function getFinishCell( cells ) {

	return ( cells || TRACK_CELLS ).find( ( cell ) => cell[ 2 ] === 'track-finish' ) || TRACK_CELLS.find( ( cell ) => cell[ 2 ] === 'track-finish' );

}

export class RaceManager {

	constructor( { vehicle, cells, lapsToFinish = 3, onUpdate = () => {}, onFinish = () => {} } ) {

		this.vehicle = vehicle;
		this.cells = cells || TRACK_CELLS;
		this.lapsToFinish = Math.max( 1, lapsToFinish );
		this.onUpdate = onUpdate;
		this.onFinish = onFinish;
		this.finishCell = getFinishCell( this.cells );
		this.trackCellSize = CELL_RAW * GRID_SCALE;
		this.startDistanceThreshold = this.trackCellSize * 0.85;
		this.finishCooldownMs = 1500;
		this.reset();

	}

	reset() {

		const finishCell = this.finishCell || getFinishCell( this.cells );
		const orient = finishCell?.[ 3 ] || 0;
		const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
		this.finishCenter = new THREE.Vector3(
			( ( finishCell?.[ 0 ] || 0 ) + 0.5 ) * CELL_RAW * GRID_SCALE,
			0,
			( ( finishCell?.[ 1 ] || 0 ) + 0.5 ) * CELL_RAW * GRID_SCALE
		);
		_finishNormal.set( Math.sin( angle ), 0, Math.cos( angle ) ).normalize();

		this.raceStarted = false;
		this.raceFinished = false;
		this.elapsedMs = 0;
		this.lapCount = 0;
		this.startLineArmed = false;
		this.lastCrossingMs = - Infinity;
		this.prevSignedDistance = - this.startDistanceThreshold;
		this.lastResultKey = '';

		this.emitUpdate();

	}

	update( dt, input ) {

		if ( this.raceFinished ) return;

		const inputMagnitude = Math.abs( input?.x || 0 ) + Math.abs( input?.z || 0 );
		const speed = this.vehicle.modelVelocity.length();

		if ( ! this.raceStarted && ( inputMagnitude > 0.1 || speed > 1 ) ) {

			this.raceStarted = true;

		}

		if ( this.raceStarted ) {

			this.elapsedMs += dt * 1000;

		}

		_tmpVec.copy( this.vehicle.container.position ).sub( this.finishCenter );
		const distanceFromFinish = _tmpVec.length();
		const signedDistance = _tmpVec.dot( _finishNormal );
		const forwardSpeed = this.vehicle.modelVelocity.dot( _finishNormal );

		if ( distanceFromFinish > this.startDistanceThreshold ) {

			this.startLineArmed = true;

		}

		const crossedFinishLine =
			this.startLineArmed &&
			this.raceStarted &&
			this.prevSignedDistance < 0 &&
			signedDistance >= 0 &&
			forwardSpeed > 0.5 &&
			this.elapsedMs - this.lastCrossingMs > this.finishCooldownMs;

		if ( crossedFinishLine ) {

			this.lapCount += 1;
			this.startLineArmed = false;
			this.lastCrossingMs = this.elapsedMs;

			if ( this.lapCount >= this.lapsToFinish ) {

				this.raceFinished = true;
				const totalTimeMs = Math.max( 1, Math.floor( this.elapsedMs ) );
				const scoreValue = Math.max( 1, 10000000 - totalTimeMs );
				this.lastResultKey = `time:${ totalTimeMs }:laps:${ this.lapCount }`;
				this.onFinish( {
					resultKey: this.lastResultKey,
					totalTimeMs,
					displayTime: formatTime( totalTimeMs ),
					scoreValue
				} );

			}

		}

		this.prevSignedDistance = signedDistance;
		this.emitUpdate();

	}

	emitUpdate() {

		this.onUpdate( {
			raceStarted: this.raceStarted,
			raceFinished: this.raceFinished,
			lapCount: this.lapCount,
			lapsToFinish: this.lapsToFinish,
			elapsedMs: this.elapsedMs,
			displayTime: formatTime( this.elapsedMs )
		} );

	}

}
