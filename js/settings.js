/**
 * @file settings.js
 * @description Settings and CRM view module for PoultryDSS.
 * Manages user accounts, guest tokens, own password changes, and buyer lists (CRM).
 */

import { api } from './api.js';
import { store } from './store.js';
import { $, showToast, showConfirmModal } from './ui.js';
import {
    appendCustomerRegistryRow,
    bootstrapIssueMessage,
    canWriteCustomers,
    customerTermsDays,
    newIdempotencyKey
} from './customer-ui-model.mjs';

let legacyBootstrapAttempted = false;
let showInactiveCustomers = false;

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

        showToast('Farm profile saved successfully!');
    });

    // Stable customer registry. Legacy farmProfile.buyers remains read-only input
    // for the server-side bootstrap; this form never rewrites that JSON.
    $('add-buyer-form')?.addEventListener('submit', (e) => {
        void createCustomerFromForm(e);
    });
    $('customer-include-inactive')?.addEventListener('change', event => {
        showInactiveCustomers = event.target.checked;
        void refreshCustomerRegistry();
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
            const res = await api.changePassword(window.CURRENT_USER?.id, nw);
            if (res.success) {
                if (window.CURRENT_USER) {
                    window.CURRENT_USER.mustChangePassword = false;
                }
                overlay.remove();
                showToast('Password updated.', 'success');
                if (window.USER_ROLE === 'farmer') {
                    const activeBatch = store.allBatches.find(b => b.status === BATCH_STATUS.ACTIVE);
                    if (activeBatch) {
                        window.openBatchCockpit(activeBatch.id);
                    } else {
                        window.switchView('batches');
                    }
                }
            }
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

    // Account & Security panel
    if ($('settings-username-display')) {
        $('settings-username-display').textContent = window.CURRENT_USER?.username || '—';
    }
    if ($('settings-role-display')) {
        $('settings-role-display').textContent = window.USER_ROLE || '—';
    }

    void refreshCustomerRegistry();

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
        inputs?.forEach(inp => {
            if (inp.id !== 'customer-include-inactive') inp.disabled = true;
        });
        const submitBtn = settingsView?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.style.display = 'none';
    }
}

function canWriteCustomerRegistry() {
    return canWriteCustomers(window.USER_ROLE);
}

function renderBootstrapResult(result) {
    const container = $('customer-bootstrap-result');
    if (!container) return;
    container.replaceChildren();
    if (!result) return;

    const summary = document.createElement('p');
    summary.style.cssText = 'font-size:13px;margin:0 0 6px;color:var(--text-muted);';
    if (!result.profile_found) {
        summary.textContent = 'No legacy buyer profile was found.';
    } else {
        summary.textContent = `Legacy buyer bootstrap: ${result.imported} imported, ${result.existing} already linked, ${result.issues.length} need review.`;
    }
    container.append(summary);

    if (!result.issues.length) return;
    const guidance = document.createElement('p');
    guidance.style.cssText = 'font-size:12px;margin:0 0 4px;color:var(--warning,#b45309);';
    guidance.textContent = 'Correct the legacy entry by creating a named customer below. Legacy buyer data was not changed.';
    container.append(guidance);
    const issueList = document.createElement('ul');
    issueList.style.cssText = 'margin:0;padding-left:18px;font-size:12px;color:var(--text-muted);';
    result.issues.forEach(issue => {
        const item = document.createElement('li');
        item.textContent = `Entry ${Number(issue.index) + 1}: ${bootstrapIssueMessage(issue)}`;
        issueList.append(item);
    });
    if (result.issues_truncated) {
        const item = document.createElement('li');
        item.textContent = 'Additional entries need review.';
        issueList.append(item);
    }
    container.append(issueList);
}

function renderCustomersList(customers) {
    const list = $('buyers-list');
    if (!list) return;
    list.replaceChildren();
    if (!customers.length) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:var(--text-muted);font-size:13px;';
        empty.textContent = 'No stable customers yet. Named customers are needed for credit sales and future balances.';
        list.append(empty);
        return;
    }

    customers.forEach(customer => {
        const row = appendCustomerRegistryRow(list, customer);
        if (!canWriteCustomerRegistry()) return;
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn btn-sm';
        action.style.cssText = 'padding:2px 6px;';
        action.textContent = customer.is_active ? 'Deactivate' : 'Reactivate';
        action.addEventListener('click', () => {
            void setCustomerActive(customer, !customer.is_active);
        });
        row.append(action);
    });
}

