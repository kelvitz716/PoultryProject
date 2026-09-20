/**
 * @file health.js
 * @description Health view module for PoultryDSS.
 * Manages flock health events, vaccine schedules, medication logs, off-label usage warnings, and drug withdrawal tracking.
 */

import { api } from './api.js';
import { store } from './store.js';
import { DRUG_WITHDRAWAL_TABLE } from './engine.js';
import { $, showToast } from './ui.js';

export function getActiveWithdrawal(healthLogs, logs) {
    const meds = healthLogs || [];
    const dailyLogs = logs || [];
    let maxEggDate = null;
    let maxMeatDate = null;
    let discardedEggs = 0;
    
    meds.forEach(m => {
        if (m.type !== 'meds') return;
        const date = new Date(m.date);
        const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
        const meatDays = m.offLabel ? 28 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.meat || 0);
        
        const eggClear = new Date(date.getTime() + eggDays * 86400000);
        const meatClear = new Date(date.getTime() + meatDays * 86400000);
        
        if (!maxEggDate || eggClear > maxEggDate) maxEggDate = eggClear;
        if (!maxMeatDate || meatClear > maxMeatDate) maxMeatDate = meatClear;
    });
    
    const now = new Date();
    const eggsUnderWithdrawal = maxEggDate && maxEggDate > now;
    const meatUnderWithdrawal = maxMeatDate && maxMeatDate > now;
    
    if (eggsUnderWithdrawal && maxEggDate) {
        let earliestActiveStart = null;
        meds.forEach(m => {
            if (m.type !== 'meds') return;
            const date = new Date(m.date);
            const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
            const eggClear = new Date(date.getTime() + eggDays * 86400000);
            if (eggClear > now) {
                if (!earliestActiveStart || date < earliestActiveStart) earliestActiveStart = date;
            }
        });
        
        if (earliestActiveStart) {
            dailyLogs.forEach(l => {
                const lDate = new Date(l.date);
                if (lDate >= earliestActiveStart && lDate <= maxEggDate) {
                    discardedEggs += (parseInt(l.eggs) || 0);
                }
            });
        }
    }

    return {
        eggsUnderWithdrawal,
        meatUnderWithdrawal,
        eggClearDate: maxEggDate,
        meatClearDate: maxMeatDate,
        discardedEggs
    };
}

window.getActiveWithdrawal = getActiveWithdrawal;

