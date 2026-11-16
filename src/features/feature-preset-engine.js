// Editing of SillyTavern Chat Completion presets attached to a Copilot message.
//
// The model never sees or rewrites the raw preset file. It gets a readable outline of the
// session's working copy (settings, prompts in prompt-manager order with their real on/off
// state, regex script names) and proposes edits as a `preset-changes` block of small
// operations. The extension applies the accepted operations to its own copy, so everything
// the model did not touch is preserved exactly, and serializes the result for download.
//
// Everything in this module is pure (no DOM), so it runs under the Node test harness.

import { parseAnchorPatches } from './feature-character-engine.js';
import { applySearchReplaceToField } from '../utils/util-text.js';

// ─── Verbatim regions ────────────────────────────────────────────────────────
// Attached files and preset text must reach the model exactly as written. Copilot expands
// {{outlet::...}} over the assembled prompt, so verbatim text is wrapped in these private-use
// sentinels, skipped by the expansion, and the sentinels are removed before sending.

export const VERBATIM_OPEN = '';
export const VERBATIM_CLOSE = '';

export function protectVerbatim(text) {
    if (typeof text !== 'string' || !text) return text;
    return VERBATIM_OPEN + text + VERBATIM_CLOSE;
}

export function stripVerbatimMarkers(text) {
    if (typeof text !== 'string') return text;
    return text.split(VERBATIM_OPEN).join('').split(VERBATIM_CLOSE).join('');
}

// Runs `transform` on the text outside verbatim regions only, then drops the markers.
export async function transformOutsideVerbatim(text, transform) {
    if (typeof text !== 'string' || !text) return text;
    if (!text.includes(VERBATIM_OPEN)) return stripVerbatimMarkers(await transform(text));
    const re = new RegExp(`${VERBATIM_OPEN}[\\s\\S]*?${VERBATIM_CLOSE}`, 'g');
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
        out += await transform(text.slice(last, m.index));
        out += m[0].slice(1, -1);
        last = m.index + m[0].length;
    }
    out += await transform(text.slice(last));
    return stripVerbatimMarkers(out);
}

// ─── Detection and serialization ─────────────────────────────────────────────

// Prompts SillyTavern's prompt manager expects to exist; they can be toggled or moved but not deleted.
export const CORE_PROMPT_IDS = [
    'main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'worldInfoBefore', 'worldInfoAfter',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory',
];

const REGEX_PLACEMENT = { 1: 'user_input', 2: 'ai_output', 3: 'slash_command', 5: 'world_info', 6: 'reasoning' };
const REGEX_PLACEMENT_REV = Object.fromEntries(Object.entries(REGEX_PLACEMENT).map(([k, v]) => [v, Number(k)]));

export function isChatCompletionPresetData(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data)
        && Array.isArray(data.prompts) && Array.isArray(data.prompt_order);
}

// Returns the parsed preset plus enough formatting info to write it back the same way,
// or null if the text is not a Chat Completion preset.
export function detectChatCompletionPreset(text) {
    if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
    let data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { return null; }
    if (!isChatCompletionPresetData(data)) return null;
    return { data, format: detectJsonFormat(text) };
}

