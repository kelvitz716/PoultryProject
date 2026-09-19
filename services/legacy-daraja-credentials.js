'use strict';

const LEGACY_DARAJA_ENTITY_KEYS = Object.freeze([
    'mpesa_consumer_key',
    'mpesa_consumer_secret',
    'mpesa_passkey',
    'mpesa_shortcode'
]);

const legacyDarajaEntityKeys = new Set(LEGACY_DARAJA_ENTITY_KEYS);

function isLegacyDarajaEntityKey(key) {
    return legacyDarajaEntityKeys.has(key);
}

function purgeLegacyDarajaCredentials(db) {
    const placeholders = LEGACY_DARAJA_ENTITY_KEYS.map(() => '?').join(', ');
    return new Promise((resolve, reject) => {
        db.run(
            `DELETE FROM entities WHERE key IN (${placeholders})`,
            LEGACY_DARAJA_ENTITY_KEYS,
            function onPurge(error) {
                if (error) return reject(error);
                resolve({ deleted: this.changes });
            }
        );
    });
}

module.exports = {
    LEGACY_DARAJA_ENTITY_KEYS,
    isLegacyDarajaEntityKey,
    purgeLegacyDarajaCredentials
};
