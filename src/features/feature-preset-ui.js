// Proposal card for `preset-changes` blocks and the download of the edited preset.

import { EXT_DISPLAY, I } from '../constants.js';
import { getCurrentSession, addMessage, saveSessionsToMetadata } from '../session.js';
import { escHtml } from '../utils/util-dom.js';
import { openTextDiffModal } from '../utils/util-diff.js';
import {
    getSessionPreset, applyPresetChanges, validatePresetData, serializePreset, editedFileName, stripPresetChangesBlock,
    describePresetChange,
} from './feature-preset-engine.js';
import { addHistoryToSwipe, _renderMsgBodyContent } from '../ui/ui-chat.js';
import { appendLBHistoryEl } from './feature-lorebook-ui.js';
import { bringWindowToFront } from '../ui/ui-window.js';

const SLIDERS = '<i class="fa-solid fa-sliders"></i>';

export function downloadSessionPreset(session = getCurrentSession()) {
    const preset = getSessionPreset(session);
    if (!preset) { toastr.warning('No preset is attached in this Copilot session.', EXT_DISPLAY); return; }
    const text = serializePreset(preset.data, preset.format);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = editedFileName(preset.fileName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function logPresetEditHistory(lines, afterMsgId) {
    if (!lines.length) return;
    try {
        if (afterMsgId && addHistoryToSwipe(afterMsgId, lines)) return;
        const histText = `**System Notification** — Preset edits:\n${lines.join('\n')}`;
        const msg = addMessage(getCurrentSession(), 'system', histText, { isLBHistory: true, isPresetEditHistory: true, appliedLines: [...lines] });
        appendLBHistoryEl(msg);
    } catch (_) {}
}

function stripBlockFromMessage(msgId, extra = {}) {
    const session = getCurrentSession();
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return null;
    msg.content = stripPresetChangesBlock(msg.content);
    if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
    Object.assign(msg, extra);
    saveSessionsToMetadata();
    return msg;
}

function insertCard(card, msgEl) {
    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}

export function renderPresetProposalCard(changes, msgEl) {
    if (!changes?.length) return;
    const msgId = msgEl.dataset.id;
    document.querySelector(`.scp-preset-proposal-card[data-for="${msgId}"]`)?.remove();

    const preset = getSessionPreset(getCurrentSession());
    const included = changes.map(() => true);

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-preset-proposal-card';
    card.dataset.for = msgId;
    card.style.margin = '8px 0 0 0';

    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon" style="color:var(--scp-accent);display:flex">${SLIDERS}</span>`
        + `<span class="scp-lb-proposal-title">Proposed Preset Edits</span>`;
    const countBadge = document.createElement('span');
    countBadge.className = 'scp-lb-proposal-count';
    headerLeft.appendChild(countBadge);
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss'; dismissBtn.innerHTML = I.x; dismissBtn.title = 'Reject all';
    header.appendChild(headerLeft); header.appendChild(dismissBtn);

    const fileRow = document.createElement('div');
    fileRow.style.cssText = 'font-size:11px;opacity:.75;padding:4px 10px 0';
    fileRow.textContent = preset
        ? `${preset.fileName} · working copy v${preset.version || 1} → v${(preset.version || 1) + 1}`
        : 'No preset is attached in this Copilot session. Attach the preset again to apply these edits.';

    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'scp-lb-proposal-apply';
    applyBtn.textContent = 'Apply & Download';
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'scp-lb-proposal-reject'; rejectBtn.textContent = 'Reject All';
    footer.appendChild(applyBtn); footer.appendChild(rejectBtn);

    // Simulates the included changes, in order, against the current working copy.
    const simulate = () => {
        const current = getSessionPreset(getCurrentSession());
        if (!current) return null;
        const chosen = changes.filter((_, i) => included[i]);
        const { data, results } = applyPresetChanges(current.data, chosen);
        const perChange = [];
        let k = 0;
        changes.forEach((_, i) => { perChange[i] = included[i] ? results[k++] : null; });
        return { data, perChange };
    };

    const renderItems = () => {
        const sim = simulate();
        list.innerHTML = '';
        let okCount = 0;
        changes.forEach((c, i) => {
            const r = sim?.perChange[i];
            const item = document.createElement('div');
            const isDelete = /^delete_/.test(c.op);
            item.className = `scp-lb-proposal-item ${isDelete ? 'scp-lb-proposal-delete' : c.op.startsWith('add_') ? 'scp-lb-proposal-add' : 'scp-lb-proposal-edit'}`;
            if (!included[i]) item.classList.add('scp-lb-item-rejected');
            const hdr = document.createElement('div');
            hdr.className = 'scp-lb-proposal-item-header';

            const meta = document.createElement('div');
            meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap;min-width:0';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = included[i]; cb.title = 'Include this change';
            cb.addEventListener('change', () => { included[i] = cb.checked; renderItems(); });
            const label = document.createElement('span');
            label.className = 'scp-lb-proposal-name';
            label.textContent = r?.label || c.op;
            meta.appendChild(cb); meta.appendChild(label);

            if (r && !r.ok) {
                const warn = document.createElement('div');
                warn.style.cssText = 'font-size:10px;color:var(--scp-danger);width:100%';
                warn.textContent = `⚠ ${r.error} — will be skipped`;
                meta.appendChild(warn);
                item.style.borderLeftColor = 'var(--scp-danger)';
            } else if (r?.warning) {
                const warn = document.createElement('div');
                warn.style.cssText = 'font-size:10px;color:var(--scp-warning, #ffb432);width:100%';
                warn.textContent = `⚠ ${r.warning}`;
                meta.appendChild(warn);
            }
            if (r?.ok) okCount++;

            const btns = document.createElement('div');
            btns.className = 'scp-lb-proposal-item-btns';
            if (r?.ok && r.textChanged) {
                const diffBtn = document.createElement('button');
                diffBtn.className = 'scp-lb-proposal-diff-btn'; diffBtn.title = 'View diff'; diffBtn.innerHTML = I.diff;
                diffBtn.addEventListener('click', e => { e.stopPropagation(); openTextDiffModal(r.label, r.before || '', r.after || ''); });
                btns.appendChild(diffBtn);
            }
            hdr.appendChild(meta); hdr.appendChild(btns);
            item.appendChild(hdr);
            list.appendChild(item);
        });
        const n = included.filter(Boolean).length;
        countBadge.textContent = `${n}/${changes.length} selected`;
        applyBtn.disabled = !sim || okCount === 0;
        applyBtn.title = !sim ? 'No preset attached in this session' : okCount === 0 ? 'Nothing that can be applied is selected' : '';
    };

    const rejectAll = () => {
        const data = getSessionPreset(getCurrentSession())?.data;
        logPresetEditHistory(changes.map(c => `✕ **REJECTED**: preset change ${describePresetChange(c, data)}`), msgId);
        stripBlockFromMessage(msgId);
        card.remove();
    };

    dismissBtn.addEventListener('click', rejectAll);
    rejectBtn.addEventListener('click', rejectAll);

    applyBtn.addEventListener('click', () => {
        const session = getCurrentSession();
        const current = getSessionPreset(session);
        const sim = simulate();
        if (!current || !sim) return;
        const problems = validatePresetData(sim.data);
        if (problems.length) {
            toastr.error(`The edited preset failed validation: ${problems.slice(0, 3).join('; ')}`, EXT_DISPLAY, { timeOut: 10000 });
            return;
        }
        const newVersion = (current.version || 1) + 1;
        const lines = [];
        changes.forEach((c, i) => {
            const r = sim.perChange[i];
            if (!included[i]) lines.push(`✕ **REJECTED**: preset change ${describePresetChange(c, current.data)}`);
            else if (!r.ok) lines.push(`✕ **REJECTED**: preset change could not be applied: ${r.label} (${r.error})`);
            else lines.push(`✓ **ACCEPTED**: preset v${newVersion}: ${r.label}`);
        });
        current.data = sim.data;
        current.version = newVersion;
        saveSessionsToMetadata();
        downloadSessionPreset(session);
        logPresetEditHistory(lines, msgId);
        const msg = stripBlockFromMessage(msgId, { presetResult: { version: newVersion, fileName: current.fileName } });
        card.remove();
        if (msg) _renderMsgBodyContent(msgEl, msg);
        toastr.success(`Preset updated to v${newVersion} and downloaded.`, EXT_DISPLAY);
    });

    card.appendChild(header);
    card.appendChild(fileRow);
    card.appendChild(list);
    card.appendChild(footer);
    renderItems();
    insertCard(card, msgEl);
    bringWindowToFront();
}

// Shown on a message whose preset edits were applied: re-download the latest working copy.
export function renderPresetResultCard(msg, msgEl) {
    document.querySelector(`.scp-preset-result-card[data-for="${msg.id}"]`)?.remove();
    const preset = getSessionPreset(getCurrentSession());
    if (!msg.presetResult || !preset) return;
    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-preset-result-card';
    card.dataset.for = msg.id;
    card.style.margin = '8px 0 0 0';
    const row = document.createElement('div');
    row.className = 'scp-lb-proposal-header';
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    left.innerHTML = `<span class="scp-lb-proposal-icon" style="color:var(--scp-accent);display:flex">${SLIDERS}</span>`
        + `<span class="scp-lb-proposal-title">Preset updated to v${escHtml(msg.presetResult.version)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'scp-lb-proposal-apply';
    btn.textContent = `Download latest (v${preset.version || 1})`;
    btn.title = editedFileName(preset.fileName);
    btn.addEventListener('click', () => downloadSessionPreset());
    row.appendChild(left); row.appendChild(btn);
    card.appendChild(row);
    insertCard(card, msgEl);
}
