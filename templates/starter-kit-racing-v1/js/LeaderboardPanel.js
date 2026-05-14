function extractRankings( response ) {

	if ( Array.isArray( response?.ranking ) ) return response.ranking;
	if ( Array.isArray( response?.rankings ) ) return response.rankings;
	if ( Array.isArray( response?.leaderboard_rankings ) ) return response.leaderboard_rankings;
	if ( Array.isArray( response?.data?.ranking ) ) return response.data.ranking;
	if ( Array.isArray( response?.data?.rankings ) ) return response.data.rankings;
	if ( Array.isArray( response?.leaderboard?.ranking ) ) return response.leaderboard.ranking;
	if ( Array.isArray( response?.leaderboard?.rankings ) ) return response.leaderboard.rankings;
	return [];

}

export class LeaderboardPanel {

	constructor( { root, authController, appId, leaderboardName } ) {

		this.root = root;
		this.authController = authController;
		this.appId = appId;
		this.leaderboardName = leaderboardName;
		this.dashboardCache = { token: '', client: null };
		this.rankings = [];
		this.isOpen = false;
		this.isSubmitting = false;
		this.latestResult = null;
		this.submittedResultKey = '';
		this.buildDom();
		this.render();

	}

	buildDom() {

		this.root.innerHTML = `
			<div class="leaderboard-shell is-collapsed">
				<button class="leaderboard-toggle" type="button" aria-label="Open leaderboard">🏁</button>
				<div class="leaderboard-panel" hidden>
					<div class="leaderboard-header">
						<div>
							<div class="leaderboard-kicker">Global Ranking</div>
							<div class="leaderboard-title">Best Lap Score</div>
						</div>
						<button class="leaderboard-close" type="button" aria-label="Close leaderboard">×</button>
					</div>
					<div class="leaderboard-meta"></div>
					<div class="leaderboard-actions">
						<button class="leaderboard-refresh" type="button">Refresh</button>
						<button class="leaderboard-submit" type="button">Submit Latest</button>
					</div>
					<div class="leaderboard-status"></div>
					<div class="leaderboard-list"></div>
				</div>
			</div>
		`;

		this.shell = this.root.querySelector( '.leaderboard-shell' );
		this.toggleButton = this.root.querySelector( '.leaderboard-toggle' );
		this.panel = this.root.querySelector( '.leaderboard-panel' );
		this.closeButton = this.root.querySelector( '.leaderboard-close' );
		this.refreshButton = this.root.querySelector( '.leaderboard-refresh' );
		this.submitButton = this.root.querySelector( '.leaderboard-submit' );
		this.metaNode = this.root.querySelector( '.leaderboard-meta' );
		this.statusNode = this.root.querySelector( '.leaderboard-status' );
		this.listNode = this.root.querySelector( '.leaderboard-list' );

		this.toggleButton.addEventListener( 'click', () => {

			this.isOpen = ! this.isOpen;
			this.render();
			if ( this.isOpen ) this.fetchLeaderboard();

		} );
		this.closeButton.addEventListener( 'click', () => {

			this.isOpen = false;
			this.render();

		} );
		this.refreshButton.addEventListener( 'click', () => this.fetchLeaderboard() );
		this.submitButton.addEventListener( 'click', () => this.submitLatestResult( 'manual' ) );

	}

	setRaceResult( result ) {

		this.latestResult = result || null;
		if ( result?.resultKey ) {

			this.submitLatestResult( 'auto' );

		}
		this.render();

	}

	async getDashboardClient() {

		const sdk = this.authController.state.sdk;
		if ( ! sdk || ! this.authController.state.isAuthenticated || ! this.appId ) return null;

		const token = await this.authController.getDashboardToken();
		if ( ! token ) return null;

		if ( this.dashboardCache.client && this.dashboardCache.token === token ) {

			return this.dashboardCache.client;

		}

		const DashboardClass = sdk?.gameDashboard || sdk?.GameDashboard;
		if ( typeof DashboardClass !== 'function' ) return null;

		const client = new DashboardClass( {
			token,
			clientId: this.appId,
			baseURL: 'https://www.viveport.com/',
			communityBaseURL: 'https://www.viverse.com/'
		} );

		this.dashboardCache = { token, client };
		return client;

	}

