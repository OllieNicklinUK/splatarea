import React, { useState, useEffect, useCallback, useRef } from 'react';

const extractRankings = (res) => {
  if (Array.isArray(res?.ranking)) return res.ranking;
  if (Array.isArray(res?.rankings)) return res.rankings;
  if (Array.isArray(res?.leaderboard_rankings)) return res.leaderboard_rankings;
  if (Array.isArray(res?.data?.ranking)) return res.data.ranking;
  if (Array.isArray(res?.data?.rankings)) return res.data.rankings;
  if (Array.isArray(res?.leaderboard?.ranking)) return res.leaderboard.ranking;
  if (Array.isArray(res?.leaderboard?.rankings)) return res.leaderboard.rankings;
  return [];
};

const LeaderboardManager = ({
  sdk,
  isAuthenticated,
  accessToken,
  appId = '',
  score,
  multiplayerLeaderboardName = 'poker-score',
  singleplayerLeaderboardName = 'poker-score-single',
  activeMode = 'multiplayer',
  gameFinished = false,
  resultKey = ''
}) => {
  const [leaderboard, setLeaderboard] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState('multiplayer');
  const [isOpen, setIsOpen] = useState(false);
  const submittedResultKeyRef = useRef('');
  const dashboardRef = useRef({ token: '', client: null });
  const viewedLeaderboardName = selectedBoard === 'single' ? singleplayerLeaderboardName : multiplayerLeaderboardName;
  const activeLeaderboardName = activeMode === 'single' ? singleplayerLeaderboardName : multiplayerLeaderboardName;

  const getDashboardClient = useCallback(async () => {
    const runtimeAppId = String(appId || '').trim();
    if (!sdk || !isAuthenticated || !accessToken || !runtimeAppId) return null;

    if (dashboardRef.current.client && dashboardRef.current.token === accessToken) {
      return dashboardRef.current.client;
    }

    const DashboardClass = sdk?.gameDashboard || sdk?.GameDashboard;
    if (typeof DashboardClass !== 'function') {
      console.warn('[Leaderboard] gameDashboard SDK unavailable');
      return null;
    }

    const client = new DashboardClass({
      token: accessToken,
      clientId: runtimeAppId,
      baseURL: 'https://www.viveport.com/',
      communityBaseURL: 'https://www.viverse.com/'
    });
    dashboardRef.current = {
      token: accessToken,
      client
    };
    return client;
  }, [accessToken, appId, isAuthenticated, sdk]);

  const fetchLeaderboard = useCallback(async (targetName = viewedLeaderboardName) => {
    if (!sdk || !isAuthenticated || !appId) return;
    try {
      const client = await getDashboardClient();
      if (!client?.getLeaderboard) {
        console.warn('[Leaderboard] gameDashboard leaderboard client unavailable');
        return;
      }

      const configs = [
        { name: targetName, range_start: 0, range_end: 9, region: 'global', time_range: 'alltime', around_user: false },
        { name: targetName, range_start: 0, range_end: 9, region: 'global', time_range: 'alltime', around_user: true },
        { name: targetName, range_start: 0, range_end: 9, region: 'local', time_range: 'alltime', around_user: false }
      ];

      let rankings = [];
      for (const config of configs) {
        const res = await client.getLeaderboard(appId, config);
        rankings = extractRankings(res);
        if (rankings.length > 0) break;
      }

      if (rankings.length === 0 && typeof client.getGuestLeaderboard === 'function') {
        for (const config of configs) {
          const guestConfig = {
            name: config.name,
            range_start: config.range_start,
            range_end: config.range_end,
            region: config.region,
            time_range: config.time_range
          };
          const res = await client.getGuestLeaderboard(appId, guestConfig);
          rankings = extractRankings(res);
          if (rankings.length > 0) break;
        }
      }

      setLeaderboard(rankings);
    } catch (err) {
      console.error('[Leaderboard] Fetch failed:', err);
    }
  }, [appId, getDashboardClient, isAuthenticated, sdk, viewedLeaderboardName]);

  const submitScore = useCallback(async (mode = 'manual') => {
    if (!sdk || !isAuthenticated || !appId || score === 0 || isSubmitting) return;
    if (mode === 'auto' && resultKey && submittedResultKeyRef.current === resultKey) return;
    setIsSubmitting(true);
    try {
      const client = await getDashboardClient();
      if (!client?.uploadLeaderboardScore) {
        console.warn('[Leaderboard] gameDashboard leaderboard client unavailable');
        return;
      }

      const normalizedScore = Math.max(0, Math.floor(Number(score) || 0));
      if (normalizedScore <= 0) return;

      await client.uploadLeaderboardScore(appId, [
        { name: activeLeaderboardName, value: normalizedScore }
      ]);
      console.log('[Leaderboard] Score submitted:', normalizedScore);
      if (mode === 'auto' && resultKey) {
        submittedResultKeyRef.current = resultKey;
      }
      fetchLeaderboard(viewedLeaderboardName);
    } catch (err) {
      console.error('[Leaderboard] Submit failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [sdk, isAuthenticated, appId, score, isSubmitting, getDashboardClient, fetchLeaderboard, activeLeaderboardName, viewedLeaderboardName, resultKey]);

  useEffect(() => {
    if (isAuthenticated && isOpen) {
      fetchLeaderboard(viewedLeaderboardName);
    }
  }, [isAuthenticated, isOpen, fetchLeaderboard, viewedLeaderboardName]);

  useEffect(() => {
    if (activeMode !== 'single' && activeMode !== 'multiplayer') return;
    setSelectedBoard((prev) => (prev === 'single' || prev === 'multiplayer' ? prev : activeMode));
  }, [activeMode]);

  useEffect(() => {
    if (!gameFinished || !resultKey) return;
    submitScore('auto');
  }, [gameFinished, resultKey, submitScore]);

  return (
    <div className="fixed left-3 bottom-3 z-40 pointer-events-auto">
      {isOpen ? (
        <div className="w-[min(20rem,calc(100vw-1.5rem))] bg-black/55 backdrop-blur-xl border border-white/10 p-4 rounded-3xl shadow-2xl">
          <div className="flex justify-between items-center mb-4 gap-3">
            <div>
              <h3 className="text-xs font-black text-white/50 uppercase tracking-widest">Global Ranking</h3>
              <p className="text-[10px] text-white/30 mt-1 uppercase tracking-[0.25em]">Open only when needed</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-9 h-9 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white transition-colors text-sm font-black"
              aria-label="Close leaderboard"
            >
              ×
            </button>
          </div>
          <div className="flex justify-between items-center mb-4 gap-3">
            <div className="flex gap-2">
              <button
                onClick={() => setSelectedBoard('multiplayer')}
                className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide ${
                  selectedBoard === 'multiplayer' ? 'bg-v-accent text-white' : 'bg-white/10 text-white/70'
                }`}
              >
                Multiplayer
              </button>
              <button
                onClick={() => setSelectedBoard('single')}
                className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide ${
                  selectedBoard === 'single' ? 'bg-v-accent text-white' : 'bg-white/10 text-white/70'
                }`}
              >
                Single
              </button>
            </div>
            <button
              onClick={submitScore}
              disabled={isSubmitting}
              className="text-[10px] font-black text-v-accent hover:underline disabled:opacity-50"
            >
              {isSubmitting ? 'SUBMITTING...' : 'SUBMIT SCORE'}
            </button>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
            {leaderboard.length === 0 ? (
              <div className="text-[10px] text-white/30 italic">No entries found...</div>
            ) : (
              leaderboard.map((entry, idx) => (
                <div key={entry.id || idx} className="flex justify-between items-center bg-white/5 p-2 rounded-xl">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-white/20">{idx + 1}</span>
                    <span className="text-xs font-bold text-white truncate max-w-[120px]">
                      {entry.user_name || entry.display_name || entry.username || 'Player'}
                    </span>
                  </div>
                  <span className="text-xs font-black text-v-accent">{entry.score ?? entry.value ?? 0}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="group flex items-center justify-center w-14 h-14 rounded-2xl bg-black/55 backdrop-blur-xl border border-white/10 shadow-2xl hover:bg-black/70 transition-all"
          aria-label="Open leaderboard"
        >
          <span className="absolute inset-0 rounded-2xl bg-v-accent/10 opacity-0 group-hover:opacity-100 transition-opacity" />
          <svg viewBox="0 0 24 24" className="relative z-10 w-6 h-6 fill-none stroke-v-accent stroke-2" aria-hidden="true">
            <path d="M8 21h8" />
            <path d="M12 17v4" />
            <path d="M7 4h10v3a5 5 0 0 1-10 0V4Z" />
            <path d="M7 5H4a3 3 0 0 0 3 4" />
            <path d="M17 5h3a3 3 0 0 1-3 4" />
          </svg>
        </button>
      )}
      <div className="mt-2 pl-1">
        <span className="text-[9px] font-black uppercase tracking-[0.28em] text-white/30">Leaderboard</span>
      </div>
    </div>
  );
};

export default LeaderboardManager;
