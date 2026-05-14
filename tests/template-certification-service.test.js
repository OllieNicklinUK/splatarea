import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import templateCertificationService from '../src/services/templates/TemplateCertificationService.js';
import templateContractService from '../src/services/templates/TemplateContractService.js';

test('TemplateCertificationService passes battletanks required-files gate when structural seed files are present', async () => {
    const templateRoot = path.resolve('/Users/casper_wang/Projects/AI/viverse-ai-agent/templates/battletanks-v1');
    const loaded = await templateContractService.loadTemplateContract(templateRoot);
    const gates = await templateCertificationService.runStaticGates({
        templateRoot,
        contract: loaded.contract
    });

    const gate = gates.find((entry) => entry.gate === 'certification.required_files');
    assert.ok(gate);
    assert.equal(gate.status, 'pass');
    assert.equal(String(gate.reason || ''), '');
});
