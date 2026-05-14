import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

test('template leaderboard integration uses gameDashboard instead of legacy sdk.leaderboard constructor', async () => {
    const filePath = path.join(
        process.cwd(),
        'templates',
        'redpointfish-v1',
        'src',
        'components',
        'LeaderboardManager.jsx'
    );
    const source = await fs.readFile(filePath, 'utf8');

    assert.match(source, /gameDashboard|GameDashboard/);
    assert.match(source, /uploadLeaderboardScore/);
    assert.match(source, /getLeaderboard/);
    assert.doesNotMatch(source, /sdk\?\.leaderboard|sdk\?\.Leaderboard/);
    assert.doesNotMatch(source, /new\s+LeaderboardCtor/);
});
