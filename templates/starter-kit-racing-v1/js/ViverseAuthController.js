import { VIVERSE_CONFIG } from './viverseConfig.js';

function delay( ms ) {

	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );

}

function detectSdkGlobal() {

	return window.viverse || window.VIVERSE_SDK || window.vSdk || null;

}

function normalizeProfile( raw ) {

	if ( ! raw || typeof raw !== 'object' ) return null;

	const looksLikeUuid = ( value ) =>
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test( value.trim() );

	const preferredName =
		raw.displayName ||
		raw.display_name ||
		raw.name ||
		raw.nickName ||
		raw.nickname ||
		raw.userName ||
		raw.email ||
		'';

	const displayName = preferredName && ! looksLikeUuid( preferredName ) ? preferredName : 'VIVERSE Player';
	const avatarUrl =
		raw.activeAvatar?.headIconUrl ||
		raw.activeAvatar?.head_icon_url ||
		raw.headIconUrl ||
		raw.head_icon_url ||
		raw.avatarUrl ||
		raw.avatar_url ||
		raw.profilePicUrl ||
		'';

	return {
		displayName,
		avatarUrl,
		userId: raw.account_id || raw.accountId || raw.id || raw.sub || '',
		raw
	};

}

export class ViverseAuthController {

	constructor( { onStateChange = () => {} } = {} ) {

		this.onStateChange = onStateChange;
		this.state = {
			sdk: null,
			authClient: null,
			profile: null,
			accessToken: '',
			isAuthenticated: false,
			status: 'detecting',
			error: '',
			appId: VIVERSE_CONFIG.clientId,
			versionName: VIVERSE_CONFIG.versionName
		};

	}

	setState( patch ) {

		this.state = { ...this.state, ...patch };
		this.onStateChange( { ...this.state } );

	}

	async initialize() {

		try {

			console.log( `[AuthFlow] Bootstrap version: ${ VIVERSE_CONFIG.versionName }` );

			const sdk = await this.detectSdk();
			this.setState( { sdk, status: 'handshaking' } );

			await delay( 1200 );
			console.log( '[AuthFlow] Mandatory handshake delay completed (1200ms)' );

			if ( sdk.bridge?.isReady === false ) {

				console.log( '[AuthFlow] Bridge not ready after delay; continuing with guarded auth checks' );

			}

			if ( ! this.state.appId ) {

				this.setState( {
					status: 'ready',
					error: 'Missing VIVERSE App ID. Set window.__STARTER_KIT_RACING_CONFIG__.clientId before testing auth.'
				} );
				return;

			}

			const authClient = this.createAuthClient( sdk );
			if ( ! authClient ) throw new Error( 'VIVERSE auth client unavailable' );

			this.setState( { authClient, status: 'checking_auth' } );

			const authResult = await authClient.checkAuth();
			const accessToken = authResult?.access_token || authResult?.accessToken || '';
			const isAuthenticated = Boolean(
				authResult?.is_authenticated ??
				authResult?.isAuthenticated ??
				authResult?.authenticated ??
				authResult?.account_id ??
				authResult?.accountId ??
				accessToken
			);

			this.setState( { accessToken, isAuthenticated } );

			if ( isAuthenticated ) {

				if ( sdk.bridge?.isReady === false ) {

					await delay( 500 );

				}

				const profile = await this.fetchProfile( authClient, accessToken, authResult, sdk );
				this.setState( { profile: profile || normalizeProfile( authResult ) } );

			}

			this.setState( { status: 'ready' } );

		} catch ( error ) {

			console.error( '[AuthFlow] Initialization failed:', error );
			this.setState( { status: 'failed', error: error?.message || 'Auth bootstrap failed' } );

		}

	}

	async detectSdk() {

		const startedAt = Date.now();
		const timeoutMs = 30000;

		return new Promise( ( resolve, reject ) => {

			const tick = () => {

				const sdk = detectSdkGlobal();
				if ( sdk ) {

					console.log( `[AuthFlow] SDK detected after ${ Date.now() - startedAt }ms` );
					resolve( sdk );
					return;

				}

				if ( Date.now() - startedAt > timeoutMs ) {

					reject( new Error( 'SDK Detection Timeout' ) );
					return;

				}

				requestAnimationFrame( tick );

			};

			tick();

		} );

	}