export function detectJsonFormat(text) {
    const indentMatch = text.match(/^﻿?\{\r?\n([ \t]+)\S/);
    return {
        indent: indentMatch ? indentMatch[1] : (text.includes('\n') ? 4 : 0),
        eol: text.includes('\r\n') ? '\r\n' : '\n',
        trailingNewline: /\n$/.test(text),
        bom: text.startsWith('﻿'),
    };
}

export function serializePreset(data, format = {}) {
    const indent = format.indent ?? 4;
    let out = JSON.stringify(data, null, indent);
    if (format.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    if (format.trailingNewline) out += format.eol || '\n';
    if (format.bom) out = '﻿' + out;
    return out;
}

export function editedFileName(fileName) {
    const name = String(fileName || 'preset.json');
    const m = name.match(/^(.*?)(\.json)?$/i);
    let base = m[1] || 'preset';
    if (!/ \(edited\)$/.test(base)) base += ' (edited)';
    return `${base}.json`;
}

// ─── Session storage ─────────────────────────────────────────────────────────
// One working copy per Copilot session, stored once (not per message). Each accepted
// proposal bumps the version; downloads always use the latest version.

export function getSessionPreset(session) {
    const p = session?.preset;
    return p && isChatCompletionPresetData(p.data) ? p : null;
}

export function setSessionPreset(session, { fileName, data, format }) {
    session.preset = { fileName, data, format, version: 1, attachedAt: Date.now() };
    return session.preset;
}

// ─── Model-facing outline ────────────────────────────────────────────────────

// Prompt text is shown in full when the whole preset's prompt text fits in this many
// characters (~10k tokens); otherwise every prompt shows a short preview and the model reads
// full text with the read_preset tool.
export const PRESET_INLINE_CHAR_BUDGET = 40000;
const PREVIEW_CHARS = 160;

function escAttr(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The prompt_order list SillyTavern actually uses: 100001 is the global list.
export function getPrimaryOrder(data) {
    const lists = Array.isArray(data?.prompt_order) ? data.prompt_order : [];
    return lists.find(o => String(o?.character_id) === '100001')
        || lists.find(o => String(o?.character_id) === '100000')
        || lists[0] || null;
}

function promptPositionAttrs(p) {
    if (p.marker) return '';
    const pos = Number(p.injection_position) === 1 ? 'in_chat' : 'relative';
    let s = ` position="${pos}"`;
    if (pos === 'in_chat') s += ` depth="${escAttr(p.injection_depth ?? 4)}" order="${escAttr(p.injection_order ?? 100)}"`;
    return s;
}

function formatScalar(v) {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

export function buildPresetContextBlock(preset) {
    if (!preset || !isChatCompletionPresetData(preset.data)) return '';
    const data = preset.data;
    const prompts = data.prompts;
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const order = getPrimaryOrder(data);
    const orderEntries = Array.isArray(order?.order) ? order.order : [];
    const totalChars = prompts.reduce((n, p) => n + (typeof p.content === 'string' ? p.content.length : 0), 0);
    const inline = totalChars <= PRESET_INLINE_CHAR_BUDGET;

    const lines = [];
    lines.push(`<attached_preset file="${escAttr(preset.fileName)}" type="chat_completion" version="${preset.version || 1}">`);
    lines.push(`This is the working copy of the preset file the Human attached for editing. All text is shown exactly as stored; macros such as {{user}}, {{outlet::...}} or {{#if .x}} are NOT expanded.`);
    if (!inline) lines.push(`The preset is large, so prompt contents below are abbreviated previews. Call read_preset to get the exact full text of any prompt before editing or quoting it.`);

    const scalars = Object.entries(data).filter(([, v]) => v === null || typeof v !== 'object');
    lines.push('<settings>');
    for (const [k, v] of scalars) lines.push(`${k}: ${formatScalar(v)}`);
    lines.push('</settings>');

    const renderPrompt = (p, enabled) => {
        let attrs = `id="${escAttr(p.identifier)}" name="${escAttr(p.name || '')}"`;
        if (p.marker) attrs += ` marker="true"`;
        else attrs += ` role="${escAttr(p.role || 'system')}"`;
        if (enabled !== undefined) attrs += ` enabled="${enabled ? 'true' : 'false'}"`;
        attrs += promptPositionAttrs(p);
        const content = typeof p.content === 'string' ? p.content : '';
        if (p.marker && content.trim()) attrs += ` unsent_text_chars="${content.length}"`;
        if (p.marker || !content) return `<prompt ${attrs}/>`;
        if (inline) return `<prompt ${attrs}>\n${content}\n</prompt>`;
        const preview = content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '') + ' …' : content;
        return `<prompt ${attrs} chars="${content.length}" preview="true">\n${preview}\n</prompt>`;
    };

    const seen = new Set();
    const enabledCount = orderEntries.filter(e => e?.enabled && byId.has(e.identifier)).length;
    lines.push(`<prompt_order count="${orderEntries.length}" enabled="${enabledCount}">`);
    lines.push(`Prompts in the order they are sent. "enabled" is the real on/off switch.`);
    for (const e of orderEntries) {
        const p = byId.get(e?.identifier);
        if (!p) continue;
        seen.add(p.identifier);
        lines.push(renderPrompt(p, !!e.enabled));
    }
    lines.push('</prompt_order>');

    const unordered = prompts.filter(p => !seen.has(p.identifier));
    if (unordered.length) {
        lines.push(`<unused_prompts count="${unordered.length}">`);
        lines.push('Defined in the preset but not in the prompt order, so never sent. Add one to the order with move_prompt.');
        for (const p of unordered) lines.push(renderPrompt(p, undefined));
        lines.push('</unused_prompts>');
    }

    const regex = Array.isArray(data.extensions?.regex_scripts) ? data.extensions.regex_scripts : null;
    if (regex) {
        lines.push(`<regex_scripts count="${regex.length}">`);
        lines.push('Bundled regex scripts. Call read_preset with their names (or ids) to see find/replace patterns.');
        const nameCount = new Map();
        for (const r of regex) nameCount.set(r.scriptName, (nameCount.get(r.scriptName) || 0) + 1);
        for (const r of regex) {
            const places = (Array.isArray(r.placement) ? r.placement : []).map(n => REGEX_PLACEMENT[n] || n).join(',');
            let flags = '';
            if (r.disabled) flags += ' disabled="true"';
            if (r.promptOnly) flags += ' prompt_only="true"';
            if (r.markdownOnly) flags += ' display_only="true"';
            const idAttr = r.scriptName && nameCount.get(r.scriptName) === 1 ? '' : `id="${escAttr(r.id)}" `;
            lines.push(`<regex ${idAttr}name="${escAttr(r.scriptName || '')}" placement="${escAttr(places)}"${flags}/>`);
        }
        lines.push('</regex_scripts>');
    }

    const otherKeys = Object.entries(data)
        .filter(([k, v]) => v !== null && typeof v === 'object' && k !== 'prompts' && k !== 'prompt_order')
        .flatMap(([k, v]) => k === 'extensions' && v && !Array.isArray(v)
            ? Object.keys(v).filter(x => x !== 'regex_scripts').map(x => `extensions.${x}`)
            : [k]);
    if (otherKeys.length) lines.push(`Other data (kept unchanged, not editable here): ${otherKeys.join(', ')}`);

    lines.push('</attached_preset>');
    return protectVerbatim(`\n\n${lines.join('\n')}`);
}

export const PRESET_CHANGES_FORMAT = `\`\`\`preset-changes
<edit_prompt id="IDENTIFIER">
<<<<<<< ANCHOR
exact text copied from the prompt
=======
replacement text
>>>>>>> REPLACE
</edit_prompt>
<edit_prompt id="IDENTIFIER" enabled="false"/>
<edit_prompt id="IDENTIFIER" name="New name" role="user" position="in_chat" depth="2" order="100"/>
<add_prompt name="Prompt name" role="system" enabled="true" after="OTHER_ID">
full prompt text
</add_prompt>
<move_prompt id="IDENTIFIER" before="OTHER_ID"/>
<delete_prompt id="IDENTIFIER"/>
<set_setting key="temperature" value="0.9"/>
<set_setting key="impersonation_prompt">
full new text for a text setting
</set_setting>
<edit_regex name="Script name" disabled="true"/>
<edit_regex name="Script name"><find>/new pattern/g</find><replace>new replacement</replace></edit_regex>
<add_regex name="Script name" placement="ai_output"><find>/pattern/g</find><replace>replacement</replace></add_regex>
<delete_regex name="Script name"/>
\`\`\``;

export function buildPresetEditAIInstructions(preset) {
    if (!preset) return '';
    return `<preset_editing>
<context>
The Human attached a SillyTavern Chat Completion preset ("${escAttr(preset.fileName)}", working copy version ${preset.version || 1}). Its outline is in <attached_preset>. You can edit it; the Human reviews your changes, and the accepted result is offered to them as a downloadable .json file. Each accepted round becomes the new working copy that later edits build on.
If an <active_preset> block is also present, it describes the preset currently active in SillyTavern with macros expanded; it may be a different preset and is not what you edit here.
</context>

<how_it_works>
Never output the whole preset or raw preset JSON. End your reply with one \`preset-changes\` block of small operations; the extension applies them to the file and keeps everything else exactly as it was. Briefly explain the changes in plain text before the block. After the Human decides, the block is removed from the history, so do not repeat earlier blocks.
</how_it_works>

<rules>
- Refer to prompts by their id attribute exactly as shown in the outline.
- Before editing text, make sure you have the exact current text: if the outline only shows a preview, call read_preset first.
- edit_prompt with a body changes text. Use one or more ANCHOR/REPLACE patches; each ANCHOR must be copied exactly from the current text and appear only once in that prompt (include more surrounding text if needed). For long passages you may write "first few words || last few words". A body without ANCHOR markers replaces the whole prompt text.
- edit_prompt attributes change settings: enabled, name, role (system/user/assistant), position (relative or in_chat) with depth and order. A self-closing edit_prompt changes only those attributes.
- Turning a prompt on or off only needs enabled="true|false"; never rewrite its text for that.
- add_prompt: give after="ID" or before="ID" for its place in the order (default: end). move_prompt reorders an existing prompt the same way.
- Marker prompts (marker="true", e.g. chatHistory, charDescription, section headers) are placeholders whose text is never sent (unsent_text_chars shows stored text SillyTavern ignores); they can be toggled, renamed or moved but their text cannot be edited. Core prompts (${CORE_PROMPT_IDS.join(', ')}) cannot be deleted.
- set_setting changes a top-level setting from the <settings> list; the value keeps the setting's current type.
- Regex scripts are referred to by exact name (or id when shown). <find> and <replace> replace those fields entirely.
</rules>

<macros>
Preset text uses SillyTavern macros that are expanded only when the preset runs. Keep them exactly as written, including spacing and braces, unless the Human asks to change them:
- {{user}}, {{char}}, {{persona}}, {{description}}, {{scenario}} and similar insert values; {{outlet::Name}} inserts lorebook entries assigned to that outlet.
- {{// text}} is a comment that is removed; {{trim}} removes surrounding blank lines.
- {{setvar::name::value}}, {{getvar::name}}, {{.name = value}} and {{.name}} set and read variables.
- {{#if condition}} ... {{else}} ... {{/if}} is conditional text; every {{#if}} needs its {{/if}}. Moving or deleting text must never leave an {{#if}} without its {{/if}} or the reverse.
When adding text, follow the conventions this preset already uses.
</macros>

<format>
${PRESET_CHANGES_FORMAT}
</format>
</preset_editing>`;
}

// ─── Reading (read_preset tool) ──────────────────────────────────────────────

export function findPrompt(data, ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const s = String(ref).trim();
    const prompts = data?.prompts || [];
    const byId = prompts.find(p => p.identifier === s);
    if (byId) return byId;
    const byName = prompts.filter(p => (p.name || '').trim() === s);
    if (byName.length === 1) return byName[0];
    const ci = prompts.filter(p => (p.name || '').trim().toLowerCase() === s.toLowerCase());
    return ci.length === 1 ? ci[0] : null;
}

export function findRegex(data, ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const s = String(ref).trim();
    const list = data?.extensions?.regex_scripts || [];
    const byId = list.find(r => r.id === s);
    if (byId) return byId;
    const byName = list.filter(r => (r.scriptName || '').trim() === s);
    if (byName.length === 1) return byName[0];
    const ci = list.filter(r => (r.scriptName || '').trim().toLowerCase() === s.toLowerCase());
    return ci.length === 1 ? ci[0] : null;
}

const toList = v => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]));

