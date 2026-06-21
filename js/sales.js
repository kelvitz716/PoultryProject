/**
 * @file sales.js
 * @description Sales and financial transaction view module for PoultryDSS.
 * Manages M-Pesa STK push payments, manual sales ledger entry (eggs, spent birds, manure),
 * and the surplus rooster ratio advisory workflow.
 */

import { api } from './api.js';
import { store } from './store.js';
import { computeEggInventoryAging } from './engine.js';
import { $ } from './ui.js';

window.openTxModal = async function(type, prefilledCategory = null, prefilledQty = null) {
    const isAdminPlus = ['super_admin','admin'].includes(window.USER_ROLE);
    if (!isAdminPlus) {
        window.showToast('Access denied: Insufficient permissions.', 'danger');
        return;
    }
    const title = type === 'purchase' ? 'Log Purchase' : type === 'return' ? 'Log Egg Return' : type === 'write_off' ? 'Log Write-off / Wastage' : 'Log Sale';
    const bid = store.currentBatchId;
    if (!bid) return;
    const logs = await api.getLogs(bid);
    const txs = await api.getTransactions(bid);
    const stagingToday = await api.getTodayStaging(bid).catch(() => null);
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'tx-modal';
    
    const saleOptions = `
        <option value="eggs">Eggs</option>
        <option value="spent">Spent Layers (Hens)</option>
        <option value="roosters">Roosters</option>
        <option value="manure">Manure</option>
    `;
    const returnOptions = `<option value="eggs">Rejected / Returned Eggs</option>`;
    const writeOffOptions = `
        <option value="eggs">Eggs (cracked / destroyed / self-consumed)</option>
        <option value="feed">Feed (spoiled / wet / expired)</option>
        <option value="meds">Medicine (expired / spilled)</option>
        <option value="other">Other</option>
    `;
    const purchaseOptions = `
        <option value="chicks">Chicks (Initial Stock)</option>
        <option value="feed">Feed</option>
        <option value="labour">Labour</option>
        <option value="utilities">Utilities (Electricity / Water)</option>
        <option value="health">Health &amp; Supplies (Meds, Infra, Other)</option>
    `;

    modal.innerHTML = `
        <div class="modal-content card" style="max-width:400px; padding:24px;">
            <h3>${title}</h3>
            <form id="tx-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                <div class="input-group">
                    <label>${type === 'write_off' ? 'What are you writing off?' : 'Category'}</label>
                    <select id="tx-category">
                        ${type === 'purchase' ? purchaseOptions : type === 'return' ? returnOptions : type === 'write_off' ? writeOffOptions : saleOptions}
                    </select>
                </div>
                <div class="input-grid" id="tx-dynamic-inputs" style="display:flex; flex-direction:column; gap:12px;">
                    <!-- Dynamic fields injected here -->
                </div>
                <div class="input-group">
                    <label>Description / Notes (Optional)</label>
                    <textarea id="tx-notes" rows="2" placeholder="e.g., Newcastle Vaccine, Coop cleaning"></textarea>
                </div>
                <div style="display:flex; gap:12px; margin-top:8px;">
                    <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button type="submit" class="btn btn-primary" style="flex:1;">Save Transaction</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    if (prefilledCategory) {
        const selectEl = modal.querySelector('#tx-category');
        if (selectEl) {
            selectEl.value = prefilledCategory;
        }
    }

    const renderInputs = () => {
         const cat = $('tx-category').value;
         let html = '';
         if (type === 'sale') {
              if (cat === 'eggs') {
                   const inventoryAging = computeEggInventoryAging(logs, txs, stagingToday);
                   const oldestBatch = inventoryAging.unsoldBatches.length > 0 ? inventoryAging.unsoldBatches[0].ageDays : 0;
                   
                   const buyers = store.farmProfile.buyers || [];
                   const buyerOptions = buyers.map(b => `<option value="${b.name}" data-terms="${b.terms}">${b.name} (${b.terms})</option>`).join('');
                   const buyerSelectHtml = buyers.length > 0 ? `
                        <div class="input-group">
                            <label>Buyer / Customer</label>
                            <select id="tx-buyer">
                                <option value="Walk-in Customer" data-terms="COD">Walk-in Customer (COD)</option>
                                ${buyerOptions}
                            </select>
                        </div>
                   ` : `<input type="hidden" id="tx-buyer" value="Walk-in Customer">`;
                   html += buyerSelectHtml;
                   
                   html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit" onchange="window.checkCapacity()"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                   html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required oninput="window.checkCapacity()"></div></div>`;
                   
                   html += `<div class="input-group"><label>Delivery Logistics</label><select id="tx-route" onchange="window.checkCapacity()"><option value="pickup">Farm Pickup</option><option value="keke">Keke / Tricycle Delivery</option><option value="saloon">Saloon Car Delivery</option></select></div>`;
                   
                   html += `<div id="tx-capacity-warning" style="display:none; font-size:12px; color:var(--text-muted); background:#fef3c7; padding:8px; border-radius:4px; border:1px solid #f59e0b; margin-bottom:16px;">
                               <div style="display:flex; align-items:center; gap:8px; color:#d97706; font-weight:bold; margin-bottom:4px;">
                                   <i data-lucide="alert-triangle" style="width:14px; height:14px;"></i> Capacity Warning
                               </div>
                               <div id="tx-capacity-msg" style="color:#b45309;"></div>
                            </div>`;
                   
                   html += `
                    <script>
                        window.checkCapacity = function() {
                            const route = document.getElementById('tx-route');
                            const qty = document.getElementById('tx-qty');
                            const unit = document.getElementById('tx-unit');
                            const warningBox = document.getElementById('tx-capacity-warning');
                            const msgBox = document.getElementById('tx-capacity-msg');
                            
                            if (!route || !qty || !unit || !warningBox || !msgBox) return;
                            
                            const rVal = route.value;
                            const qVal = parseFloat(qty.value) || 0;
                            const uVal = unit.value;
                            
                            const totalUnsold = ${inventoryAging.totalUnsold};
                            if (qty) {
                                if (uVal === 'trays') {
                                    qty.max = Math.floor(totalUnsold / 30);
                                } else {
                                    qty.max = totalUnsold;
                                }
                            }
                            
                            let trays = uVal === 'trays' ? qVal : qVal / 30;
                            
                            if (rVal === 'keke' && trays > 50) {
                                msgBox.innerText = 'A Tricycle can safely carry a maximum of ~50 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                warningBox.style.display = 'block';
                            } else if (rVal === 'saloon' && trays > 200) {
                                msgBox.innerText = 'A Saloon Car can safely carry a maximum of ~200 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                warningBox.style.display = 'block';
                            } else {
                                warningBox.style.display = 'none';
                            }
                        };
                        setTimeout(window.checkCapacity, 50);
                    </script>`;
                   
                   html += `<div style="font-size:12px; color:var(--text-muted); background:var(--bg-main); padding:8px; border-radius:4px; border:1px solid var(--border-color); display:flex; align-items:center; gap:8px;">
                               <i data-lucide="layers" style="width:14px; height:14px; color:var(--primary);"></i> 
                               <div><strong>FIFO Dispatch Active:</strong> You have ${inventoryAging.totalUnsold.toLocaleString()} eggs in stock. Sales will automatically deduct from the oldest stock first (oldest is ${oldestBatch} days old).</div>
                            </div>`;
              } else if (cat === 'manure') {
                   html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="bags">50kg Bags</option><option value="wb">Wheelbarrows</option></select></div>`;
                   html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="${prefilledQty !== null ? prefilledQty : 1}" required></div></div>`;
              } else if (cat === 'spent' || cat === 'roosters') {
                   html += `<div class="input-group"><label>Birds Sold</label><input type="number" id="tx-qty" value="${prefilledQty !== null ? prefilledQty : 1}" required></div>`;
              }
         } else if (type === 'return') {
               html = `<div class="input-group"><label>Refund Amount (KES)</label><input type="number" id="tx-amount" value="0" required></div>`;
               html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
               html += `<div class="input-group"><label>Quantity Returned</label><input type="number" id="tx-qty" value="1" required></div></div>`;
               
               html += `<div class="input-group"><label>Defect Type</label><select id="tx-defect" onchange="
                  const val = this.value;
                  const r = document.getElementById('tx-root-cause');
                  if(!r) return;
                  if(val === 'pale') r.innerText = 'Infectious Bronchitis (IB) or older birds (>72 wks)';
                  else if(val === 'crack') r.innerText = 'Mechanical damage — rough handling or overcrowding';
                  else if(val === 'dirty') r.innerText = 'Wet litter, poor gut health, or infrequent collection';
                  else if(val === 'thin') r.innerText = 'Ca / Vitamin D3 deficiency or heat stress';
                  else r.innerText = 'Unknown';
               ">
                   <option value="pale">Pale Shells</option>
                   <option value="crack">Hairline / Star Cracks</option>
                   <option value="dirty">Dirty / Stained Shells</option>
                   <option value="thin">Thin Shells</option>
               </select></div>`;
               
               html += `<div style="font-size:12px; color:var(--text-muted); background:#fee2e2; padding:8px; border-radius:4px; border:1px solid #fca5a5; display:flex; align-items:center; gap:8px;">
                           <i data-lucide="microscope" style="width:14px; height:14px; color:#dc2626;"></i> 
                           <div><strong>Likely Root Cause:</strong> <span id="tx-root-cause">Infectious Bronchitis (IB) or older birds (>72 wks)</span></div>
                        </div>`;
         } else if (type === 'write_off') {
               const unitLabel = cat === 'eggs' ? 'Quantity (eggs)' : cat === 'feed' ? 'Quantity (kg)' : 'Quantity (units)';
               html += `
                   <div class="input-group"><label>Reason</label><select id="tx-reason">
                       <option value="spoiled">Spoiled / Contaminated</option>
                       <option value="cracked">Cracked / Physically Damaged</option>
                       <option value="self_consumed">Self-consumed (staff / household)</option>
                       <option value="destroyed">Destroyed (pest, theft, accident)</option>
                       <option value="expired">Expired (past safe use date)</option>
                       <option value="other">Other</option>
                   </select></div>
                   <div class="input-group"><label>${unitLabel}</label><input type="number" id="tx-qty" min="1" required></div>
                   <div class="input-group"><label>Est. Value Lost (KES — optional)</label><input type="number" id="tx-amount" value="0"></div>
               `;
         } else {
              if (cat === 'feed') {
                   html += `<div class="input-group"><label>Quantity (kg)</label><input type="number" id="tx-qty" required></div>`;
              } else if (cat === 'labour') {
                   html += `<div class="input-group"><label>Farmhand Name</label><input type="text" id="tx-farmhand" placeholder="e.g. John Doe"></div>`;
              } else if (cat === 'utilities') {
                    html += `<div class="input-group">
                        <label>Utility Type</label>
                        <select id="tx-sub-category">
                            <option value="electricity">Electricity</option>
                            <option value="water">Water</option>
                        </select>
                    </div>`;
                    html += `<div class="input-group"><label>Billing Month</label><input type="month" id="tx-billing-month"></div>`;
              } else if (cat === 'health') {
                    html += `<div class="input-group">
                        <label>Supply Type</label>
                        <select id="tx-sub-category">
                            <option value="meds">Vaccines / Medication</option>
                            <option value="infrastructure">Infrastructure</option>
                            <option value="other">Other Supplies</option>
                        </select>
                    </div>`;
              }
         }

         if (type !== 'return' && type !== 'write_off') {
              if (cat === 'feed') {
                  html += `
                    <div class="input-group">
                        <label>Purchase Amount (KES)</label>
                        <input type="number" id="tx-amount" required>
                        <span style="font-size:11px; color:var(--text-muted);">Auto-calculated based on ${store.farmProfile.defaultFeedPrice} KES per ${store.farmProfile.sackWeightKg}kg bag. You can override this.</span>
                    </div>
                    <div class="input-group">
                        <label>Delivery Fee (Optional KES)</label>
                        <input type="number" id="tx-delivery" value="0">
                    </div>
                    <script>
                        document.getElementById('tx-qty').addEventListener('input', function() {
                            const amtEl = document.getElementById('tx-amount');
                            if (amtEl && this.value) {
                                amtEl.value = Math.round((parseFloat(this.value) / ${store.farmProfile.sackWeightKg}) * ${store.farmProfile.defaultFeedPrice});
                            } else if (amtEl) {
                                amtEl.value = '';
                            }
                        });
                    </script>`;
              } else {
                  html += `<div class="input-group"><label>Total Amount (KES)</label><input type="number" id="tx-amount" required></div>`;
              }
         }
         $('tx-dynamic-inputs').innerHTML = html;
         
         // Eval script tags if any were injected (for the feed qty listener)
         const scripts = $('tx-dynamic-inputs').getElementsByTagName('script');
         for (let i = 0; i < scripts.length; i++) {
             eval(scripts[i].innerText);
         }
    };

    $('tx-category').addEventListener('change', renderInputs);
    renderInputs();

    $('tx-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const bid = store.currentBatchId;
        if (!bid) { window.showToast('Batch context missing.', 'danger'); return; }

        const txs = await api.getTransactions(bid);
        const amount = parseFloat($('tx-amount') ? $('tx-amount').value : 0) || 0;
        const deliveryFee = $('tx-delivery') ? parseFloat($('tx-delivery').value) || 0 : 0;
        let rawQty = parseFloat($('tx-qty') ? $('tx-qty').value : 0);
        let unit = $('tx-unit') ? $('tx-unit').value : null;
        let farmhandName = $('tx-farmhand') ? $('tx-farmhand').value : null;
        let billingMonth = $('tx-billing-month') ? $('tx-billing-month').value : null;
        let buyerName = $('tx-buyer') ? $('tx-buyer').value : null;
        let route = $('tx-route') ? $('tx-route').value : null;
        let defectType = $('tx-defect') ? $('tx-defect').value : null;
        let reason = $('tx-reason') ? $('tx-reason').value : null;
        let buyerTerms = 'COD';
        if ($('tx-buyer') && $('tx-buyer').options && $('tx-buyer').type === 'select-one') {
            const selectedOpt = $('tx-buyer').options[$('tx-buyer').selectedIndex];
            if (selectedOpt) buyerTerms = selectedOpt.getAttribute('data-terms');
        }
        
        let normalizedQty = rawQty;

        if ((type === 'sale' || type === 'return' || type === 'write_off') && $('tx-category').value === 'eggs' && unit === 'trays') {
            normalizedQty = rawQty * 30; // convert to individual eggs
        }

        // Resolve actual category: for grouped types, use the sub-category dropdown value
        const subCat = $('tx-sub-category') ? $('tx-sub-category').value : null;
        const resolvedCategory = subCat || $('tx-category').value;

        const newTx = {
            id: Date.now().toString(),
            type: type, // 'sale', 'purchase', 'return', 'write_off'
            category: resolvedCategory,
            amount: amount,
            deliveryFee: deliveryFee,
            qty: normalizedQty,
            rawUnit: unit,
            rawQty: rawQty,
            farmhandName,
            billingMonth,
            buyerName,
            buyerTerms,
            route,
            defectType,
            reason,
            status: (buyerTerms && buyerTerms !== 'COD' && type === 'sale') ? 'unpaid' : 'paid',
            unitPrice: normalizedQty > 0 && amount > 0 ? (amount / normalizedQty) : 0,
            notes: $('tx-notes') ? $('tx-notes').value.trim() : '',
            date: new Date().toISOString()
        };
        
        await api.saveTransaction(bid, newTx);
        
        const batch = store.allBatches.find(b => String(b.id) === String(bid));
        
        // Handle Spent Layers / Roosters reduction
        if (type === 'sale' && (resolvedCategory === 'spent' || resolvedCategory === 'roosters') && rawQty > 0 && batch) {
            batch.stats.birdsAlive = Math.max(0, batch.stats.birdsAlive - rawQty);
            batch.stats.totalSold = (batch.stats.totalSold || 0) + rawQty;
            await window.updateBatch(batch);
        }
        
        // Handle feed price learning
        if (type === 'purchase' && resolvedCategory === 'feed' && rawQty > 0 && amount > 0) {
            const impliedBagPrice = (amount / rawQty) * store.farmProfile.sackWeightKg;
            if (Math.abs(impliedBagPrice - store.farmProfile.defaultFeedPrice) > 1) {
                store.farmProfile.defaultFeedPrice = Math.round(impliedBagPrice);
                store.saveFarmProfile(store.farmProfile);
                console.log("Farm profile default feed price updated to: " + store.farmProfile.defaultFeedPrice);
            }
        }
        
        document.body.removeChild(modal);
        if (batch && window.refreshCockpitData) window.refreshCockpitData(batch);
    });
};

window.openSurplusRoostersSaleModal = function(qty) {
    window.openTxModal('sale', 'roosters', qty);
};
