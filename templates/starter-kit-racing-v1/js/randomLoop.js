function randomInt( min, max ) {

	return Math.floor( Math.random() * ( max - min + 1 ) ) + min;

}

function shuffle( array ) {

	for ( let i = array.length - 1; i > 0; i -- ) {

		const j = Math.floor( Math.random() * ( i + 1 ) );
		[ array[ i ], array[ j ] ] = [ array[ j ], array[ i ] ];

	}

	return array;

}

function cellKey( gx, gz ) {

	return `${ gx },${ gz }`;

}

function buildRectangleLoop( width, height ) {

	const path = [];

	for ( let gx = 0; gx < width; gx ++ ) path.push( { gx, gz: 0 } );
	for ( let gz = 1; gz < height; gz ++ ) path.push( { gx: width - 1, gz } );
	for ( let gx = width - 2; gx >= 0; gx -- ) path.push( { gx, gz: height - 1 } );
	for ( let gz = height - 2; gz >= 1; gz -- ) path.push( { gx: 0, gz } );

	return path;

}

function buildOccupiedSet( path ) {

	return new Set( path.map( ( cell ) => cellKey( cell.gx, cell.gz ) ) );

}

function cardinalNeighbors( gx, gz ) {

	return [
		{ gx, gz: gz - 1 },
		{ gx, gz: gz + 1 },
		{ gx: gx + 1, gz },
		{ gx: gx - 1, gz }
	];

}

function isValidDetourCell( cell, occupied, allowedNeighbors, bounds ) {

	if ( cell.gx < bounds.minX || cell.gx > bounds.maxX || cell.gz < bounds.minZ || cell.gz > bounds.maxZ ) return false;
	if ( occupied.has( cellKey( cell.gx, cell.gz ) ) ) return false;

	for ( const neighbor of cardinalNeighbors( cell.gx, cell.gz ) ) {

		const key = cellKey( neighbor.gx, neighbor.gz );
		if ( occupied.has( key ) && ! allowedNeighbors.has( key ) ) return false;

	}

	return true;

}

function tryExpandEdge( path, edgeIndex, offset, bounds ) {

	const occupied = buildOccupiedSet( path );
	const a = path[ edgeIndex ];
	const b = path[ ( edgeIndex + 1 ) % path.length ];
	const c = { gx: a.gx + offset.dx, gz: a.gz + offset.dz };
	const d = { gx: b.gx + offset.dx, gz: b.gz + offset.dz };

	const allowedForC = new Set( [ cellKey( a.gx, a.gz ), cellKey( d.gx, d.gz ) ] );
	const allowedForD = new Set( [ cellKey( c.gx, c.gz ), cellKey( b.gx, b.gz ) ] );

	if ( ! isValidDetourCell( c, occupied, allowedForC, bounds ) ) return false;
	if ( ! isValidDetourCell( d, occupied, allowedForD, bounds ) ) return false;

	path.splice( edgeIndex + 1, 0, c, d );
	return true;

}

function expandRandomLoop( path, bounds, targetLength ) {

	let guard = 0;

	while ( path.length < targetLength && guard < 400 ) {

		guard ++;
		let inserted = false;
		const edgeIndices = shuffle( Array.from( { length: path.length }, ( _, index ) => index ) );

		for ( const edgeIndex of edgeIndices ) {

			const a = path[ edgeIndex ];
			const b = path[ ( edgeIndex + 1 ) % path.length ];
			const isHorizontal = a.gz === b.gz;
			const offsets = isHorizontal ?
				shuffle( [ { dx: 0, dz: - 1 }, { dx: 0, dz: 1 } ] ) :
				shuffle( [ { dx: - 1, dz: 0 }, { dx: 1, dz: 0 } ] );

			for ( const offset of offsets ) {

				if ( tryExpandEdge( path, edgeIndex, offset, bounds ) ) {

					inserted = true;
					break;

				}

			}

			if ( inserted ) break;

		}

		if ( ! inserted ) break;

	}

	return path;

}

function connectionBits( from, to ) {

	const dx = to.gx - from.gx;
	const dz = to.gz - from.gz;
	if ( dx === 1 ) return 2;
	if ( dx === - 1 ) return 1;
	if ( dz === 1 ) return 4;
	return 8;

}

function maskToTile( mask ) {

	if ( mask === 12 ) return { type: 'track-straight', orient: 0 };
	if ( mask === 3 ) return { type: 'track-straight', orient: 16 };
	if ( mask === 5 ) return { type: 'track-corner', orient: 0 };
	if ( mask === 6 ) return { type: 'track-corner', orient: 16 };
	if ( mask === 10 ) return { type: 'track-corner', orient: 10 };
	if ( mask === 9 ) return { type: 'track-corner', orient: 22 };
	return { type: 'track-straight', orient: 0 };

}

function cycleToCells( path ) {

	const straightIndices = [];

	for ( let i = 0; i < path.length; i ++ ) {

		const prev = path[ ( i - 1 + path.length ) % path.length ];
		const curr = path[ i ];
		const next = path[ ( i + 1 ) % path.length ];
		const mask = connectionBits( curr, prev ) | connectionBits( curr, next );
		if ( mask === 12 || mask === 3 ) straightIndices.push( i );

	}

	const finishIndex = straightIndices[ randomInt( 0, straightIndices.length - 1 ) ];
	const finishCell = path[ finishIndex ];
	const translated = path.map( ( cell ) => ( {
		gx: cell.gx - finishCell.gx,
		gz: cell.gz - finishCell.gz
	} ) );

	return translated.map( ( curr, index ) => {

		const prev = translated[ ( index - 1 + translated.length ) % translated.length ];
		const next = translated[ ( index + 1 ) % translated.length ];
		const mask = connectionBits( curr, prev ) | connectionBits( curr, next );
		const tile = maskToTile( mask );
		return [
			curr.gx,
			curr.gz,
			index === finishIndex ? 'track-finish' : tile.type,
			tile.orient
		];

	} );

}

export function generateRandomLoopCells() {

	const width = randomInt( 4, 6 );
	const height = randomInt( 4, 6 );
	const bounds = { minX: - 8, maxX: 8, minZ: - 8, maxZ: 8 };
	const targetLength = randomInt( 18, 34 );
	const path = expandRandomLoop( buildRectangleLoop( width, height ), bounds, targetLength );

	if ( path.length < 8 ) throw new Error( 'Random loop generation failed' );

	return cycleToCells( path );

}
