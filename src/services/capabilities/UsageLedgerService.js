class UsageLedgerService {
    constructor() {
        this.records = [];
        this.reservations = new Map();
        this.nextReservationId = 1;
    }

    _mode() {
        return String(process.env.CAPABILITY_BILLING_MODE || 'observe').trim().toLowerCase() || 'observe';
    }

    _normalizeActor(context = {}) {
        return {
            userId: String(context.userId || 'system').trim() || 'system',
            tenantId: String(context.tenantId || '').trim(),
            appId: String(context.appId || '').trim(),
            workspaceId: String(context.workspaceId || '').trim()
        };
    }

    reserve({ capabilityId = '', providerId = '', estimatedCostCredits = 0, context = {}, metadata = {} } = {}) {
        const actor = this._normalizeActor(context);
        const reservationId = `usage_res_${this.nextReservationId++}`;
        const record = {
            reservationId,
            capabilityId: String(capabilityId || '').trim(),
            providerId: String(providerId || '').trim(),
            status: this._mode() === 'enforce' ? 'reserved' : 'observed',
            estimatedCostCredits: Math.max(0, Number(estimatedCostCredits || 0)),
            reservedCredits: this._mode() === 'enforce' ? Math.max(0, Number(estimatedCostCredits || 0)) : 0,
            actualCostCredits: 0,
            refundedCredits: 0,
            createdAt: new Date().toISOString(),
            finalizedAt: '',
            mode: this._mode(),
            ...actor,
            metadata: { ...metadata }
        };
        this.reservations.set(reservationId, record);
        this.records.push(record);
        return { ...record, metadata: { ...record.metadata } };
    }

    finalizeReservation(reservationId = '', { actualCostCredits = 0, status = 'succeeded', metadata = {} } = {}) {
        const current = this.reservations.get(String(reservationId || '').trim());
        if (!current) {
            throw new Error(`Unknown reservation: ${reservationId}`);
        }
        current.actualCostCredits = Math.max(0, Number(actualCostCredits || 0));
        current.refundedCredits = Math.max(0, Number(current.reservedCredits || 0) - current.actualCostCredits);
        current.status = String(status || 'succeeded').trim();
        current.finalizedAt = new Date().toISOString();
        current.metadata = { ...current.metadata, ...metadata };
        if (current.status !== 'reserved' && current.status !== 'observed') {
            this.reservations.delete(current.reservationId);
        }
        return { ...current, metadata: { ...current.metadata } };
    }

    listRecords(filter = {}) {
        return this.records
            .filter((record) => {
                if (filter.capabilityId && record.capabilityId !== String(filter.capabilityId)) return false;
                if (filter.userId && record.userId !== String(filter.userId)) return false;
                if (filter.workspaceId && record.workspaceId !== String(filter.workspaceId)) return false;
                return true;
            })
            .map((record) => ({ ...record, metadata: { ...record.metadata } }));
    }

    reset() {
        this.records = [];
        this.reservations.clear();
        this.nextReservationId = 1;
    }
}

export default new UsageLedgerService();