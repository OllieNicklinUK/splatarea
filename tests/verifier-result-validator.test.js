import test from 'node:test';
import assert from 'node:assert/strict';

import verifierResultValidator from '../src/services/VerifierResultValidator.js';

test('VerifierResultValidator parses fenced JSON followed by prose', () => {
    const response = [
        '```json',
        '{',
        '  "status": "fail",',
        '  "reasons": ["App ID not found in bundle"]',
        '}',
        '```',
        '',
        '### Verification Report',
        'Additional prose that should not break JSON parsing.'
    ].join('\n');
    const result = verifierResultValidator.parseAndValidate(response);

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.reasons, ['App ID not found in bundle']);
});
