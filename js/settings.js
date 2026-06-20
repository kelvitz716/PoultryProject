/**
 * @file settings.js
 * @description Settings and CRM view module for PoultryDSS.
 * Manages user accounts, guest tokens, own password changes, buyer lists (CRM), and suspense account reconciliation.
 */

import { api } from './api.js';
import { store } from './store.js';
import { BATCH_STATUS } from './engine.js';
import { $, showToast, showConfirmModal } from './ui.js';

export function initSettingsView() {
    // Settings form submission
    $('settings-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const farmProfile = store.farmProfile;
        farmProfile.flockSize = parseInt($('set-flock-size').value);
        farmProfile.defaultFeedPrice = parseInt($('set-feed-price').value);
        farmProfile.sackWeightKg = parseInt($('set-sack-weight').value);
        farmProfile.alertThresholds.minLayRatePercent = parseInt($('set-min-layrate').value);
        farmProfile.alertThresholds.maxFeedConversion = parseFloat($('set-max-fc').value);
        farmProfile.alertThresholds.lowInventoryDays = parseInt($('set-low-inv').value);
        farmProfile.alertThresholds.productionDropPercent = parseInt($('set-prod-drop').value);
        if ($('set-storage-type')) farmProfile.eggStorageType = $('set-storage-type').value;
        if ($('set-sensor-offline-mins')) farmProfile.sensorOfflineMinutes = parseInt($('set-sensor-offline-mins').value);
        if ($('set-telegram-chat-id')) farmProfile.telegramChatId = $('set-telegram-chat-id').value.trim();
        if ($('set-telegram-bot-token')) farmProfile.telegramBotToken = $('set-telegram-bot-token').value.trim();
        
        store.saveFarmProfile(farmProfile);

        // Save M-Pesa credentials
        if ($('set-mpesa-consumer-key')) api.setEntity('mpesa_consumer_key', $('set-mpesa-consumer-key').value.trim());
        if ($('set-mpesa-consumer-secret')) api.setEntity('mpesa_consumer_secret', $('set-mpesa-consumer-secret').value.trim());
        if ($('set-mpesa-passkey')) api.setEntity('mpesa_passkey', $('set-mpesa-passkey').value.trim());
        if ($('set-mpesa-shortcode')) api.setEntity('mpesa_shortcode', $('set-mpesa-shortcode').value.trim());

        showToast('Farm profile saved successfully!');
    });

    // CRM / Add Buyer form submission
    $('add-buyer-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const farmProfile = store.farmProfile;
        if (!farmProfile.buyers) farmProfile.buyers = [];
        farmProfile.buyers.push({
            name: $('buyer-name').value,
            phone: $('buyer-phone') ? $('buyer-phone').value.trim() : '',
            terms: $('buyer-terms').value
        });
        store.saveFarmProfile(farmProfile);
        renderBuyersList();
        _renderReconciliationConsole();
        $('add-buyer-form').reset();
    });

    // Export data click handler
    $('btn-export-data')?.addEventListener('click', async () => {
        const data = {
            poultryFarmProfile: await api.getEntity('poultryFarmProfile', null),
            poultryAggregates: await api.getEntity('poultryAggregates', null),
            poultryProposals: await api.getProposals(),
            poultryBatches: await api.getBatches(),
            poultrySnapshots: await api.getSnapshots()
        };
        
        const batches = data.poultryBatches || [];
        for (const b of batches) {
            data[`poultryLogs_${b.id}`] = await api.getLogs(b.id);
            data[`poultryTx_${b.id}`] = await api.getTransactions(b.id);
            data[`poultryHealth_${b.id}`] = await api.getHealthLogs(b.id);
        }

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `poultry_dss_backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    });

    // Logout click handler
    $('btn-logout')?.addEventListener('click', async () => {
        if (!confirm('Sign out?')) return;
        await api.logout();
        window.location.reload();
    });

    // Change own password click handler
    $('btn-change-own-password')?.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.innerHTML = `
            <div class="modal-content card" style="max-width:360px;padding:24px;position:relative;">
                <button type="button" class="btn btn-secondary btn-sm" style="position:absolute;top:12px;right:12px;" onclick="this.closest('.modal-overlay').remove()">
                    <i data-lucide="x" style="width:14px;height:14px;"></i>
                </button>
                <h3 style="margin:0 0 16px;">Change Password</h3>
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div class="input-group">
                        <label>Current Password</label>
                        <input type="password" id="pw-current" class="input-md">
                    </div>
                    <div class="input-group">
                        <label>New Password</label>
                        <input type="password" id="pw-new" class="input-md" placeholder="≥ 8 characters">
                    </div>
                    <div class="input-group">
                        <label>Confirm New Password</label>
                        <input type="password" id="pw-confirm" class="input-md">
                    </div>
                    <p id="pw-error" style="color:var(--danger);font-size:0.82rem;display:none;"></p>
                    <button id="pw-submit" class="btn btn-primary">Update Password</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        lucide.createIcons();
        document.getElementById('pw-submit').onclick = async () => {
            const cur = document.getElementById('pw-current').value;
            const nw  = document.getElementById('pw-new').value;
            const cnf = document.getElementById('pw-confirm').value;
            const err = document.getElementById('pw-error');
            if (nw.length < 8) { err.textContent = 'New password must be ≥ 8 characters.'; err.style.display = 'block'; return; }
            if (nw !== cnf) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
            const res = await api.changePassword(cur, nw);
            if (res.success) { overlay.remove(); showToast('Password updated.', 'success'); }
            else { err.textContent = res.error || 'Failed.'; err.style.display = 'block'; }
        };
    });
}

