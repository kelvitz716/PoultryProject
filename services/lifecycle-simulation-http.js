const { LifecycleSimulationContextError, LifecycleSimulationValidationError } = require('./lifecycle-simulation');

function registerLifecycleSimulationApi(app, { simulationService, requireRole }) {
    app.post('/api/simulator/lifecycle/:batchId', requireRole('super_admin'), async (req, res) => {
        try {
            const result = await simulationService.simulate(req.params.batchId, req.session.userId);
            return res.status(201).json({ success: true, simulation: result });
        } catch (error) {
            if (error instanceof LifecycleSimulationContextError) return res.status(403).json({ error: 'Lifecycle simulation is unavailable' });
            if (error instanceof LifecycleSimulationValidationError || error instanceof TypeError) return res.status(400).json({ error: 'Invalid lifecycle simulation request' });
            return res.status(500).json({ error: 'Lifecycle simulation failed' });
        }
    });
}

module.exports = { registerLifecycleSimulationApi };