async function refreshCustomerRegistry() {
    const resultContainer = $('customer-bootstrap-result');
    if (resultContainer && !legacyBootstrapAttempted && canWriteCustomerRegistry()) {
        legacyBootstrapAttempted = true;
        try {
            renderBootstrapResult(await store.bootstrapLegacyCustomers());
        } catch (error) {
            resultContainer.textContent = `Legacy buyer bootstrap could not run: ${error.message}`;
            showToast('Legacy buyer bootstrap could not run.', 'danger');
        }
    }
    try {
        const customers = await store.syncCustomers(showInactiveCustomers);
        renderCustomersList(customers);
    } catch (error) {
        const list = $('buyers-list');
        if (list) list.textContent = `Customer registry could not load: ${error.message}`;
        showToast('Customer registry could not load.', 'danger');
    }
}

async function createCustomerFromForm(event) {
    event.preventDefault();
    if (!canWriteCustomerRegistry()) return;
    try {
        await api.createCustomer({
            display_name: $('buyer-name').value,
            contact_phone: $('buyer-phone')?.value.trim() || '',
            payment_terms_days: customerTermsDays($('buyer-terms').value),
            idempotency_key: newIdempotencyKey('customer-create')
        });
        $('add-buyer-form').reset();
        showToast('Customer created.', 'success');
        await refreshCustomerRegistry();
    } catch (error) {
        showToast(`Customer was not created: ${error.message}`, 'danger');
    }
}

