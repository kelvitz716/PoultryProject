/**
 * @file dashboard.js
 * @description Dashboard view module for PoultryDSS.
 * Manages the main dashboard overview, saved proposals lists, active batch summaries, and outstanding accounts receivable.
 */

import { api } from './api.js';
import { store } from './store.js';
import { BATCH_STATUS } from './engine.js';
import { $ } from './ui.js';

export function initDashboardView() {
    console.log('Initializing Dashboard View...');
}

// Bind to window for global compatibility
window.refreshDashboard = async function() {
    const proposals = await api.getProposals();
    const batches = window.getBatches().filter(b => b.status === BATCH_STATUS.ACTIVE);
    
    const list = $('saved-proposals-list');
    const batchSummary = $('active-batches-summary');
    const empty = $('empty-proposals');
    
    const totalBirdsProposals = proposals.reduce((sum, p) => sum + (parseInt(p.size) || 0), 0);
    const totalBirdsBatches = batches.reduce((sum, b) => sum + (parseInt(b.stats?.birdsAlive) || 0), 0);

    if ($('dash-count')) $('dash-count').textContent = proposals.length;
    if ($('dash-birds')) $('dash-birds').textContent = (totalBirdsProposals + totalBirdsBatches).toLocaleString();
    if ($('dashboard-subtitle')) $('dashboard-subtitle').textContent = `Tracking ${proposals.length} models and ${batches.length} active operations.`;

    // Proposals List
    if (!list) return;
    if (proposals.length === 0) {
        list.innerHTML = '';
        if (empty) { list.appendChild(empty); empty.style.display = 'block'; }
    } else {
        list.innerHTML = proposals.map(p => `
            <div class="project-item" data-id="${p.id}" onclick="window.loadProposal(${p.id});">
                <div class="project-icon ${p.type}"><i data-lucide="${p.type === 'layer' ? 'egg' : 'bird'}"></i></div>
                <div class="project-info">
                    <h4>${p.name || 'Untitled'}</h4>
                    <p>${p.size ? p.size + ' birds' : '—'} &nbsp;·&nbsp; ${p.profit || 'KES 0'}</p>
                    <div style="margin-top:4px;">
                        <span class="pill" style="font-size:9px; background:${p.profit?.includes('-') ? 'rgba(239,83,80,0.1)' : 'rgba(91,191,79,0.1)'}; color:${p.profit?.includes('-') ? 'var(--danger)' : 'var(--primary)'}; border: 1px solid ${p.profit?.includes('-') ? 'rgba(239,83,80,0.2)' : 'rgba(91,191,79,0.2)'};">
                            ${p.profit?.includes('-') ? 'OPTIMIZABLE' : 'PROFITABLE'}
                        </span>
                    </div>
                </div>
                <div class="project-actions" style="display:flex; gap:4px;">
                    <button class="project-delete" onclick="event.stopPropagation(); window.cloneProposal(${p.id})" title="Clone Proposal">
                        <i data-lucide="copy" style="width:14px;height:14px;"></i>
                    </button>
                    <button class="project-delete" onclick="event.stopPropagation(); window.deleteProposal(${p.id})" title="Delete">
                        <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Active Batches Summary (guard against cached pages missing this element)
    if (batchSummary) {
        if (batches.length === 0) {
            batchSummary.innerHTML = `<div class="empty-state"><i data-lucide="activity"></i><p>No active operations.</p></div>`;
        } else {
            batchSummary.innerHTML = batches.map(b => `
                <div class="project-item" onclick="window.openBatchCockpit(${b.id})">
                    <div class="project-icon" style="background:#E8F5E9; color:#2E7D32;"><i data-lucide="zap"></i></div>
                    <div class="project-info">
                        <h4>${b.name}</h4>
                        <p>${b.size} birds • Started ${new Date(b.startDate).toLocaleDateString()}</p>
                    </div>
                </div>
            `).join('');
        }
    }

    // Accounts Receivable (Outstanding Credit Sales)
    const arListEl = $('ar-list');
    if (arListEl) {
        let allUnpaid = [];
        for (const b of batches) {
            const txs = await api.getTransactions(b.id);
            const unpaid = txs.filter(t => t.status === 'unpaid' && t.type === 'sale');
            unpaid.forEach(t => { t.batchName = b.name; t.batchId = b.id; });
            allUnpaid = allUnpaid.concat(unpaid);
        }
        
        if (allUnpaid.length === 0) {
            arListEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No outstanding credit invoices.</p>';
        } else {
            // Sort by date oldest first
            allUnpaid.sort((a, b) => new Date(a.date) - new Date(b.date));
            arListEl.innerHTML = allUnpaid.map(t => {
                const txDate = new Date(t.date);
                const termsDays = parseInt((t.buyerTerms || '').replace('Net ', '')) || 0;
                const dueDate = new Date(txDate.getTime() + termsDays * 86400000);
                const daysOverdue = Math.floor((new Date() - dueDate) / 86400000);
                
                const statusHtml = daysOverdue > 0 
                    ? `<span style="color:var(--danger); font-weight:bold;">${daysOverdue} days overdue</span>` 
                    : `<span style="color:var(--text-muted);">Due in ${Math.abs(daysOverdue)} days</span>`;
                    
                return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--border-color); font-size:13px;">
                    <div>
                        <strong>${t.buyerName || 'Unknown Buyer'}</strong> <span style="color:var(--text-muted); font-size:11px;">(${t.batchName})</span><br>
                        <span style="color:var(--text-muted);">${new Date(t.date).toLocaleDateString()} • ${t.qty} eggs</span>
                    </div>
                    <div style="text-align:right;">
                        <strong>KES ${t.amount.toLocaleString()}</strong><br>
                        ${statusHtml}
                        <button class="btn btn-sm" style="padding:2px 6px; margin-top:4px;" onclick="window.markInvoicePaid(${t.batchId}, ${t.id})">Mark Paid</button>
                    </div>
                </div>
            `}).join('');
        }
    }

    lucide.createIcons();
};

window.markInvoicePaid = async function(batchId, txId) {
    if (!confirm('Mark this invoice as paid?')) return;
    const txs = await api.getTransactions(batchId);
    const idx = txs.findIndex(t => t.id === txId);
    if (idx >= 0) {
        txs[idx].status = 'paid';
        await api.saveTransaction(batchId, txs[idx]);
    }
};

window.deleteProposal = async function(id) {
    const proposals = await api.getProposals();
    const filtered = proposals.filter(p => p.id !== id);
    await api.deleteProposal(id);
    window.refreshDashboard();
    // NOTE: window.renderAnalytics is owned by the app orchestrator (js/app.js)
    // and exposed globally to allow view modules (like this one) to trigger re-renders.
    if (window.renderAnalytics) window.renderAnalytics();
};
