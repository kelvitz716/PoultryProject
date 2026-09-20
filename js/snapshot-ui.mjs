function text(value) {
    return value === undefined || value === null ? '' : String(value);
}

function profit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '—';
}

/**
 * Adds saved snapshots using DOM text nodes. Snapshot values are persisted
 * operator input, so none may be interpolated into HTML or event attributes.
 */
export function appendSnapshotChoices(container, snapshots, selectSnapshot, dom = document) {
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('snapshot container is required');
    if (!Array.isArray(snapshots) || typeof selectSnapshot !== 'function') throw new TypeError('snapshot choices are invalid');

    const choices = snapshots.map(snapshot => {
        const item = dom.createElement('div');
        item.className = 'snapshot-item';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');

        const info = dom.createElement('div');
        info.className = 'snapshot-info';
        const name = dom.createElement('h5');
        name.textContent = text(snapshot?.batchName);
        const detail = dom.createElement('p');
        detail.textContent = `${text(snapshot?.birds)} birds • ${text(snapshot?.type)} • Profit: KES ${profit(snapshot?.totalProfit)}`;
        info.append(name, detail);

        const action = dom.createElement('span');
        action.className = 'pill';
        action.textContent = 'Load Data';
        item.append(info, action);
        item.addEventListener('click', () => selectSnapshot(snapshot));
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectSnapshot(snapshot);
            }
        });
        return item;
    });
    container.replaceChildren(...choices);
    return choices;
}

export function renderSnapshotNote(container, snapshot, dom = document) {
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('snapshot note container is required');
    const icon = dom.createElement('i');
    icon.setAttribute('data-lucide', 'info');
    icon.setAttribute('style', 'width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;');
    const prefix = dom.createElement('span');
    prefix.textContent = 'Based on your batch ';
    const name = dom.createElement('strong');
    name.textContent = `'${text(snapshot?.batchName)}'`;
    const suffix = dom.createElement('span');
    const rate = Number(snapshot?.avgLayRate);
    suffix.textContent = `, expected lay rate at peak is ${Number.isFinite(rate) ? (rate * 100).toFixed(1) : '—'}%.`;
    container.replaceChildren(icon, prefix, name, suffix);
}