	createAuthClient( sdk ) {

		const ClientClass = sdk?.client || sdk?.Client;
		if ( typeof ClientClass !== 'function' ) return null;

		return new ClientClass( {
			clientId: this.state.appId,
			domain: 'account.htcvive.com'
		} );

	}

	async fetchProfile( client, token, authData, sdk ) {

		let merged = null;
		const merge = ( value ) => {

			if ( ! value || typeof value !== 'object' ) return;
			merged = merged ? { ...merged, ...value } : { ...value };

		};
		const hasIdentity = ( profile ) =>
			Boolean(
				profile?.displayName ||
				profile?.display_name ||
				profile?.name ||
				profile?.nickName ||
				profile?.nickname ||
				profile?.userName ||
				profile?.email
			);
		const hasAvatar = ( profile ) =>
			Boolean(
				profile?.activeAvatar?.headIconUrl ||
				profile?.activeAvatar?.head_icon_url ||
				profile?.headIconUrl ||
				profile?.head_icon_url ||
				profile?.avatarUrl ||
				profile?.avatar_url ||
				profile?.profilePicUrl
			);
		const needsMoreProfile = ( profile ) => ! profile || ! hasIdentity( profile ) || ! hasAvatar( profile );

		merge( authData );

		const AvatarClass = sdk?.avatar || sdk?.Avatar;
		if ( token && typeof AvatarClass === 'function' ) {

			try {

				const avatarClient = new AvatarClass( {
					baseURL: 'https://sdk-api.viverse.com/',
					accessToken: token,
					token,
					authorization: token,
					appId: this.state.appId,
					clientId: this.state.appId
				} );
				merge( await avatarClient.getProfile() );

			} catch ( error ) {

				console.warn( '[AuthFlow] avatar.getProfile failed:', error );

			}

		}

		if ( needsMoreProfile( merged ) && typeof client?.getUserInfo === 'function' ) {

			try {

				merge( await client.getUserInfo() );

			} catch ( error ) {

				console.warn( '[AuthFlow] client.getUserInfo failed:', error );

			}

		}

		if ( needsMoreProfile( merged ) && typeof client?.getUser === 'function' ) {

			try {

				merge( await client.getUser() );

			} catch ( error ) {

				console.warn( '[AuthFlow] client.getUser failed:', error );

			}

		}

		if ( needsMoreProfile( merged ) && typeof client?.getProfileByToken === 'function' && token ) {

			try {

				merge( await client.getProfileByToken( token ) );

			} catch ( error ) {

				console.warn( '[AuthFlow] client.getProfileByToken failed:', error );

			}

		}

		if ( needsMoreProfile( merged ) && token && window.self === window.top ) {

			try {

				const response = await fetch( 'https://account-profile.htcvive.com/SS/Profiles/v3/Me', {
					headers: {
						Authorization: `Bearer ${ token }`
					}
				} );

				if ( response.ok ) {

					merge( await response.json() );

				}

			} catch ( error ) {

				console.warn( '[AuthFlow] direct profile API failed:', error );

			}

		}

		return normalizeProfile( merged );

	}

	async login() {

		const client = this.state.authClient;
		if ( ! client ) return;

		if ( typeof client.loginWithWorlds === 'function' ) {

			await client.loginWithWorlds();
			return;

		}

		if ( typeof client.loginWithAuthPage === 'function' ) {

			await client.loginWithAuthPage();
			return;

		}

		if ( typeof client.login === 'function' ) {

			await client.login();
			return;

		}

		window.open( 'https://account.htcvive.com/', '_blank', 'noopener,noreferrer' );

	}

	async logout() {

		try {

			if ( typeof this.state.authClient?.logout === 'function' ) {

				await this.state.authClient.logout();

			}

		} finally {

			this.setState( {
				profile: null,
				accessToken: '',
				isAuthenticated: false
			} );

		}

	}

	async getDashboardToken() {

		const fallback = this.state.accessToken;
		const client = this.state.authClient;
		if ( typeof client?.getToken !== 'function' ) return fallback;

		try {

			const result = await client.getToken();
			return typeof result === 'string' ? result : ( result?.access_token || fallback );

		} catch ( error ) {

			console.warn( '[Leaderboard] authClient.getToken failed:', error );
			return fallback;

		}

	}

}