window.openHealthModal = function(type) {
    const bid = store.currentBatchId;
    if (!bid) return;
    
    const title = type === 'vaccine' ? 'Log Vaccination' : 'Log Medication / Treatment';
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'health-modal';
    
    let drugOptionsHtml = '';
    if (type === 'vaccine') {
        drugOptionsHtml = `
            <option value="Newcastle (HB1/La Sota)">Newcastle (HB1/La Sota)</option>
            <option value="Gumboro (IBD)">Gumboro (IBD)</option>
            <option value="Fowl Pox">Fowl Pox</option>
            <option value="Marek's Disease">Marek's Disease</option>
            <option value="Newcastle (Booster)">Newcastle (Booster)</option>
            <option value="Gumboro (Booster)">Gumboro (Booster)</option>
            <option value="Newcastle (Komarov)">Newcastle (Komarov)</option>
            <option value="Newcastle (La Sota)">Newcastle (La Sota)</option>
            <option value="Dewormer (Piperazine)">Dewormer (Piperazine)</option>
            <option value="Dewormer (Levamisole)">Dewormer (Levamisole)</option>
            <option value="other">Other (Custom Vaccine)</option>
        `;
    } else {
        drugOptionsHtml = `
            <option value="Aliseryl WS">Aliseryl WS</option>
            <option value="Oxytetracycline">Oxytetracycline</option>
            <option value="Amoxicillin">Amoxicillin</option>
            <option value="Tylosin">Tylosin</option>
            <option value="Levamisole">Levamisole</option>
            <option value="Perimin">Perimin</option>
            <option value="Norotraz">Norotraz</option>
            <option value="Piperazine">Piperazine</option>
            <option value="Fenbendazole">Fenbendazole</option>
            <option value="other">Other (Custom Medicine)</option>
        `;
    }
    
    modal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; padding:24px;">
            <h3>${title}</h3>
            <form id="health-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                <div class="input-group">
                    <label>Date</label>
                    <input type="date" id="health-date" required value="${new Date().toISOString().split('T')[0]}">
                </div>
                
                <div class="input-group">
                    <label>${type === 'vaccine' ? 'Vaccine Name' : 'Medicine / Drug Name'}</label>
                    <select id="health-drug-select" required>
                        ${drugOptionsHtml}
                    </select>
                </div>
                
                <div class="input-group" id="health-custom-drug-group" style="display:none;">
                    <label>Specify Custom Name</label>
                    <input type="text" id="health-custom-drug" placeholder="e.g. Tylosin, Newcastle Booster">
                </div>
                
                <div class="input-group">
                    <label>Dosage</label>
                    <input type="text" id="health-dosage" placeholder="e.g. 1.5 Tablespoon/20L, 1 vial/1000 birds" required>
                </div>
                
                <div class="input-group">
                    <label>Route of Administration</label>
                    <select id="health-route">
                        <option value="Drinking Water">Drinking Water</option>
                        <option value="Wing-web">Wing-web Injection</option>
                        <option value="Intramuscular">Intramuscular Injection</option>
                        <option value="Eye Drop">Eye Drop</option>
                        <option value="Oral">Oral (Direct)</option>
                        <option value="Spray">Coop Spray / Aerosol</option>
                        <option value="Feed additive">In-feed Additive</option>
                        <option value="Other">Other</option>
                    </select>
                </div>
                
                <div class="input-group">
                    <label>Administered By</label>
                    <input type="text" id="health-admin" placeholder="e.g. Kelvin, Vet" required value="${window.USER_NAME || ''}">
                </div>
                
                <div class="input-group" style="display:flex; flex-direction:row; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="health-off-label" style="width:auto; margin:0;">
                    <label for="health-off-label" style="margin:0; cursor:pointer;">Off-label use (forces 14d egg/28d meat withdrawal)</label>
                </div>
                
                <div style="display:flex; gap:12px; margin-top:8px;">
                    <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button type="submit" class="btn btn-primary" style="flex:1;">Log Event</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    
    const drugSelect = document.getElementById('health-drug-select');
    const customDrugGroup = document.getElementById('health-custom-drug-group');
    const customDrugInput = document.getElementById('health-custom-drug');
    
    drugSelect.addEventListener('change', function() {
        if (this.value === 'other') {
            customDrugGroup.style.display = 'block';
            customDrugInput.required = true;
        } else {
            customDrugGroup.style.display = 'none';
            customDrugInput.required = false;
            customDrugInput.value = '';
        }
    });
    
    document.getElementById('health-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const selectedDrug = drugSelect.value;
        const drugName = selectedDrug === 'other' ? customDrugInput.value.trim() : selectedDrug;
        
        if (!drugName) {
            window.showToast('Please specify a drug or vaccine name.', 'danger');
            return;
        }
        
        const newLog = {
            id: `${bid}_h_${Date.now()}`,
            date: document.getElementById('health-date').value,
            type: type,
            drug: drugName,
            dosage: document.getElementById('health-dosage').value.trim(),
            route: document.getElementById('health-route').value,
            admin: document.getElementById('health-admin').value.trim() || 'Admin',
            offLabel: document.getElementById('health-off-label').checked
        };
        
        try {
            await api.saveHealthLog(bid, newLog);
            document.body.removeChild(modal);
            window.showToast(`${type === 'vaccine' ? 'Vaccination' : 'Medication'} logged successfully.`, 'success');
            
            await window.renderHealthTable(bid);
            
            const batch = store.allBatches.find(b => String(b.id) === String(bid));
            if (batch && window.refreshCockpitSafely) void window.refreshCockpitSafely(batch, 'health log save');
        } catch (err) {
            console.error('Error saving health log:', err);
            window.showToast('Failed to save health log.', 'danger');
        }
    });
};

