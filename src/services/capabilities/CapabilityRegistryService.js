class CapabilityRegistryService {
    constructor() {
        this.creditRatio = 1000;
        this.capabilities = new Map();
        this._seedDefaults();
    }

    _seedDefaults() {
        const defaults = [
            {
                id: 'readFile',
                kind: 'internal_tool',
                providerId: 'internal',
                subsystem: 'diagnostics',
                billingUnit: 'none',
                chargePolicy: 'free',
                allowedRuntime: ['server'],
                service: 'FileService',
                billing: {
                    enabled: false,
                    userVisibleUnit: 'read',
                    providerCostUsdMicros: 0,
                    markupBasisPoints: 0,
                    platformFeeCredits: 0,
                    minimumChargeCredits: 0
                }
            },
            {
                id: 'writeFile',
                kind: 'internal_tool',
                providerId: 'internal',
                subsystem: 'gameplay',
                billingUnit: 'none',
                chargePolicy: 'free',
                allowedRuntime: ['server'],
                service: 'FileService',
                billing: {
                    enabled: false,
                    userVisibleUnit: 'write',
                    providerCostUsdMicros: 0,
                    markupBasisPoints: 0,
                    platformFeeCredits: 0,
                    minimumChargeCredits: 0
                }
            },
            {
                id: 'runCommand',
                kind: 'internal_tool',
                providerId: 'internal',
                subsystem: 'diagnostics',
                billingUnit: 'none',
                chargePolicy: 'free',
                allowedRuntime: ['server'],
                service: 'FileService',
                billing: {
                    enabled: false,
                    userVisibleUnit: 'command',
                    providerCostUsdMicros: 0,
                    markupBasisPoints: 0,
                    platformFeeCredits: 0,
                    minimumChargeCredits: 0
                }
            },
            {
                id: 'searchRooms',
                kind: 'internal_tool',
                providerId: 'internal',
                subsystem: 'gameplay',
                billingUnit: 'request',
                chargePolicy: 'free',
                allowedRuntime: ['server'],
                service: 'SearchService',
                billing: {
                    enabled: false,
                    userVisibleUnit: 'room_search',
                    providerCostUsdMicros: 0,
                    markupBasisPoints: 0,
                    platformFeeCredits: 0,
                    minimumChargeCredits: 0
                }
            },
            {
                id: 'loadSkill',
                kind: 'internal_tool',
                providerId: 'internal',
                subsystem: 'diagnostics',
                billingUnit: 'none',
                chargePolicy: 'free',
                allowedRuntime: ['server'],
                service: 'SkillProvider',
                billing: {
                    enabled: false,
                    userVisibleUnit: 'skill_load',
                    providerCostUsdMicros: 0,
                    markupBasisPoints: 0,
                    platformFeeCredits: 0,
                    minimumChargeCredits: 0
                }
            },
            {
                id: 'web_search',
                kind: 'external_api',
                providerId: 'brave',
                subsystem: 'gameplay',
                billingUnit: 'request',
                chargePolicy: 'per_request',
                allowedRuntime: ['server', 'lambda'],
                secretRefs: ['BRAVE_SEARCH_API_KEY'],
                billing: {
                    enabled: true,
                    userVisibleUnit: 'search',
                    providerCostUsdMicros: 5000,
                    markupBasisPoints: 10000,
                    platformFeeCredits: 1,
                    minimumChargeCredits: 1
                }
            }
        ];

        defaults.forEach((entry) => {
            this.capabilities.set(entry.id, this._normalizeEntry(entry));
        });
    }

    _normalizeEntry(entry = {}) {
        const billing = entry.billing && typeof entry.billing === 'object' ? entry.billing : {};
        return {
            id: String(entry.id || '').trim(),
            kind: String(entry.kind || 'internal_tool').trim(),
            providerId: String(entry.providerId || 'internal').trim(),
            subsystem: String(entry.subsystem || 'general').trim(),
            billingUnit: String(entry.billingUnit || 'none').trim(),
            chargePolicy: String(entry.chargePolicy || 'free').trim(),
            allowedRuntime: Array.isArray(entry.allowedRuntime) ? entry.allowedRuntime.map((item) => String(item).trim()).filter(Boolean) : ['server'],
            secretRefs: Array.isArray(entry.secretRefs) ? entry.secretRefs.map((item) => String(item).trim()).filter(Boolean) : [],
            service: String(entry.service || '').trim(),
            billing: {
                enabled: billing.enabled === true,
                userVisibleUnit: String(billing.userVisibleUnit || entry.billingUnit || 'request').trim(),
                providerCostUsdMicros: Number.isFinite(Number(billing.providerCostUsdMicros)) ? Number(billing.providerCostUsdMicros) : 0,
                markupBasisPoints: Number.isFinite(Number(billing.markupBasisPoints)) ? Number(billing.markupBasisPoints) : 0,
                platformFeeCredits: Number.isFinite(Number(billing.platformFeeCredits)) ? Number(billing.platformFeeCredits) : 0,
                minimumChargeCredits: Number.isFinite(Number(billing.minimumChargeCredits)) ? Number(billing.minimumChargeCredits) : 0
            }
        };
    }

    listCapabilities() {
        return Array.from(this.capabilities.values()).map((entry) => ({ ...entry }));
    }

    getCapability(capabilityId = '') {
        const key = String(capabilityId || '').trim();
        if (!key) return null;
        const entry = this.capabilities.get(key);
        return entry ? { ...entry, billing: { ...entry.billing } } : null;
    }

    upsertCapability(entry = {}) {
        const normalized = this._normalizeEntry(entry);
        if (!normalized.id) {
            throw new Error('Capability id is required');
        }
        this.capabilities.set(normalized.id, normalized);
        return this.getCapability(normalized.id);
    }

    estimateCredits(capabilityId = '', usage = {}) {
        const capability = this.getCapability(capabilityId);
        if (!capability) {
            throw new Error(`Unknown capability: ${capabilityId}`);
        }
        if (!capability.billing.enabled) {
            return {
                capabilityId: capability.id,
                estimatedCostCredits: 0,
                providerCostUsdMicros: 0,
                usageQuantity: 0,
                billingUnit: capability.billingUnit,
                chargePolicy: capability.chargePolicy
            };
        }

        const usageQuantity = Math.max(0, Number(usage.quantity || 1));
        const providerCostUsdMicros = Math.max(0, capability.billing.providerCostUsdMicros * usageQuantity);
        const markupMultiplier = 1 + (capability.billing.markupBasisPoints / 10000);
        const providerCredits = Math.ceil((providerCostUsdMicros / 1000000) * this.creditRatio);
        const estimatedCostCredits = Math.max(
            capability.billing.minimumChargeCredits,
            Math.ceil(providerCredits * markupMultiplier) + capability.billing.platformFeeCredits
        );

        return {
            capabilityId: capability.id,
            estimatedCostCredits,
            providerCostUsdMicros,
            usageQuantity,
            billingUnit: capability.billingUnit,
            chargePolicy: capability.chargePolicy
        };
    }
}

export default new CapabilityRegistryService();