export function readPresetItems(preset, input = {}) {
    if (!preset) return 'No preset is attached in this Copilot session.';
    const data = preset.data;
    const out = [];
    const promptRefs = [...toList(input.prompts), ...toList(input.prompt), ...toList(input.ids)];
    const regexRefs = [...toList(input.regex), ...toList(input.regex_scripts)];
    for (const ref of promptRefs) {
        const p = findPrompt(data, ref);
        if (!p) { out.push(`<error>No prompt with id or name "${escAttr(ref)}".</error>`); continue; }
        const content = typeof p.content === 'string' ? p.content : '';
        out.push(`<prompt id="${escAttr(p.identifier)}" name="${escAttr(p.name || '')}" chars="${content.length}">\n${content}\n</prompt>`);
    }
    for (const ref of regexRefs) {
        const r = findRegex(data, ref);
        if (!r) { out.push(`<error>No regex script with id or name "${escAttr(ref)}".</error>`); continue; }
        const places = (r.placement || []).map(n => REGEX_PLACEMENT[n] || n).join(',');
        out.push(`<regex id="${escAttr(r.id)}" name="${escAttr(r.scriptName || '')}" placement="${places}" disabled="${!!r.disabled}">\n<find>${r.findRegex ?? ''}</find>\n<replace>${r.replaceString ?? ''}</replace>\n</regex>`);
    }
    if (!out.length) return 'Pass "prompts" (ids or names) and/or "regex" (ids or names) to read.';
    return out.join('\n\n');
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const OPS = ['edit_prompt', 'add_prompt', 'move_prompt', 'delete_prompt', 'set_setting', 'edit_regex', 'add_regex', 'delete_regex'];

function decodeEntities(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseAttrs(str) {
    const attrs = {};
    const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(str)) !== null) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
    return attrs;
}

