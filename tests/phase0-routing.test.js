import test from 'node:test';
import assert from 'node:assert/strict';

import phase0RoutingService from '../src/services/Phase0RoutingService.js';

test('Phase0RoutingService classifies verifier status question as STATUS_QUERY', () => {
    const decision = phase0RoutingService.interpret({
        message: 'is verifier completed',
        history: []
    });

    assert.equal(decision.intentType, 'STATUS_QUERY');
    assert.equal(decision.route, 'PROJECT');
});
