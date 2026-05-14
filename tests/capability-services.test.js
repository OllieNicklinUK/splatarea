import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import capabilityRegistryService from '../src/services/capabilities/CapabilityRegistryService.js';
import usageLedgerService from '../src/services/capabilities/UsageLedgerService.js';
import capabilityGatewayService from '../src/services/capabilities/CapabilityGatewayService.js';
import skillLedgerService from '../src/services/SkillLedgerService.js';

test('CapabilityRegistryService exposes default hosted capability pricing metadata', () => {
    const capability = capabilityRegistryService.getCapability('web_search');
    assert.ok(capability);
    assert.equal(capability.providerId, 'brave');
    assert.equal(capability.chargePolicy, 'per_request');
    assert.equal(capability.billing.enabled, true);

    const estimate = capabilityRegistryService.estimateCredits('web_search', { quantity: 2 });
    assert.equal(estimate.capabilityId, 'web_search');
    assert.equal(estimate.usageQuantity, 2);
    assert.ok(estimate.estimatedCostCredits >= 1);
});

test('UsageLedgerService observe mode records and finalizes usage without reservations', () => {
    const priorMode = process.env.CAPABILITY_BILLING_MODE;
    process.env.CAPABILITY_BILLING_MODE = 'observe';
    usageLedgerService.reset();

    try {
        const reservation = usageLedgerService.reserve({
            capabilityId: 'web_search',
            providerId: 'brave',
            estimatedCostCredits: 12,
            context: { userId: 'u1', workspaceId: 'ws1' }
        });

        assert.equal(reservation.status, 'observed');
        assert.equal(reservation.reservedCredits, 0);

        const finalized = usageLedgerService.finalizeReservation(reservation.reservationId, {
            actualCostCredits: 7,
            status: 'succeeded'
        });

        assert.equal(finalized.actualCostCredits, 7);
        assert.equal(finalized.refundedCredits, 0);
        assert.equal(usageLedgerService.listRecords({ userId: 'u1' }).length, 1);
    } finally {
        usageLedgerService.reset();
        if (priorMode === undefined) delete process.env.CAPABILITY_BILLING_MODE;
        else process.env.CAPABILITY_BILLING_MODE = priorMode;
    }
});

test('CapabilityGatewayService delegates writeFile without changing existing file semantics', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-capability-gateway-'));
    const priorMode = process.env.CAPABILITY_BILLING_MODE;
    process.env.CAPABILITY_BILLING_MODE = 'observe';
    usageLedgerService.reset();

    try {
        const result = await capabilityGatewayService.executeTool({
            name: 'writeFile',
            args: { filePath: 'notes/output.txt', content: 'gateway write ok' },
            workspacePath,
            role: 'assistant',
            taskId: 'task-1',
            provider: 'test-provider',
            userId: 'user-1'
        });

        assert.deepEqual(result, { success: true, path: 'notes/output.txt' });
        const written = await fs.readFile(path.join(workspacePath, 'notes/output.txt'), 'utf8');
        assert.equal(written, 'gateway write ok');

        const records = usageLedgerService.listRecords({ workspaceId: workspacePath });
        assert.equal(records.length, 1);
        assert.equal(records[0].capabilityId, 'writeFile');
        assert.equal(records[0].status, 'succeeded');
    } finally {
        usageLedgerService.reset();
        if (priorMode === undefined) delete process.env.CAPABILITY_BILLING_MODE;
        else process.env.CAPABILITY_BILLING_MODE = priorMode;
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('CapabilityGatewayService preserves loadSkill ledger behavior on missing skill', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-capability-skill-'));
    const priorMode = process.env.CAPABILITY_BILLING_MODE;
    process.env.CAPABILITY_BILLING_MODE = 'observe';
    usageLedgerService.reset();

    try {
        const beforeEntries = skillLedgerService.getEntries(workspacePath);
        assert.equal(beforeEntries.length, 0);

        const result = await capabilityGatewayService.executeTool({
            name: 'loadSkill',
            args: { skillName: 'missing-skill', fileName: 'SKILL.md' },
            workspacePath,
            role: 'assistant',
            taskId: 'task-2',
            provider: 'test-provider',
            userId: 'user-2'
        });

        assert.deepEqual(result, { error: 'Skill not found' });
        const entries = skillLedgerService.getEntries(workspacePath);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].success, false);
        assert.equal(entries[0].taskId, 'task-2');

        const records = usageLedgerService.listRecords({ workspaceId: workspacePath });
        assert.equal(records.length, 1);
        assert.equal(records[0].status, 'succeeded');
    } finally {
        usageLedgerService.reset();
        if (priorMode === undefined) delete process.env.CAPABILITY_BILLING_MODE;
        else process.env.CAPABILITY_BILLING_MODE = priorMode;
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});