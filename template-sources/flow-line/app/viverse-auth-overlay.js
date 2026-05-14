(function () {
    "use strict";

    var APP_HOOK_KEY = "__flowLineApp";
    var PANEL_ID = "flowline-viverse-auth";
    var mounted = false;
    var pollTimer = null;
    var state = {
        authToken: "",
        authResult: null,
        profile: null,
        profileFetchKey: ""
    };

    function installAppHook() {
        if (typeof window === "undefined" || typeof pc === "undefined" || !pc.AppBase || !pc.AppBase.prototype) {
            return;
        }
        if (pc.AppBase.prototype.__flowLineAuthOverlayHooked) {
            return;
        }
        var originalStart = pc.AppBase.prototype.start;
        pc.AppBase.prototype.start = function () {
            window[APP_HOOK_KEY] = this;
            var result = originalStart.apply(this, arguments);
            setTimeout(syncPanel, 0);
            return result;
        };
        pc.AppBase.prototype.__flowLineAuthOverlayHooked = true;
    }

    function panelRoot() {
        return document.getElementById(PANEL_ID);
    }

    function ensurePanel() {
        if (mounted || !document.body) {
            return;
        }
        var root = document.createElement("section");
        root.id = PANEL_ID;
        root.setAttribute("aria-live", "polite");
        root.style.cssText = [
            "position:fixed",
            "left:14px",
            "top:14px",
            "z-index:2147483645",
            "max-width:min(220px, calc(100vw - 28px))",
            "padding:8px 10px",
            "border-radius:999px",
            "background:rgba(7, 12, 24, 0.74)",
            "border:1px solid rgba(130, 210, 255, 0.18)",
            "box-shadow:0 12px 28px rgba(0, 0, 0, 0.22)",
            "backdrop-filter:blur(10px)",
            "color:#f6fbff",
            "font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "transition:transform 160ms ease, opacity 160ms ease, background 160ms ease",
            "pointer-events:auto"
        ].join(";");

        root.innerHTML = ""
            + "<div data-role=\"signedout\" style=\"display:flex;align-items:center;gap:8px;\">"
            + "  <div style=\"width:28px;height:28px;border-radius:999px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:#8fd8ff;font-size:13px;flex:0 0 auto;\">V</div>"
            + "  <button type=\"button\" data-role=\"signin\" style=\"" + buttonStyle() + "\">Connect VIVERSE</button>"
            + "</div>"
            + "<div data-role=\"signedin\" style=\"display:none;align-items:center;gap:10px;min-width:0;\">"
            + "  <img data-role=\"avatar\" alt=\"VIVERSE profile\" style=\"width:30px;height:30px;border-radius:999px;object-fit:cover;background:rgba(255,255,255,0.08);flex:0 0 auto;\" />"
            + "  <div style=\"min-width:0;display:flex;flex-direction:column;gap:2px;\">"
            + "    <div data-role=\"name\" style=\"font-weight:600;font-size:12px;color:#f4fbff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\"></div>"
            + "    <div data-role=\"sub\" style=\"font-size:10px;color:rgba(226,238,255,0.66);\">Connected</div>"
            + "  </div>"
            + "</div>";

        document.body.appendChild(root);
        wirePanel(root);
        mounted = true;
    }

    function buttonStyle() {
        return [
            "appearance:none",
            "border:0",
            "border-radius:999px",
            "padding:8px 12px",
            "font:600 11px/1 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "letter-spacing:0.02em",
            "background:#26b8ff",
            "color:#02151d",
            "cursor:pointer",
            "white-space:nowrap"
        ].join(";");
    }

    function wirePanel(root) {
        root.querySelector('[data-role="signin"]').addEventListener("click", function () {
            var leaderboard = findLeaderboard();
            if (!leaderboard) {
                return;
            }
            var client = leaderboard._authClient;
            if (!client) {
                syncPanel();
                return;
            }
            try {
                if (typeof client.loginWithWorlds === "function") {
                    client.loginWithWorlds({ state: "flowline-" + Date.now() });
                } else if (typeof client.login === "function") {
                    client.login();
                } else {
                    window.open("https://account.htcvive.com/", "_blank", "noopener,noreferrer");
                }
            } catch (error) {
                console.warn("Flow Line auth overlay: sign-in failed", error);
            }
        });

        window.addEventListener("focus", function () {
            refreshAuthState();
        });
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) {
                refreshAuthState();
            }
        });
    }

    function findLeaderboard() {
        var app = window[APP_HOOK_KEY];
        if (!app || !app.root || typeof app.root.findByName !== "function") {
            return null;
        }
        var root = app.root.findByName("Root");
        if (!root || !root.script) {
            return null;
        }
        return root.script.viverseLeaderboard || null;
    }

    function isInGame() {
        var app = window[APP_HOOK_KEY];
        return !!(app && app._flowLineInGame);
    }

    function applyCompactMode(root) {
        if (!root) {
            return;
        }
        if (isInGame()) {
            root.style.top = "10px";
            root.style.left = "10px";
            root.style.padding = "6px 8px";
            root.style.opacity = "0.84";
            root.style.transform = "scale(0.92)";
            root.style.background = "rgba(7, 12, 24, 0.58)";
        } else {
            root.style.top = "14px";
            root.style.left = "14px";
            root.style.padding = "8px 10px";
            root.style.opacity = "1";
            root.style.transform = "scale(1)";
            root.style.background = "rgba(7, 12, 24, 0.74)";
        }
    }

    function isUuidLike(value) {
        return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
    }

    function pickDisplayName(profile, authResult, accountId) {
        var preferred = profile && (
            profile.name ||
            profile.displayName ||
            profile.display_name ||
            profile.nickName ||
            profile.nickname ||
            profile.userName ||
            profile.username
        ) || authResult && (
            authResult.user_name ||
            authResult.display_name ||
            authResult.email ||
            authResult.name
        ) || "";
        if (preferred && !isUuidLike(preferred)) {
            return preferred;
        }
        if (profile && typeof profile.email === "string" && profile.email) {
            return profile.email;
        }
        if (authResult && typeof authResult.email === "string" && authResult.email) {
            return authResult.email;
        }
        return accountId ? "VIVERSE Player" : "Connected";
    }

    function pickAvatarUrl(profile) {
        return profile && (
            profile.picture ||
            profile.activeAvatar && (profile.activeAvatar.headIconUrl || profile.activeAvatar.avatarUrl) ||
            profile.activeAvatar && (profile.activeAvatar.headIconUrl || profile.activeAvatar.avatarUrl) ||
            profile.headIconUrl ||
            profile.head_icon_url ||
            profile.headIcon ||
            profile.profilePicUrl ||
            profile.avatarUrl ||
            profile.avatar_url ||
            profile.snapshot_url ||
            profile.thumbnail_url
        ) || "";
    }

    function setSignedOut() {
        ensurePanel();
        var root = panelRoot();
        if (!root) {
            return;
        }
        root.querySelector('[data-role="signedout"]').style.display = "flex";
        root.querySelector('[data-role="signedin"]').style.display = "none";
        applyCompactMode(root);
    }

    function setSignedIn(name, avatarUrl) {
        ensurePanel();
        var root = panelRoot();
        if (!root) {
            return;
        }
        var avatar = root.querySelector('[data-role="avatar"]');
        var nameNode = root.querySelector('[data-role="name"]');
        root.querySelector('[data-role="signedout"]').style.display = "none";
        root.querySelector('[data-role="signedin"]').style.display = "flex";
        nameNode.textContent = name || "Connected";
        if (avatarUrl) {
            avatar.src = avatarUrl;
            avatar.style.display = "block";
        } else {
            avatar.removeAttribute("src");
            avatar.style.display = "none";
        }
        applyCompactMode(root);
    }

    function syncPanel() {
        ensurePanel();
        var leaderboard = findLeaderboard();
        if (!leaderboard) {
            setSignedOut();
            return;
        }
        if (leaderboard._token) {
            var accountId = state.authResult && state.authResult.account_id ? state.authResult.account_id : "";
            var name = pickDisplayName(state.profile, state.authResult, accountId);
            var avatarUrl = pickAvatarUrl(state.profile);
            setSignedIn(name, avatarUrl);
            fetchProfileIfNeeded(leaderboard);
            return;
        }
        state.authToken = "";
        state.authResult = null;
        state.profile = null;
        state.profileFetchKey = "";
        setSignedOut();
    }

    function createAvatarClient(sdk, accessToken, appId) {
        var AvatarClass = sdk && (sdk.avatar || sdk.Avatar);
        if (!AvatarClass || !accessToken) {
            return null;
        }
        try {
            return new AvatarClass({
                baseURL: "https://sdk-api.viverse.com/",
                accessToken: accessToken,
                token: accessToken,
                authorization: accessToken,
                appId: appId || undefined,
                clientId: appId || undefined
            });
        } catch (error) {
            console.warn("Flow Line auth overlay: avatar client init failed", error);
            return null;
        }
    }

    function fetchProfileIfNeeded(leaderboard) {
        var token = leaderboard && leaderboard._token ? String(leaderboard._token) : "";
        if (!token) {
            return;
        }
        if (state.profile && state.authToken === token) {
            return;
        }
        if (state.profileFetchKey === token) {
            return;
        }
        state.profileFetchKey = token;
        state.authToken = token;
        resolveProfile(leaderboard, token)
            .then(function (profile) {
                if (state.authToken !== token) {
                    return;
                }
                state.profile = profile || {};
                syncPanel();
            })
            .catch(function (error) {
                console.warn("Flow Line auth overlay: profile fetch failed", error);
            })
            .finally(function () {
                if (state.profileFetchKey === token) {
                    state.profileFetchKey = "";
                }
            });
    }

    async function resolveProfile(leaderboard, accessToken) {
        var client = leaderboard && leaderboard._authClient;
        var sdk = leaderboard && typeof leaderboard._detectSdk === "function" ? leaderboard._detectSdk() : null;
        var appId = leaderboard && typeof leaderboard._appId === "function" ? leaderboard._appId() : "";
        var profile = null;

        try {
            var avatarClient = createAvatarClient(sdk, accessToken, appId);
            if (avatarClient && typeof avatarClient.getProfile === "function") {
                var avatarProfile = await avatarClient.getProfile();
                if (avatarProfile && typeof avatarProfile === "object") {
                    profile = Object.assign({}, profile || {}, avatarProfile);
                }
            }
        } catch (error) {
            console.warn("Flow Line auth overlay: avatar getProfile failed", error);
        }

        try {
            if (client && typeof client.getUserInfo === "function") {
                var userInfo = await client.getUserInfo();
                if (userInfo && typeof userInfo === "object") {
                    profile = Object.assign({}, profile || {}, userInfo);
                }
            }
        } catch (error) {
            console.warn("Flow Line auth overlay: getUserInfo failed", error);
        }

        try {
            if ((!profile || !pickAvatarUrl(profile)) && client && typeof client.getUser === "function") {
                var user = await client.getUser();
                if (user && typeof user === "object") {
                    profile = Object.assign({}, profile || {}, user);
                }
            }
        } catch (error) {
            console.warn("Flow Line auth overlay: getUser failed", error);
        }

        try {
            if ((!profile || !pickAvatarUrl(profile)) && client && typeof client.getProfileByToken === "function") {
                var profileByToken = await client.getProfileByToken(accessToken);
                if (profileByToken && typeof profileByToken === "object") {
                    profile = Object.assign({}, profile || {}, profileByToken);
                }
            }
        } catch (error) {
            console.warn("Flow Line auth overlay: getProfileByToken failed", error);
        }

        try {
            if ((!profile || !pickAvatarUrl(profile)) && accessToken) {
                var response = await fetch("https://account-profile.htcvive.com/SS/Profiles/v3/Me", {
                    headers: { Authorization: "Bearer " + accessToken }
                });
                if (response.ok) {
                    var directProfile = await response.json();
                    if (directProfile && typeof directProfile === "object") {
                        profile = Object.assign({}, profile || {}, directProfile);
                    }
                }
            }
        } catch (error) {
            console.warn("Flow Line auth overlay: direct profile API failed", error);
        }

        return profile || {};
    }

    function refreshAuthState() {
        ensurePanel();
        var leaderboard = findLeaderboard();
        if (!leaderboard) {
            setSignedOut();
            return;
        }
        var client = leaderboard._authClient;
        if (!client || typeof client.checkAuth !== "function") {
            syncPanel();
            return;
        }
        Promise.resolve(client.checkAuth())
            .then(function (result) {
                leaderboard._token = result && result.access_token ? result.access_token : null;
                state.authResult = result || null;
                if (!leaderboard._token) {
                    state.authToken = "";
                    state.authResult = null;
                    state.profile = null;
                }
                syncPanel();
            })
            .catch(function (error) {
                leaderboard._token = null;
                state.authToken = "";
                state.authResult = null;
                state.profile = null;
                syncPanel();
                console.warn("Flow Line auth overlay: checkAuth failed", error);
            });
    }

    function startPolling() {
        if (pollTimer) {
            return;
        }
        pollTimer = window.setInterval(function () {
            syncPanel();
            refreshAuthState();
        }, 1200);
        window.setTimeout(function () {
            if (pollTimer) {
                window.clearInterval(pollTimer);
                pollTimer = null;
            }
        }, 30000);
    }

    installAppHook();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            ensurePanel();
            syncPanel();
            refreshAuthState();
            startPolling();
        });
    } else {
        ensurePanel();
        syncPanel();
        refreshAuthState();
        startPolling();
    }
})();