export function loadSettingsForm() {
    const p = store.farmProfile;
    $('set-flock-size').value = p.flockSize;
    $('set-feed-price').value = p.defaultFeedPrice;
    $('set-sack-weight').value = p.sackWeightKg;
    $('set-min-layrate').value = p.alertThresholds.minLayRatePercent;
    $('set-max-fc').value = p.alertThresholds.maxFeedConversion;
    $('set-low-inv').value = p.alertThresholds.lowInventoryDays;
    $('set-prod-drop').value = p.alertThresholds.productionDropPercent;
    if($('set-storage-type')) $('set-storage-type').value = p.eggStorageType || 'room';

    // Sensor alert threshold + Telegram Chat ID + Bot Token
    if ($('set-sensor-offline-mins')) $('set-sensor-offline-mins').value = p.sensorOfflineMinutes || 30;
    if ($('set-telegram-chat-id'))   $('set-telegram-chat-id').value   = p.telegramChatId || '';
    if ($('set-telegram-bot-token')) $('set-telegram-bot-token').value = p.telegramBotToken || '';

    // Load M-Pesa configuration keys
    api.getEntity('mpesa_consumer_key', '').then(val => {
        if ($('set-mpesa-consumer-key')) $('set-mpesa-consumer-key').value = val || '';
    });
    api.getEntity('mpesa_consumer_secret', '').then(val => {
        if ($('set-mpesa-consumer-secret')) $('set-mpesa-consumer-secret').value = val || '';
    });
    api.getEntity('mpesa_passkey', '').then(val => {
        if ($('set-mpesa-passkey')) $('set-mpesa-passkey').value = val || '';
    });
    api.getEntity('mpesa_shortcode', '').then(val => {
        if ($('set-mpesa-shortcode')) $('set-mpesa-shortcode').value = val || '';
    });

    // Account & Security panel
    if ($('settings-username-display')) {
        $('settings-username-display').textContent = window.CURRENT_USER?.username || '—';
    }
    if ($('settings-role-display')) {
        $('settings-role-display').textContent = window.USER_ROLE || '—';
    }

    renderBuyersList();
    _renderReconciliationConsole();

    // User Management panel (admin+ only)
    const umContainer = $('user-management-panel')?.querySelector('.card-body') || $('user-management-panel');
    const outerPanel  = $('user-management-panel');
    if (outerPanel && ['admin','super_admin'].includes(window.USER_ROLE)) {
        outerPanel.style.display = 'block';
        if (umContainer) _renderUserManagementPanel(umContainer);
    } else if (outerPanel) {
        outerPanel.style.display = 'none';
    }

    if (window.USER_ROLE === 'viewer') {
        const settingsView = document.getElementById('view-settings');
        const inputs = settingsView?.querySelectorAll('input, select, textarea, button:not(#btn-logout)');
        inputs?.forEach(inp => inp.disabled = true);
        const submitBtn = settingsView?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.style.display = 'none';
    }
}

