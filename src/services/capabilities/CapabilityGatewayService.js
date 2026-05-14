import fs from 'fs';
import path from 'path';

import fileService from '../FileService.js';
import searchService from '../SearchService.js';
import skillProvider from '../SkillProvider.js';
import skillLedgerService from '../SkillLedgerService.js';

import capabilityRegistryService from './CapabilityRegistryService.js';
import usageLedgerService from './UsageLedgerService.js';

class CapabilityGatewayService {
    async executeTool({
        name = '',
        args = {},
        workspacePath = '',
        role = '',
        taskId = '',
        provider = '',
        userId = 'system',
        tenantId = '',
        appId = ''
    } = {}) {
        const capability = capabilityRegistryService.getCapability(name);
        if (!capability) {
            throw new Error(`Unsupported capability: ${name}`);
        }

        const estimate = capabilityRegistryService.estimateCredits(name, { quantity: 1, args });
        const reservation = usageLedgerService.reserve({
            capabilityId: capability.id,
            providerId: capability.providerId,
            estimatedCostCredits: estimate.estimatedCostCredits,
            context: {
                userId,
                tenantId,
                appId,
                workspaceId: workspacePath
            },
            metadata: {
                role: String(role || '').trim(),
                taskId: String(taskId || '').trim(),
                provider: String(provider || '').trim()
            }
        });

        try {
            let result;
            if (name === 'readFile') {
                result = await fileService.readFile(args.filePath, workspacePath);
            } else if (name === 'writeFile') {
                result = await fileService.writeFile(args.filePath, args.content, workspacePath);
            } else if (name === 'listFiles') {
                result = await fileService.listFiles(args.dirPath, workspacePath);
            } else if (name === 'runCommand') {
                result = await fileService.runCommand(args.command, args.cwd, workspacePath);
            } else if (name === 'runBackgroundCommand') {
                result = await fileService.runBackgroundCommand(args.command, args.cwd, workspacePath);
            } else if (name === 'checkCommandStatus') {
                result = await fileService.checkCommandStatus(args.jobId, args.cwd, workspacePath);
            } else if (name === 'discoverProject') {
                result = { root: await fileService.listFiles(args.projectName, workspacePath) };
            } else if (name === 'searchRooms') {
                result = await searchService.searchRooms(args);
            } else if (name === 'readDoc') {
                const docPath = path.resolve(process.cwd(), 'docs', args.fileName);
                result = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : { error: 'Doc not found' };
            } else if (name === 'loadSkill') {
                try {
                    const loaded = await skillProvider.loadSkill(args.skillName, args.fileName);
                    skillLedgerService.record(workspacePath, {
                        taskId,
                        role,
                        requestedRef: `${String(args.skillName || '')}/${String(args.fileName || '')}`,
                        canonicalRef: loaded.canonicalRef,
                        resolvedPath: loaded.resolvedPath,
                        success: true
                    });
                    result = loaded.content;
                } catch (error) {
                    let canonicalRef = '';
                    try {
                        canonicalRef = skillProvider.canonicalizeRef(args.skillName, args.fileName);
                    } catch {
                        canonicalRef = '';
                    }
                    skillLedgerService.record(workspacePath, {
                        taskId,
                        role,
                        requestedRef: `${String(args.skillName || '')}/${String(args.fileName || '')}`,
                        canonicalRef,
                        resolvedPath: '',
                        success: false,
                        error: String(error?.message || 'Skill not found')
                    });
                    result = { error: 'Skill not found' };
                }
            } else {
                throw new Error(`Unsupported execution path: ${name}`);
            }

            usageLedgerService.finalizeReservation(reservation.reservationId, {
                actualCostCredits: estimate.estimatedCostCredits,
                status: 'succeeded'
            });
            return result;
        } catch (error) {
            usageLedgerService.finalizeReservation(reservation.reservationId, {
                actualCostCredits: 0,
                status: 'failed',
                metadata: {
                    error: String(error?.message || error)
                }
            });
            throw error;
        }
    }
}

export default new CapabilityGatewayService();