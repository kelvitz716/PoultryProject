const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.textContent = '';
        this.className = '';
        this.attributes = {};
        this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
}

const dom = { createElement: tagName => new FakeElement(tagName) };
const snapshotUi = import('../../js/snapshot-ui.mjs');

test('saved snapshot fields remain inert text and selection never uses an inline handler', async () => {
    const { appendSnapshotChoices, renderSnapshotNote } = await snapshotUi;
    const payload = '<img src=x onerror=alert(1)>';
    const snapshot = { id: payload, batchName: payload, birds: payload, type: payload, totalProfit: payload, avgLayRate: payload };
    const container = new FakeElement('div');
    let selected = null;

    const [choice] = appendSnapshotChoices(container, [snapshot], value => { selected = value; }, dom);
    assert.equal(Object.hasOwn(container, 'innerHTML'), false);
    assert.equal(choice.tagName, 'div');
    assert.equal(choice.children[0].children[0].textContent, payload);
    assert.equal(choice.children[0].children[1].textContent.includes(payload), true);
    assert.equal(Object.hasOwn(choice, 'onclick'), false);
    choice.listeners.click();
    assert.equal(selected, snapshot);

    const note = new FakeElement('div');
    renderSnapshotNote(note, snapshot, dom);
    assert.equal(Object.hasOwn(note, 'innerHTML'), false);
    assert.equal(note.children[2].textContent, `'${payload}'`);
});