const headerStyle = 'padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);';
const cellStyle = 'padding:8px 12px;';

function text(value) {
    return String(value ?? '');
}

function appendCell(row, value, style = cellStyle, dom = document) {
    const cell = dom.createElement('td');
    cell.style.cssText = style;
    cell.textContent = text(value);
    row.append(cell);
    return cell;
}

/**
 * Render persisted health records exclusively through textContent. Health log
 * fields are user-supplied and must never be parsed as HTML when revisited.
 */
export function renderHealthLogTable(container, logs, dom = document) {
    const records = Array.isArray(logs) ? logs : [];
    if (records.length === 0) {
        const empty = dom.createElement('p');
        empty.style.cssText = 'text-align:center; padding:20px; color:var(--text-muted);';
        empty.textContent = 'No health records yet.';
        container.replaceChildren(empty);
        return;
    }

    const table = dom.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse;';
    const thead = dom.createElement('thead');
    const headerRow = dom.createElement('tr');
    for (const label of ['Date', 'Event', 'Dosage', 'Admin']) {
        const header = dom.createElement('th');
        header.style.cssText = headerStyle;
        header.textContent = label;
        headerRow.append(header);
    }
    thead.append(headerRow);

    const tbody = dom.createElement('tbody');
    for (const record of records) {
        const row = dom.createElement('tr');
        row.style.cssText = 'border-bottom:1px solid var(--border-color); font-size:13px;';
        appendCell(row, record.date, `${cellStyle} color:var(--text-muted);`, dom);

        const eventCell = dom.createElement('td');
        eventCell.style.cssText = cellStyle;
        const isVaccine = record.type === 'vaccine';
        const pill = dom.createElement('span');
        pill.className = 'pill';
        pill.style.cssText = `background:${isVaccine ? 'var(--primary-soft)' : '#fef3c7'}; color:${isVaccine ? 'var(--primary)' : 'var(--accent)'}; margin-right:6px;`;
        const icon = dom.createElement('i');
        icon.setAttribute('data-lucide', isVaccine ? 'syringe' : 'pill');
        icon.style.cssText = 'width:12px;height:12px;vertical-align:middle;margin-right:2px;';
        const eventType = dom.createElement('span');
        eventType.textContent = isVaccine ? 'VACCINE' : 'MEDS';
        pill.append(icon, eventType);
        const drug = dom.createElement('strong');
        drug.textContent = text(record.drug);
        eventCell.append(pill, drug);
        if (record.offLabel) {
            const offLabel = dom.createElement('span');
            offLabel.style.cssText = 'color:#dc2626; font-size:10px; margin-left:4px;';
            offLabel.textContent = '(Off-label)';
            eventCell.append(offLabel);
        }
        row.append(eventCell);

        const dosageCell = dom.createElement('td');
        dosageCell.style.cssText = cellStyle;
        const dosage = dom.createElement('div');
        dosage.style.cssText = 'margin-bottom:4px;';
        dosage.textContent = text(record.dosage);
        const route = dom.createElement('span');
        route.className = 'pill';
        route.style.cssText = 'background:var(--border-color); color:var(--text-muted); font-size:10px;';
        route.textContent = text(record.route || 'Unknown');
        dosageCell.append(dosage, route);
        row.append(dosageCell);

        appendCell(row, record.admin, `${cellStyle} color:var(--text-muted);`, dom);
        tbody.append(row);
    }

    table.append(thead, tbody);
    container.replaceChildren(table);
}

window.renderHealthTable = async function(batchId) {
    const container = $('health-log-table');
    if (!container) return;
    renderHealthLogTable(container, await api.getHealthLogs(batchId));
    globalThis.lucide?.createIcons?.();
};