export function renderBuyersList() {
    const list = $('buyers-list');
    if (!list) return;
    const buyers = store.farmProfile.buyers || [];
    if (buyers.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No buyers added yet.</p>';
        return;
    }
    list.innerHTML = buyers.map((b, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-color); font-size:13px;">
            <div>
                <strong>${b.name}</strong> 
                ${b.phone ? `<span style="color:var(--text-muted); margin-left:8px;">(${b.phone})</span>` : ''}
                <span style="color:var(--text-muted); margin-left:8px;">(${b.terms})</span>
            </div>
            <button type="button" class="btn btn-sm" style="color:var(--danger); padding:2px 6px;" onclick="window.removeBuyer(${i})"><i data-lucide="trash-2" style="width:14px; height:14px;"></i></button>
        </div>
    `).join('');
    lucide.createIcons();
}

async function _renderReconciliationConsole() {
    const card = $('reconciliation-console-card');
    const list = $('reconciliation-list');
    if (!card || !list) return;

    const userRole = window.USER_ROLE;
    if (!['super_admin', 'admin', 'farmer'].includes(userRole)) {
        card.style.display = 'none';
        return;
    }

    const items = await api.getLedgerReconciliation();
    if (items.length === 0) {
        card.style.display = 'block';
        list.innerHTML = '<p style="color:var(--text-muted); font-size:13px; text-align:center; padding:16px;">No pending payments in suspense account.</p>';
        return;
    }

    card.style.display = 'block';
    const buyers = store.farmProfile.buyers || [];
    const isViewerOrFarmer = ['farmer', 'viewer'].includes(userRole) && userRole !== 'super_admin' && userRole !== 'admin';

    list.innerHTML = items.map(item => {
        let optionsHtml = `<option value="">-- Select Destination Account --</option>`;
        optionsHtml += `<option value="4000|Egg Sales">Direct Sale: Egg Sales Revenue (4000)</option>`;
        buyers.forEach(buyer => {
            optionsHtml += `<option value="1200|${buyer.name}">Credit: ${buyer.name} (Accounts Receivable)</option>`;
        });

        const formattedDate = new Date(item.date).toLocaleDateString('en-KE', {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        return `
            <div class="reconciliation-item" style="display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-main); font-size:13px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                    <div>
                        <strong style="color:var(--primary); font-size:14px;">KES ${item.amount.toLocaleString()}</strong>
                        <span style="color:var(--text-muted); margin-left:8px;">Ref: ${item.ref_id}</span>
                        <div style="margin-top:4px; font-weight:500;">${item.description}</div>
                        <div style="color:var(--text-muted); font-size:11px; margin-top:2px;">${formattedDate}</div>
                    </div>
                </div>
                ${isViewerOrFarmer ? `
                    <div style="color:var(--text-muted); font-style:italic; font-size:11px;">Reconciliation actions restricted to Administrators.</div>
                ` : `
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <select class="select-md" style="flex:1; min-width:200px;" id="rec-dest-${item.id}">
                            ${optionsHtml}
                        </select>
                        <button class="btn btn-primary btn-sm" onclick="window.reconcileTransaction('${item.id}')">Reconcile</button>
                    </div>
                `}
            </div>
        `;
    }).join('');
}

async function _renderUserManagementPanel(container) {
    container.innerHTML = '<p style="opacity:0.5;font-size:0.85rem;">Loading users…</p>';
    const users = await api.getUsers();
    const isSuperAdmin = window.USER_ROLE === 'super_admin';
    container.innerHTML = `
        <h4 style="margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;">
            <span><i data-lucide="users" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;"></i>User Accounts</span>
            ${isSuperAdmin ? '<button class="btn btn-secondary btn-sm" id="btn-add-user">+ Add User</button>' : ''}
        </h4>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
            <thead><tr>
                <th style="padding:6px 10px;text-align:left;opacity:0.55;">Username</th>
                <th style="padding:6px 10px;text-align:left;opacity:0.55;">Role</th>
                <th style="padding:6px 10px;text-align:right;opacity:0.55;">Actions</th>
            </tr></thead>
            <tbody>
                ${users.map(u => `
                <tr style="border-top:1px solid var(--border-color);">
                    <td style="padding:8px 10px;font-weight:600;">${u.username}${u.id === window.CURRENT_USER?.id ? ' <span style="font-size:0.7rem;opacity:0.5;">(you)</span>' : ''}</td>
                    <td style="padding:8px 10px;">
                        ${isSuperAdmin && u.id !== window.CURRENT_USER?.id ? `
                        <select data-uid="${u.id}" class="role-select input-sm" style="font-size:0.82rem;padding:3px 6px;">
                            ${['farmer','viewer','admin','super_admin'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
                        </select>
                        ` : `<span class="pill">${u.role}</span>`}
                    </td>
                    <td style="padding:8px 10px;text-align:right;">
                        ${u.id !== window.CURRENT_USER?.id ? `
                            <button class="btn btn-ghost btn-sm" style="color:${u.is_active ? 'var(--danger)' : 'var(--success)'};" onclick="window._toggleUserActive('${u.id}','${u.username}',${u.is_active})">
                                ${u.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>
                        ` : ''}
                        <button class="btn btn-ghost btn-sm" onclick="window._changeUserPassword('${u.id}','${u.username}')">Reset PW</button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>
        <div id="guest-token-section" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-color);">
            <label style="font-size:0.82rem;opacity:0.65;">Guest Share Link</label>
            <div style="display:flex;gap:8px;margin-top:6px;">
                <input id="guest-token-display" readonly style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid var(--border-color);background:rgba(255,255,255,0.04);color:inherit;font-size:0.8rem;font-family:monospace;" placeholder="Regenerate to create a link">
                <button class="btn btn-secondary btn-sm" onclick="window._regenGuestToken()">Regenerate</button>
            </div>
            <p style="font-size:0.75rem;opacity:0.45;margin:6px 0 0;">Share this URL with read-only viewers. Regenerating invalidates the old link.</p>
        </div>`;
    lucide.createIcons();

    // Role change handler
    container.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
            const uid = e.target.dataset.uid;
            const res = await api.updateUserRole(uid, e.target.value);
            if (!res.success) { showToast('Role update failed.', 'error'); e.target.value = users.find(u => u.id == uid)?.role; }
            else showToast('Role updated.', 'success');
        });
    });

    document.getElementById('btn-add-user')?.addEventListener('click', () => _showAddUserModal(() => _renderUserManagementPanel(container)));
}

function _showAddUserModal(onSuccess) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:8000;';
    overlay.innerHTML = `
        <div style="background:var(--card-bg,#1e2535);border-radius:14px;padding:28px 24px;min-width:320px;max-width:94vw;">
            <h3 style="margin:0 0 18px;">Add User</h3>
            <div style="margin-bottom:11px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Username</label>
                <input id="nu-username" type="text" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;"></div>
            <div style="margin-bottom:11px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Password (min 8)</label>
                <input id="nu-password" type="password" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;"></div>
            <div style="margin-bottom:18px;"><label style="font-size:0.8rem;opacity:0.65;display:block;margin-bottom:5px;">Role</label>
                <select id="nu-role" style="width:100%;padding:9px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:inherit;box-sizing:border-box;">
                    <option value="farmer">Farmer</option><option value="viewer">Viewer</option><option value="admin">Admin</option>
                </select></div>
            <div id="nu-error" style="display:none;color:#ef4444;font-size:0.82rem;margin-bottom:10px;"></div>
            <div style="display:flex;gap:10px;">
                <button id="nu-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer;">Cancel</button>
                <button id="nu-save" style="flex:2;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:600;cursor:pointer;">Create User</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    document.getElementById('nu-cancel').onclick = () => overlay.remove();
    document.getElementById('nu-save').onclick = async () => {
        const username = document.getElementById('nu-username').value.trim();
        const password = document.getElementById('nu-password').value;
        const role = document.getElementById('nu-role').value;
        const errEl = document.getElementById('nu-error');
        if (!username || password.length < 8) { errEl.textContent = 'Username required and password ≥ 8 chars.'; errEl.style.display = 'block'; return; }
        const res = await api.createUser(username, password, role);
        if (res.success) { overlay.remove(); showToast('User created.', 'success'); if (onSuccess) onSuccess(); }
        else { errEl.textContent = res.error || 'Failed.'; errEl.style.display = 'block'; }
    };
}

// Bind global functions to window for backward compatibility
window.loadSettingsForm = loadSettingsForm;
window.renderBuyersList = renderBuyersList;
window._renderReconciliationConsole = _renderReconciliationConsole;

window.removeBuyer = function(idx) {
    if (!confirm('Remove this buyer?')) return;
    store.farmProfile.buyers.splice(idx, 1);
    store.saveFarmProfile(store.farmProfile);
    renderBuyersList();
    _renderReconciliationConsole();
};

window.reconcileTransaction = async function(txId) {
    const select = document.getElementById(`rec-dest-${txId}`);
    if (!select || !select.value) {
        showToast('Please select a destination account first.', 'danger');
        return;
    }

    const [targetAccountId, buyerName] = select.value.split('|');
    const activeBatch = store.allBatches.find(b => b.status === BATCH_STATUS.ACTIVE);
    const batchId = activeBatch ? activeBatch.id : null;

    const res = await api.reconcileLedgerTransaction({
        transactionId: txId,
        targetAccountId,
        buyerName,
        batchId
    });

    if (res.success) {
        showToast('Transaction reconciled successfully!', 'success');
        await _renderReconciliationConsole();
        if (store.currentBatchId) {
            const batch = store.allBatches.find(b => String(b.id) === String(store.currentBatchId));
            if (batch) window.refreshCockpitData(batch);
        }
    } else {
        showToast(res.error || 'Failed to reconcile transaction.', 'danger');
    }
};

window._changeUserPassword = function(uid, username) {
    const pw = prompt(`New password for "${username}" (min 8 chars):`);
    if (!pw || pw.length < 8) { showToast('Password too short (min 8).', 'warning'); return; }
    api.changePassword(uid, pw).then(r => showToast(r.success ? 'Password changed.' : (r.error || 'Failed.'), r.success ? 'success' : 'error'));
};

window._toggleUserActive = function(uid, username, currentActive) {
    const action = currentActive ? 'Deactivate' : 'Reactivate';
    if (!confirm(`${action} user "${username}"?`)) return;
    const newActive = currentActive ? 0 : 1;
    api.toggleUserActive(uid, newActive).then(r => {
        if (r.success) {
            showToast(`User "${username}" ${currentActive ? 'deactivated' : 'reactivated'}.`, 'success');
            const umContainer = document.getElementById('user-management-panel')?.querySelector('.card-body') || document.getElementById('user-management-panel');
            if (umContainer) _renderUserManagementPanel(umContainer);
        } else {
            showToast(r.error || 'Failed to update user status.', 'error');
        }
    });
};

window._regenGuestToken = async function() {
    const res = await api.regenerateGuestToken();
    if (res.token) {
        const url = `${window.location.origin}/?guest=${res.token}`;
        const inp = document.getElementById('guest-token-display');
        if (inp) inp.value = url;
        showToast('Guest link regenerated! Copy it above.', 'success');
    } else {
        showToast(res.error || 'Failed to regenerate.', 'error');
    }
};