	async fetchLeaderboard() {

		if ( ! this.authController.state.isAuthenticated ) {

			this.statusNode.textContent = 'Sign in to load leaderboard rankings.';
			return;

		}

		try {

			this.statusNode.textContent = 'Loading leaderboard...';
			const client = await this.getDashboardClient();
			if ( ! client?.getLeaderboard ) {

				this.statusNode.textContent = 'Leaderboard SDK unavailable.';
				return;

			}

			const configs = [
				{ name: this.leaderboardName, range_start: 0, range_end: 9, region: 'global', time_range: 'alltime', around_user: false },
				{ name: this.leaderboardName, range_start: 0, range_end: 9, region: 'global', time_range: 'alltime', around_user: true },
				{ name: this.leaderboardName, range_start: 0, range_end: 9, region: 'local', time_range: 'alltime', around_user: false }
			];

			let rankings = [];
			for ( const config of configs ) {

				const response = await client.getLeaderboard( this.appId, config );
				rankings = extractRankings( response );
				if ( rankings.length > 0 ) break;

			}

			if ( rankings.length === 0 && typeof client.getGuestLeaderboard === 'function' ) {

				for ( const config of configs ) {

					const response = await client.getGuestLeaderboard( this.appId, {
						name: config.name,
						range_start: config.range_start,
						range_end: config.range_end,
						region: config.region,
						time_range: config.time_range
					} );
					rankings = extractRankings( response );
					if ( rankings.length > 0 ) break;

				}

			}

			this.rankings = rankings;
			this.statusNode.textContent = rankings.length > 0 ? '' : 'No leaderboard entries found yet.';
			this.renderRankings();

		} catch ( error ) {

			console.error( '[Leaderboard] Fetch failed:', error );
			this.statusNode.textContent = error?.message || 'Failed to load leaderboard.';

		}

	}

	async submitLatestResult( mode = 'manual' ) {

		const result = this.latestResult;
		if ( ! result?.scoreValue ) return;
		if ( ! this.authController.state.isAuthenticated ) {

			this.statusNode.textContent = 'Sign in before submitting leaderboard scores.';
			return;

		}
		if ( this.isSubmitting ) return;
		if ( mode === 'auto' && result.resultKey && this.submittedResultKey === result.resultKey ) return;

		try {

			this.isSubmitting = true;
			this.render();
			this.statusNode.textContent = 'Submitting leaderboard score...';

			const client = await this.getDashboardClient();
			if ( ! client?.uploadLeaderboardScore ) {

				this.statusNode.textContent = 'Leaderboard SDK unavailable.';
				return;

			}

			await client.uploadLeaderboardScore( this.appId, [
				{ name: this.leaderboardName, value: result.scoreValue }
			] );

			this.statusNode.textContent = `Submitted ${ result.scoreValue } for ${ result.displayTime }.`;
			if ( mode === 'auto' && result.resultKey ) {

				this.submittedResultKey = result.resultKey;

			}

			if ( this.isOpen ) {

				await this.fetchLeaderboard();

			}

		} catch ( error ) {

			console.error( '[Leaderboard] Submit failed:', error );
			this.statusNode.textContent = error?.message || 'Failed to submit leaderboard score.';

		} finally {

			this.isSubmitting = false;
			this.render();

		}

	}

	renderRankings() {

		if ( this.rankings.length === 0 ) {

			this.listNode.innerHTML = '<div class="leaderboard-empty">No entries yet.</div>';
			return;

		}

		this.listNode.innerHTML = this.rankings.map( ( entry, index ) => `
			<div class="leaderboard-row">
				<div class="leaderboard-rank">#${ index + 1 }</div>
				<div class="leaderboard-player">${ entry.user_name || entry.display_name || entry.username || 'Player' }</div>
				<div class="leaderboard-score">${ entry.score ?? entry.value ?? 0 }</div>
			</div>
		` ).join( '' );

	}

	render() {

		this.shell.classList.toggle( 'is-collapsed', ! this.isOpen );
		this.panel.hidden = ! this.isOpen;
		this.metaNode.textContent = this.authController.state.isAuthenticated
			? `Signed in as ${ this.authController.state.profile?.displayName || 'VIVERSE Player' }`
			: 'Guest mode. Gameplay works without auth; leaderboard requires sign-in.';
		this.submitButton.disabled = this.isSubmitting || ! this.latestResult || ! this.authController.state.isAuthenticated;
		this.submitButton.textContent = this.isSubmitting ? 'Submitting...' : 'Submit Latest';
		if ( ! this.listNode.innerHTML ) this.renderRankings();

	}

}