// Drop the newline right after the opening tag and right before the closing tag; keep the rest.
function trimBody(body) {
    return body.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function extractBlock(text) {
    if (typeof text !== 'string') return null;
    const strict = text.match(/```preset-changes[^\S\r\n]*\r?\n?([\s\S]*?)```(?!\w)/);
    if (strict) return strict[1];
    const open = text.match(/```preset-changes[^\S\r\n]*\r?\n?([\s\S]*)$/);
    return open ? open[1] : null;
}

function childTag(body, tag) {
    const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1] : undefined;
}

export function parsePresetChangesFromText(text) {
    const block = extractBlock(text);
    if (!block) return null;
    const changes = [];
    const tagRe = new RegExp(`<(${OPS.join('|')})\\b([^>]*?)(\\/?)>`, 'gi');
    let m;
    while ((m = tagRe.exec(block)) !== null) {
        const op = m[1].toLowerCase();
        const attrs = parseAttrs(m[2]);
        let body;
        if (!m[3]) {
            const closeRe = new RegExp(`</${op}\\s*>`, 'i');
            const rest = block.slice(tagRe.lastIndex);
            const close = rest.match(closeRe);
            if (!close) break; // truncated block: drop the incomplete operation
            body = rest.slice(0, close.index);
            tagRe.lastIndex += close.index + close[0].length;
        }
        const change = { op, ...attrs };
        if (body !== undefined) {
            if (op === 'edit_regex' || op === 'add_regex') {
                const find = childTag(body, 'find');
                const replace = childTag(body, 'replace');
                if (find !== undefined) change.find = find;
                if (replace !== undefined) change.replace = replace;
            } else if (/<{5,}[ \t]*(?:SEARCH|ANCHOR)/.test(body) && op === 'edit_prompt') {
                change.patches = parseAnchorPatches(body);
            } else {
                change.content = trimBody(body);
            }
        }
        changes.push(change);
    }
    return changes.length ? changes : null;
}

export function stripPresetChangesBlock(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/```preset-changes[\s\S]*?```(?!\w)/g, '').replace(/```preset-changes[\s\S]*$/g, '').trim();
}

// ─── Applying ────────────────────────────────────────────────────────────────

function countOccurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}

