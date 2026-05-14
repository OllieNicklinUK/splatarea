import test from 'node:test';
import assert from 'node:assert/strict';

import plannerSchemaValidator from '../src/services/PlannerSchemaValidator.js';

test('PlannerSchemaValidator rejects missing boolean isNewProject and malformed tasks', () => {
    const result = plannerSchemaValidator.validate({
        tasks: [{ role: 'Coder', prompt: 'Build app' }]
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /isNewProject/);
    assert.match(result.errors.join(' '), /missing required field "id"/);
});

test('PlannerSchemaValidator accepts valid planner output', () => {
    const result = plannerSchemaValidator.validate({
        isNewProject: false,
        tasks: [
            { id: 'task_1', role: 'Coder', prompt: 'Build app', dependsOn: [] }
        ]
    });

    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
});
