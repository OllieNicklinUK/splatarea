class PlannerSchemaValidator {
    _normalizeDependsOn(dependsOn) {
        return Array.isArray(dependsOn) ? dependsOn : [];
    }

    validate(rawPlan) {
        const errors = [];
        if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
            return { ok: false, errors: ['Plan must be a JSON object.'] };
        }

        if (typeof rawPlan.isNewProject !== 'boolean') {
            errors.push('Field "isNewProject" must be a boolean.');
        }

        if (!Array.isArray(rawPlan.tasks) || rawPlan.tasks.length === 0) {
            errors.push('Field "tasks" must be a non-empty array.');
            return { ok: false, errors };
        }

        rawPlan.tasks.forEach((task, index) => {
            if (!task || typeof task !== 'object' || Array.isArray(task)) {
                errors.push(`Task ${index} must be an object.`);
                return;
            }
            if (!String(task.id || '').trim()) {
                errors.push(`Task ${index} is missing required field "id".`);
            }
            if (!String(task.role || '').trim()) {
                errors.push(`Task ${index} is missing required field "role".`);
            }
            if (!String(task.prompt || '').trim()) {
                errors.push(`Task ${index} is missing required field "prompt".`);
            }
            if (!Array.isArray(this._normalizeDependsOn(task.dependsOn))) {
                errors.push(`Task ${index} field "dependsOn" must be an array.`);
            }
        });

        return { ok: errors.length === 0, errors };
    }

    buildRetryPrompt({ originalPrompt = '', invalidResponse = '', errors = [] } = {}) {
        const lines = [
            originalPrompt,
            '',
            'PLANNER SCHEMA VALIDATION FAILED.',
            'You must retry and return strict JSON only.',
            'Do not include markdown fences.',
            'Fix these schema errors exactly:'
        ];
        for (const error of errors) lines.push(`- ${error}`);
        if (invalidResponse) {
            lines.push('', 'Previous invalid planner response:', invalidResponse.slice(0, 2000));
        }
        return lines.join('\n');
    }
}

export default new PlannerSchemaValidator();