// Finds `needle` in `hay` ignoring differences in runs of whitespace. Returns [start, end] in hay.
function findWhitespaceInsensitive(hay, needle) {
    const parts = needle.trim().split(/\s+/).filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!parts.length) return null;
    const re = new RegExp(parts.join('\\s+'), 'g');
    const matches = [...hay.matchAll(re)];
    if (matches.length !== 1) return matches.length ? { ambiguous: matches.length } : null;
    return { start: matches[0].index, end: matches[0].index + matches[0][0].length };
}

function locate(src, needle) {
    const exact = countOccurrences(src, needle);
    if (exact === 1) { const i = src.indexOf(needle); return { start: i, end: i + needle.length }; }
    if (exact > 1) return { ambiguous: exact };
    return findWhitespaceInsensitive(src, needle);
}

// Applies one ANCHOR/REPLACE patch. Exact (or whitespace-insensitive) unique matches only;
// a fuzzy fallback is allowed but reported so the Human can check the diff.
export function applyPresetPatch(src, search, replace) {
    const s = (search || '').trim();
    if (!s) return { error: 'Empty ANCHOR' };
    const sep = s.indexOf('||');
    if (sep > 0 && s.length - sep - 2 > 0) {
        const head = s.slice(0, sep).trim();
        const tail = s.slice(sep + 2).trim();
        const a = locate(src, head);
        if (a?.ambiguous) return { error: `ANCHOR start "${head.slice(0, 40)}" appears ${a.ambiguous} times; include more text` };
        if (a) {
            const rest = src.slice(a.end);
            const b = locate(rest, tail);
            if (b && !b.ambiguous) return { result: src.slice(0, a.start) + replace + src.slice(a.end + b.end) };
            if (b?.ambiguous) {
                const i = rest.indexOf(tail);
                if (i !== -1) return { result: src.slice(0, a.start) + replace + src.slice(a.end + i + tail.length) };
            }
        }
    } else {
        const loc = locate(src, s);
        if (loc?.ambiguous) return { error: `ANCHOR "${s.slice(0, 40)}" appears ${loc.ambiguous} times; include more text` };
        if (loc) return { result: src.slice(0, loc.start) + replace + src.slice(loc.end) };
    }
    const fuzzy = applySearchReplaceToField(src, s, replace);
    if (fuzzy.matched && fuzzy.result !== src) return { result: fuzzy.result, fuzzy: true };
    return { error: `ANCHOR not found: "${s.slice(0, 60)}"` };
}

