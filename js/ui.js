// ui.js - Shared UI components and DOM helpers

export const $ = id => document.getElementById(id);

export function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = 'position:fixed; bottom:20px; right:20px; padding:12px 20px; border-radius:8px; color:#fff; font-weight:500; z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.15); transition: opacity 0.3s, transform 0.3s; transform: translateY(0); opacity: 1;';
    toast.style.background = type === 'danger' ? 'var(--danger)' : type === 'warning' ? '#f59e0b' : 'var(--primary)';
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export function showConfirmModal(message, onConfirm) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; text-align:center; padding:32px;">
            <div style="width:64px; height:64px; background:#fee2e2; color:#dc2626; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px;">
                <i data-lucide="alert-triangle" style="width:32px; height:32px;"></i>
            </div>
            <h3 style="margin-bottom:12px;">Confirm Action</h3>
            <p style="font-size:14px; color:var(--text-muted); margin-bottom:28px;">${message}</p>
            <div style="display:flex; gap:12px; justify-content:center;">
                <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                <button class="btn btn-primary" id="modal-confirm-btn" style="background:var(--danger);">Delete Forever</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (window.lucide) window.lucide.createIcons();
    
    document.getElementById('modal-confirm-btn').onclick = () => {
        document.body.removeChild(modal);
        if (onConfirm) onConfirm();
    };
}

export function updateGlobalNotifications(alerts) {
    const badge = $('notification-badge');
    const container = $('notifications-dropdown');
    if (!container) return;

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
            <h4 style="margin:0; color:var(--text-dark);">Notifications (${alerts.length})</h4>
        </div>
    `;

    if (alerts.length === 0) {
        html += `<p style="margin:0; font-size:13px; color:var(--text-muted); text-align:center; padding:12px 0;">No new alerts for your active batches.</p>`;
        if (badge) badge.style.display = 'none';
    } else {
        alerts.forEach(a => {
            html += `
                <div class="notification-item ${a.type}">
                    <i data-lucide="${a.icon}"></i>
                    <div>
                        <div style="font-weight: 500;">${a.text || a.title}</div>
                        ${a.message ? `<span>${a.message}</span>` : ''}
                    </div>
                </div>
            `;
        });
        if (badge) {
            badge.style.display = 'block';
            badge.innerText = ''; // alerts.length if we want a number
        }
    }
    
    container.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();
}