async function setCustomerActive(customer, isActive) {
    try {
        if (isActive) {
            await api.updateCustomer(customer.id, {
                is_active: true,
                idempotency_key: newIdempotencyKey('customer-reactivate')
            });
        } else {
            await api.deactivateCustomer(customer.id, newIdempotencyKey('customer-deactivate'));
        }
        showToast(isActive ? 'Customer reactivated.' : 'Customer deactivated.', 'success');
        await refreshCustomerRegistry();
    } catch (error) {
        showToast(`Customer was not updated: ${error.message}`, 'danger');
    }
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
            <tbody id="user-management-table-body"></tbody>
        </table>
        <div id="guest-token-section" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-color);">
            <label style="font-size:0.82rem;opacity:0.65;">Guest Share Link</label>
            <div style="display:flex;gap:8px;margin-top:6px;">
                <input id="guest-token-display" readonly style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid var(--border-color);background:rgba(255,255,255,0.04);color:inherit;font-size:0.8rem;font-family:monospace;" placeholder="Regenerate to create a link">
                <button class="btn btn-secondary btn-sm" id="btn-regen-guest-token">Regenerate</button>
            </div>
            <p style="font-size:0.75rem;opacity:0.45;margin:6px 0 0;">Share this URL with read-only viewers. Regenerating invalidates the old link.</p>
        </div>`;

    const tableBody = container.querySelector('#user-management-table-body');
    const currentUserId = window.CURRENT_USER?.id;
    for (const user of users) {
        const row = document.createElement('tr');
        row.style.borderTop = '1px solid var(--border-color)';

        const usernameCell = document.createElement('td');
        usernameCell.style.cssText = 'padding:8px 10px;font-weight:600;';
        usernameCell.textContent = String(user.username || '');
        if (user.id === currentUserId) {
            const currentUserLabel = document.createElement('span');
            currentUserLabel.style.cssText = 'font-size:0.7rem;opacity:0.5;';
            currentUserLabel.textContent = ' (you)';
            usernameCell.appendChild(currentUserLabel);
        }
        row.appendChild(usernameCell);

        const roleCell = document.createElement('td');
        roleCell.style.cssText = 'padding:8px 10px;';
        if (isSuperAdmin && user.id !== currentUserId) {
            const roleSelect = document.createElement('select');
            roleSelect.className = 'role-select input-sm';
            roleSelect.style.cssText = 'font-size:0.82rem;padding:3px 6px;';
            for (const role of ['farmer', 'viewer', 'admin', 'super_admin']) {
                const option = document.createElement('option');
                option.value = role;
                option.textContent = role;
                option.selected = role === user.role;
                roleSelect.appendChild(option);
            }
            roleSelect.addEventListener('change', async (event) => {
                const res = await api.updateUserRole(user.id, event.target.value);
                if (!res.success) {
                    showToast('Role update failed.', 'error');
                    event.target.value = user.role;
                } else {
                    user.role = event.target.value;
                    showToast('Role updated.', 'success');
                }
            });
            roleCell.appendChild(roleSelect);
        } else {
            const roleLabel = document.createElement('span');
            roleLabel.className = 'pill';
            roleLabel.textContent = String(user.role || '');
            roleCell.appendChild(roleLabel);
        }
        row.appendChild(roleCell);

        const actionsCell = document.createElement('td');
        actionsCell.style.cssText = 'padding:8px 10px;text-align:right;';
        if (user.id !== currentUserId) {
            const activeButton = document.createElement('button');
            activeButton.className = 'btn btn-ghost btn-sm';
            activeButton.style.color = user.is_active ? 'var(--danger)' : 'var(--success)';
            activeButton.textContent = user.is_active ? 'Deactivate' : 'Reactivate';
            activeButton.addEventListener('click', () => window._toggleUserActive(user.id, user.username, user.is_active));
            actionsCell.appendChild(activeButton);
        }
        const passwordButton = document.createElement('button');
        passwordButton.className = 'btn btn-ghost btn-sm';
        passwordButton.textContent = 'Reset PW';
        passwordButton.addEventListener('click', () => window._changeUserPassword(user.id, user.username));
        actionsCell.appendChild(passwordButton);
        row.appendChild(actionsCell);
        tableBody.appendChild(row);
    }
    lucide.createIcons();

    document.getElementById('btn-add-user')?.addEventListener('click', () => _showAddUserModal(() => _renderUserManagementPanel(container)));
    document.getElementById('btn-regen-guest-token')?.addEventListener('click', () => window._regenGuestToken());
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
                </select>
                <p id="nu-role-desc" style="font-size:0.75rem;opacity:0.8;margin:8px 0 0;line-height:1.4;color:var(--text-muted);"></p>
            </div>
            <div id="nu-error" style="display:none;color:#ef4444;font-size:0.82rem;margin-bottom:10px;"></div>
            <div style="display:flex;gap:10px;">
                <button id="nu-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer;">Cancel</button>
                <button id="nu-save" style="flex:2;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:600;cursor:pointer;">Create User</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const roleSelect = overlay.querySelector('#nu-role');
    const roleDesc = overlay.querySelector('#nu-role-desc');
    const descs = {
        farmer: "Can log daily data (eggs, feed, deaths). Cannot manage batches, view financials, or change settings.",
        viewer: "Read-only access. Cannot log any data.",
        admin: "Full access except user role changes."
    };
    const updateRoleDesc = () => {
        roleDesc.textContent = descs[roleSelect.value] || "";
    };
    roleSelect.addEventListener('change', updateRoleDesc);
    updateRoleDesc();

    document.getElementById('nu-cancel').onclick = () => overlay.remove();
    document.getElementById('nu-save').onclick = async () => {
        const username = document.getElementById('nu-username').value.trim();
        const password = document.getElementById('nu-password').value;
        const role = document.getElementById('nu-role').value;
        const errEl = document.getElementById('nu-error');
        if (!username || password.length < 8) { errEl.textContent = 'Username required and password ≥ 8 chars.'; errEl.style.display = 'block'; return; }
        const res = await api.createUser(username, password, role);
        if (res.success) {
            const container = overlay.querySelector('div');
            const originURL = window.location.origin;
            const summaryText = `Farmhand account created\nUsername: ${username}\nPassword: ${password}\nURL: ${originURL}\nNote: They will be prompted to change their password on first login.`;
            
            container.innerHTML = `
                <h3 style="margin:0 0 16px;">Farmhand Account Created</h3>
                <div style="background:rgba(255,255,255,0.04); border:1px solid var(--border-color); border-radius:8px; padding:16px; font-family:monospace; font-size:0.85rem; line-height:1.5; margin-bottom:20px; white-space:pre-wrap; word-break:break-all;">Username: ${username}
Password: ${password}
URL: ${originURL}

Note: They will be prompted to change their password on first login.</div>
                <div style="display:flex; gap:10px;">
                    <button id="nu-copy" class="btn btn-primary" style="flex:1.5; padding:10px; border-radius:8px; font-weight:600;">Copy credentials</button>
                    <button id="nu-close" class="btn btn-secondary" style="flex:1; padding:10px; border-radius:8px;">Close</button>
                </div>
            `;
            
            document.getElementById('nu-copy').onclick = async () => {
                try {
                    await navigator.clipboard.writeText(summaryText);
                    showToast('Credentials copied to clipboard!', 'success');
                } catch (e) {
                    showToast('Failed to copy to clipboard.', 'danger');
                }
            };
            
            document.getElementById('nu-close').onclick = () => {
                overlay.remove();
                if (onSuccess) onSuccess();
            };
        }
        else { errEl.textContent = res.error || 'Failed.'; errEl.style.display = 'block'; }
    };
}

// Bind global functions to window for backward compatibility
window.loadSettingsForm = loadSettingsForm;
window.renderBuyersList = renderCustomersList;

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