const parseBool = v => (v === undefined ? undefined : /^(true|1|yes|on)$/i.test(String(v).trim()));

function parseIntAttr(v) {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function genPromptId(data) {
    const used = new Set((data.prompts || []).map(p => p.identifier));
    let id;
    do {
        id = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`);
    } while (used.has(id));
    return id;
}

function insertIntoOrder(list, entry, change) {
    const ref = change.after ?? change.before;
    const idx = ref !== undefined ? list.findIndex(e => e.identifier === ref) : -1;
    if (idx === -1) list.push(entry);
    else list.splice(change.after !== undefined ? idx + 1 : idx, 0, entry);
}

// Resolves after/before references (which may be names) to identifiers.
function resolvePlacement(data, change) {
    const out = {};
    for (const k of ['after', 'before']) {
        if (change[k] === undefined) continue;
        const p = findPrompt(data, change[k]);
        if (!p) return { error: `No prompt "${change[k]}" for ${k}=` };
        out[k] = p.identifier;
    }
    return out;
}

function applyPromptAttrs(p, c, data) {
    if (c.name !== undefined) p.name = c.name;
    if (c.role !== undefined) {
        const role = c.role.toLowerCase();
        if (!['system', 'user', 'assistant'].includes(role)) throw new Error(`Invalid role "${c.role}"`);
        p.role = role;
    }
    const pos = c.position ?? c.injection_position;
    if (pos !== undefined) {
        const v = /^(1|in_chat|in-chat|absolute|depth)$/i.test(pos) ? 1 : /^(0|relative)$/i.test(pos) ? 0 : null;
        if (v === null) throw new Error(`Invalid position "${pos}"`);
        p.injection_position = v;
    }
    for (const [attr, key] of [['depth', 'injection_depth'], ['injection_depth', 'injection_depth'], ['order', 'injection_order'], ['injection_order', 'injection_order']]) {
        if (c[attr] === undefined) continue;
        const n = parseIntAttr(c[attr]);
        if (Number.isNaN(n) || n < 0) throw new Error(`Invalid ${attr} "${c[attr]}"`);
        p[key] = n;
    }
    if (c.enabled !== undefined) {
        const en = parseBool(c.enabled);
        const lists = data.prompt_order || [];
        let found = false;
        for (const o of lists) for (const e of (o.order || [])) if (e.identifier === p.identifier) { e.enabled = en; found = true; }
        if (!found) for (const o of lists) if (Array.isArray(o.order)) o.order.push({ identifier: p.identifier, enabled: en });
    }
}

function coerceSetting(oldVal, raw, key) {
    if (typeof oldVal === 'number') {
        const n = Number(String(raw).trim());
        if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
        return n;
    }
    if (typeof oldVal === 'boolean') {
        if (!/^(true|false)$/i.test(String(raw).trim())) throw new Error(`"${key}" must be true or false`);
        return /^true$/i.test(String(raw).trim());
    }
    if (oldVal === null) {
        try { return JSON.parse(raw); } catch (_) { return raw; }
    }
    return String(raw);
}

function parsePlacement(v) {
    const out = [];
    for (const part of String(v || 'ai_output').split(/[,\s]+/).filter(Boolean)) {
        const n = REGEX_PLACEMENT_REV[part.toLowerCase()] ?? (Number.isFinite(Number(part)) ? Number(part) : null);
        if (n === null) throw new Error(`Unknown placement "${part}"`);
        out.push(n);
    }
    return out;
}

// Applies one change to `data` in place. Returns { label, before?, after?, warning? } or throws.
function applyOne(data, c) {
    const promptLabel = p => `"${p.name || p.identifier}"`;
    switch (c.op) {
        case 'edit_prompt': {
            const p = findPrompt(data, c.id ?? c.name);
            if (!p) throw new Error(`No prompt with id "${c.id ?? c.name}"`);
            const before = typeof p.content === 'string' ? p.content : '';
            let after = before;
            let warning;
            if (c.patches?.length || c.content !== undefined) {
                if (p.marker) throw new Error(`${promptLabel(p)} is a marker and has no text`);
                if (c.patches?.length) {
                    for (const patch of c.patches) {
                        const r = applyPresetPatch(after, patch.search, patch.replace);
                        if (r.error) throw new Error(r.error);
                        if (r.fuzzy) warning = 'Approximate ANCHOR match; check the diff';
                        after = r.result;
                    }
                } else after = c.content;
                p.content = after;
            }
            const attrCopy = { ...c };
            if (c.id === undefined) delete attrCopy.name; // name was used to find the prompt
            applyPromptAttrs(p, attrCopy, data);
            return { label: `Prompt ${promptLabel(p)}: ${promptEditSummary(c)}`, before, after, warning, textChanged: before !== after };
        }
        case 'add_prompt': {
            if (c.content === undefined || !c.content.trim()) throw new Error('add_prompt needs text');
            const placement = resolvePlacement(data, c);
            if (placement.error) throw new Error(placement.error);
            let id = c.id && !findPrompt(data, c.id) ? c.id : genPromptId(data);
            const p = {
                identifier: id, system_prompt: false, enabled: false, marker: false,
                name: c.name || 'New Prompt', role: 'system', content: c.content,
                injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false,
            };
            applyPromptAttrs(p, { ...c, enabled: undefined }, data);
            data.prompts.push(p);
            const enabled = c.enabled === undefined ? true : parseBool(c.enabled);
            for (const o of data.prompt_order) if (Array.isArray(o.order)) insertIntoOrder(o.order, { identifier: id, enabled }, placement);
            return { label: `Add prompt "${p.name}"`, before: '', after: p.content, textChanged: true };
        }
        case 'move_prompt': {
            const p = findPrompt(data, c.id ?? c.name);
            if (!p) throw new Error(`No prompt with id "${c.id ?? c.name}"`);
            const placement = resolvePlacement(data, c);
            if (placement.error) throw new Error(placement.error);
            if (placement.after === undefined && placement.before === undefined) throw new Error('move_prompt needs after= or before=');
            if (placement.after === p.identifier || placement.before === p.identifier) throw new Error('Cannot move a prompt relative to itself');
            for (const o of data.prompt_order) {
                if (!Array.isArray(o.order)) continue;
                const i = o.order.findIndex(e => e.identifier === p.identifier);
                const entry = i === -1 ? { identifier: p.identifier, enabled: true } : o.order.splice(i, 1)[0];
                insertIntoOrder(o.order, entry, placement);
            }
            const where = placement.after !== undefined ? `after "${findPrompt(data, placement.after)?.name || placement.after}"` : `before "${findPrompt(data, placement.before)?.name || placement.before}"`;
            return { label: `Move prompt ${promptLabel(p)} ${where}` };
        }
        case 'delete_prompt': {
            const p = findPrompt(data, c.id ?? c.name);
            if (!p) throw new Error(`No prompt with id "${c.id ?? c.name}"`);
            if (CORE_PROMPT_IDS.includes(p.identifier)) throw new Error(`${promptLabel(p)} is a core prompt and cannot be deleted (disable it instead)`);
            data.prompts.splice(data.prompts.indexOf(p), 1);
            for (const o of data.prompt_order) if (Array.isArray(o.order)) o.order = o.order.filter(e => e.identifier !== p.identifier);
            return { label: `Delete prompt ${promptLabel(p)}`, before: p.content || '', after: '', textChanged: !!p.content };
        }
        case 'set_setting': {
            const key = c.key;
            if (!key || !(key in data)) throw new Error(`Unknown setting "${key}"`);
            const old = data[key];
            if (old !== null && typeof old === 'object') throw new Error(`"${key}" is not a simple setting`);
            const raw = c.value !== undefined ? c.value : c.content;
            if (raw === undefined) throw new Error(`No value for "${key}"`);
            data[key] = coerceSetting(old, raw, key);
            const isText = typeof old === 'string';
            return {
                label: `Set ${key}${isText ? '' : `: ${formatScalar(old)} → ${formatScalar(data[key])}`}`,
                before: isText ? old : undefined, after: isText ? data[key] : undefined, textChanged: isText && old !== data[key],
            };
        }
        case 'edit_regex': {
            const r = findRegex(data, c.id ?? c.name);
            if (!r) throw new Error(`No regex script "${c.id ?? c.name}"`);
            const before = `find: ${r.findRegex ?? ''}\nreplace: ${r.replaceString ?? ''}`;
            if (c.find !== undefined) r.findRegex = c.find;
            if (c.replace !== undefined) r.replaceString = c.replace;
            if (c.new_name !== undefined) r.scriptName = c.new_name;
            if (c.disabled !== undefined) r.disabled = parseBool(c.disabled);
            if (c.enabled !== undefined) r.disabled = !parseBool(c.enabled);
            if (c.placement !== undefined) r.placement = parsePlacement(c.placement);
            const after = `find: ${r.findRegex ?? ''}\nreplace: ${r.replaceString ?? ''}`;
            return { label: `Edit regex "${r.scriptName || r.id}"`, before, after, textChanged: before !== after };
        }
        case 'add_regex': {
            if (!c.find) throw new Error('add_regex needs <find>');
            if (!data.extensions || typeof data.extensions !== 'object') data.extensions = {};
            if (!Array.isArray(data.extensions.regex_scripts)) data.extensions.regex_scripts = [];
            const r = {
                id: globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
                scriptName: c.name || 'New Regex', findRegex: c.find, replaceString: c.replace ?? '', trimStrings: [],
                placement: parsePlacement(c.placement), disabled: parseBool(c.disabled) || false,
                markdownOnly: parseBool(c.display_only) || false, promptOnly: parseBool(c.prompt_only) || false,
                runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
            };
            data.extensions.regex_scripts.push(r);
            return { label: `Add regex "${r.scriptName}"`, before: '', after: `find: ${r.findRegex}\nreplace: ${r.replaceString}`, textChanged: true };
        }
        case 'delete_regex': {
            const list = data.extensions?.regex_scripts;
            const r = findRegex(data, c.id ?? c.name);
            if (!r) throw new Error(`No regex script "${c.id ?? c.name}"`);
            list.splice(list.indexOf(r), 1);
            return { label: `Delete regex "${r.scriptName || r.id}"` };
        }
        default:
            throw new Error(`Unknown operation "${c.op}"`);
    }
}

// Applies changes in order to a copy of `data`. Failed changes are skipped and reported;
// the rest still apply. `data` itself is never modified.
export function applyPresetChanges(data, changes) {
    const next = structuredClone(data);
    const results = [];
    for (const c of changes || []) {
        const snapshot = structuredClone(next);
        try {
            results.push({ ok: true, ...applyOne(next, c) });
        } catch (e) {
            // Roll back partial edits from this change.
            for (const k of Object.keys(next)) delete next[k];
            Object.assign(next, snapshot);
            results.push({ ok: false, label: describePresetChange(c, data), error: e.message });
        }
    }
    return { data: next, results };
}

// "edit text, turn off, change name" for an edit_prompt change.
function promptEditSummary(c) {
    const parts = [];
    if (c.patches?.length || c.content !== undefined) parts.push('edit text');
    if (c.enabled !== undefined) parts.push(parseBool(c.enabled) ? 'turn on' : 'turn off');
    const settings = ['role', 'position', 'injection_position', 'depth', 'injection_depth', 'order', 'injection_order'].filter(k => c[k] !== undefined);
    if (c.id !== undefined && c.name !== undefined) parts.unshift('rename');
    if (settings.length) parts.push(`change ${settings.join(', ')}`);
    return parts.join(', ') || 'no change';
}

export function describePresetChange(c, data) {
    const name = ref => {
        const p = data && findPrompt(data, ref);
        return `"${p?.name || ref}"`;
    };
    switch (c.op) {
        case 'edit_prompt': return `Prompt ${name(c.id ?? c.name)}: ${promptEditSummary(c)}`;
        case 'add_prompt': return `Add prompt "${c.name || 'New Prompt'}"`;
        case 'move_prompt': return `Move prompt ${name(c.id ?? c.name)}`;
        case 'delete_prompt': return `Delete prompt ${name(c.id ?? c.name)}`;
        case 'set_setting': return `Set ${c.key}`;
        case 'edit_regex': return `Edit regex "${c.id ?? c.name}"`;
        case 'add_regex': return `Add regex "${c.name || 'New Regex'}"`;
        case 'delete_regex': return `Delete regex "${c.id ?? c.name}"`;
        default: return c.op;
    }
}

// Sanity checks on a result before it is offered for download.
export function validatePresetData(data) {
    const problems = [];
    if (!isChatCompletionPresetData(data)) return ['Not a Chat Completion preset'];
    const ids = new Set();
    for (const p of data.prompts) {
        if (!p.identifier) problems.push('A prompt has no identifier');
        else if (ids.has(p.identifier)) problems.push(`Duplicate prompt id "${p.identifier}"`);
        ids.add(p.identifier);
    }
    for (const o of data.prompt_order) {
        for (const e of (o.order || [])) if (!ids.has(e.identifier)) problems.push(`prompt_order refers to missing prompt "${e.identifier}"`);
    }
    try { JSON.parse(JSON.stringify(data)); } catch (_) { problems.push('Not serializable'); }
    return problems;
}
