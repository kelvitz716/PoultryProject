/** Keeps optional test-account seeding from masking the original failure. */

function handleE2ETestSeedFailure(error, { isProduction, logger = console } = {}) {
    logger.error('Failed to seed E2E test account:', error?.message || 'unknown error');
    if (isProduction !== true) throw error;
}

module.exports = { handleE2ETestSeedFailure };
