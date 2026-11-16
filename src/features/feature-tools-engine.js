import { DEFAULT_TOOLS_PROMPT, TOOL_CALL_FORMAT_BLOCK, TOOL_DEFINITIONS } from '../constants.js';
import { getSettings, getCurrentSession } from '../session.js';
import { getSessionPreset, readPresetItems } from './feature-preset-engine.js';
import { _ensureWrapped } from '../utils/util-text.js';
import { getCharInfo, getTagsForCharacter } from '../utils/util-st.js';
import { fetchWorldInfoBook, getDisplayName, getActiveLorebookNames, wiEntriesToArray } from './feature-lorebook-engine.js';

// Always available while the Copilot session has an attached preset, even with tools off:
// large presets are only outlined in context, so this is how the model reads exact text.
export const READ_PRESET_TOOL = {
    id: 'read_preset',
    name: 'read_preset',
    label: 'Read Attached Preset',
    icon: 'fa-sliders',
    description: 'Return the exact full text of prompts and/or regex scripts from the preset attached in this session. Use before editing a prompt whose text is only previewed. For a whole-preset review, pass {"all": true} once.',
    schema: {
        type: 'object',
        properties: {
            all: { type: 'boolean', description: 'Return every enabled prompt with text, in order (one call for a whole-preset review)' },
            include_disabled: { type: 'boolean', description: 'With all: also include disabled prompts' },
            prompts: { type: 'array', items: { type: 'string' }, description: 'Prompt ids (or exact names) to read' },
            regex: { type: 'array', items: { type: 'string' }, description: 'Regex script names (or ids) to read' },
        },
    },
};

function _sessionHasPreset() {
    try { return !!getSessionPreset(getCurrentSession()); } catch (_) { return false; }
}

export function getEnabledTools() {
    const s = getSettings();
    const tools = s.toolsEnabled ? TOOL_DEFINITIONS.filter(t => s[t.settingKey] !== false) : [];
    if (_sessionHasPreset()) tools.push(READ_PRESET_TOOL);
    return tools;
}

export function buildAnthropicToolsPayload() {
    return getEnabledTools().map(t => ({
        name: t.name,
        description: t.label + ': ' + t.description,
        input_schema: t.schema,
    }));
}

export async function executeTool(toolName, toolInput) {
    const ctx = SillyTavern.getContext();
    switch (toolName) {
        case 'read_preset':
            return readPresetItems(getSessionPreset(getCurrentSession()), toolInput || {});
        case 'search_chat': {
            const msgs = ctx.chat || [];
            let rawQueries = Array.isArray(toolInput.queries) ? toolInput.queries : (Array.isArray(toolInput.query) ? toolInput.query : [toolInput.query || '']);
            const parsedQueries = rawQueries.map(q => {
                const s = String(q);
                const regexMatch = s.match(/^\/(.+)\/([gimsuy]*)$/);
                if (regexMatch) {
                    try { return { type: 'regex', re: new RegExp(regexMatch[1], regexMatch[2]) }; } catch(_) {}
                }
                return { type: 'text', lq: s.toLowerCase() };
            });
            const role = toolInput.role || 'all';
            const fromIdx = toolInput.from_index ?? 0;
            const toIdx = toolInput.to_index ?? msgs.length - 1;
            const maxResults = Math.min(toolInput.max_results ?? 10, 50);
            const includeContent = toolInput.include_content !== false;
            
            const results = [];
            for (let i = Math.max(0, fromIdx); i <= Math.min(msgs.length - 1, toIdx); i++) {
                const m = msgs[i];
                if (role === 'user' && !m.is_user) continue;
                if (role === 'assistant' && m.is_user) continue;
                const text = m.mes || '';
                
                let matched = false;
                for (const pq of parsedQueries) {
                    if (pq.type === 'regex' && pq.re) {
                        pq.re.lastIndex = 0;
                        if (pq.re.test(text)) { matched = true; break; }
                    } else {
                        if (text.toLowerCase().includes(pq.lq)) { matched = true; break; }
                        const tokens = pq.lq.split(/\s+/).filter(Boolean);
                        if (tokens.length > 1 && tokens.every(t => text.toLowerCase().includes(t))) { matched = true; break; }
                    }
                }
                
                if (matched) {
                    const entry = { index: i, role: m.is_user ? 'user' : 'assistant', name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')) };
                    if (includeContent) entry.content = text.length > 500 ? text.slice(0, 500) + '...[truncated]' : text;
                    results.push(entry);
                    if (results.length >= maxResults) break;
                }
            }
            return { found: results.length, results, note: `Use 'index' values in chat-changes proposals. Total messages searched: ${Math.min(msgs.length - 1, toIdx) - Math.max(0, fromIdx) + 1}` };
        }
        case 'search_lorebook_entry': {
            const activeBooks = getActiveLorebookNames();
            let rawQueries = Array.isArray(toolInput.queries) ? toolInput.queries : (Array.isArray(toolInput.query) ? toolInput.query : [toolInput.query || '']);
            const parsedQueries = rawQueries.map(q => {
                const s = String(q);
                const regexMatch = s.match(/^\/(.+)\/([gimsuy]*)$/);
                if (regexMatch) {
                    try { return { type: 'regex', re: new RegExp(regexMatch[1], regexMatch[2]) }; } catch(_) {}
                }
                return { type: 'text', lq: s.toLowerCase() };
            });
            
            const targetBook = toolInput.book_name;
            const searchIn = toolInput.search_in || 'all';
            const onlyConstant = !!toolInput.only_constant;
            const onlyOutlet = !!toolInput.only_outlet;
            const results = [];
            for (const bookName of activeBooks) {
                if (targetBook && !bookName.toLowerCase().includes(targetBook.toLowerCase())) continue;
                const data = await fetchWorldInfoBook(bookName).catch(() => null);
                if (!data) continue;
                for (const entry of wiEntriesToArray(data)) {
                    const outletField = (entry.outlet || entry.outlet_name || entry.outletName || entry.automation_id || entry.automationId || '').trim();
                    const isOutletPos = String(entry.position) === '5' || String(entry.position).toLowerCase() === 'outlet';
                    const isEntryOutlet = isOutletPos || outletField !== '';
                    if (onlyConstant && !entry.constant) continue;
                    if (onlyOutlet && !isEntryOutlet) continue;
                    
                    const name = (entry.comment || '');
                    const keys = (entry.key || []).join(' ');
                    const text = (entry.content || '');
                    
                    let matched = false;
                    for (const pq of parsedQueries) {
                        if (pq.type === 'regex' && pq.re) {
                            pq.re.lastIndex = 0;
                            if (searchIn === 'all') {
                                matched = pq.re.test(name) || pq.re.test(keys) || pq.re.test(text);
                            } else if (searchIn === 'name') {
                                matched = pq.re.test(name);
                            } else if (searchIn === 'keys') {
                                matched = pq.re.test(keys);
                            } else if (searchIn === 'content') {
                                matched = pq.re.test(text);
                            }
                        } else {
                            const lq = pq.lq;
                            const lname = name.toLowerCase();
                            const lkeys = keys.toLowerCase();
                            const ltext = text.toLowerCase();
                            if (searchIn === 'all') {
                                matched = lname.includes(lq) || lkeys.includes(lq) || ltext.includes(lq);
                            } else if (searchIn === 'name') {
                                matched = lname.includes(lq);
                            } else if (searchIn === 'keys') {
                                matched = lkeys.includes(lq);
                            } else if (searchIn === 'content') {
                                matched = ltext.includes(lq);
                            }
                        }
                        if (matched) break;
                    }
                    
                    if (matched) results.push({
                        book: getDisplayName(bookName),
                        uid: entry.uid,
                        name: entry.comment || `Entry #${entry.uid}`,
                        keys: entry.key || [],
                        content_preview: (entry.content || '').slice(0, 200) + ((entry.content || '').length > 200 ? '...' : ''),
                        is_constant: !!entry.constant,
                        is_outlet: isEntryOutlet,
                        outlet_name: outletField || null,
                        disabled: !!entry.disable,
                    });
                    if (results.length >= 20) break;
                }
                if (results.length >= 20) break;
            }
            return { found: results.length, results };
        }
        case 'get_lorebooks': {
            const activeBooks = getActiveLorebookNames();
            const includeEntries = !!toolInput.include_entries;
            const specificBook = toolInput.book_name;
            if (!includeEntries) {
                return {
                    lorebooks: activeBooks.map(name => ({ name: getDisplayName(name), internal_name: name })),
                    total: activeBooks.length,
                };
            }
            const booksToProcess = specificBook
                ? activeBooks.filter(n => n === specificBook || getDisplayName(n) === specificBook)
                : activeBooks;
            const result = {};
            for (const name of booksToProcess) {
                const data = await fetchWorldInfoBook(name).catch(() => null);
                if (!data) { result[getDisplayName(name)] = []; continue; }
                result[getDisplayName(name)] = wiEntriesToArray(data).map(e => {
                    const outletField = (e.outlet || e.outlet_name || e.outletName || e.automation_id || e.automationId || '').trim();
                    const isOutletPos = String(e.position) === '5' || String(e.position).toLowerCase() === 'outlet';
                    return {
                        name: e.comment || `#${e.uid}`,
                        uid: e.uid,
                        is_constant: !!e.constant,
                        is_outlet: isOutletPos || outletField !== '',
                        outlet_name: outletField || null,
                        disabled: !!e.disable,
                    };
                });
            }
            return { lorebooks: result };
        }
        case 'ask_user': {
            return { __ask_user: true, question: toolInput.question, context: toolInput.context };
        }
        case 'get_char_info': {
            const charInfoFull = getCharInfo();
            if (!charInfoFull) return { error: 'No active character.' };
            const charCtx = ctx.characters?.[ctx.characterId];
            const requestedFields = toolInput.fields || ['description', 'personality', 'scenario'];
            const result = { name: charInfoFull.name };
            for (const f of requestedFields) {
                if (f === 'tags') result.tags = getTagsForCharacter(charCtx);
                else if (f === 'alternate_greetings') result.alternate_greetings = (charCtx?.data?.alternate_greetings || []);
                else result[f] = (charInfoFull[f] || charCtx?.data?.[f] || '');
            }
            return result;
        }
        case 'get_chat_stats': {
            const msgs = ctx.chat || [];
            const userMsgs = msgs.filter(m => m.is_user);
            const asMsgs = msgs.filter(m => !m.is_user);
            const totalChars = msgs.reduce((s, m) => s + (m.mes || '').length, 0);
            return {
                total_messages: msgs.length,
                user_messages: userMsgs.length,
                assistant_messages: asMsgs.length,
                approx_tokens: Math.ceil(totalChars / 3.5),
                first_message_index: 0,
                last_message_index: msgs.length - 1,
                char_name: ctx.name2 || 'Character',
                user_name: ctx.name1 || 'User',
            };
        }
        case 'get_recent_messages': {
            const msgs = ctx.chat || [];
            const count = Math.min(toolInput.count ?? 10, 50);
            const fromEnd = toolInput.from_end !== false;
            const role = toolInput.role || 'all';
            let filtered = msgs.map((m, i) => ({ ...m, _idx: i }));
            if (role === 'user') filtered = filtered.filter(m => m.is_user);
            if (role === 'assistant') filtered = filtered.filter(m => !m.is_user);
            if (fromEnd) filtered = filtered.slice(-count);
            else filtered = filtered.slice(0, count);
            return {
                messages: filtered.map(m => ({
                    index: m._idx,
                    role: m.is_user ? 'user' : 'assistant',
                    name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
                    content: (m.mes || '').length > 600 ? m.mes.slice(0, 600) + '...[truncated]' : (m.mes || ''),
                })),
                note: 'Use "index" values in chat-changes proposals for precise targeting.',
            };
        }
        default: return { error: `Unknown tool: ${toolName}` };
    }
}

export function parseToolCallsFromText(text) {
    const results = [];
    const re = /```tool_call\n?([\s\S]*?)(?:```|$)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const rawBlock = m[1].trim();
        if (!rawBlock) continue;

        let extracted = [];

        try {
            const parsed = JSON.parse(rawBlock);
            if (Array.isArray(parsed)) {
                extracted = parsed.filter(p => p && p.name).map(p => ({ name: p.name, input: p.input || {} }));
            } else if (parsed && parsed.name) {
                extracted.push({ name: parsed.name, input: parsed.input || {} });
            }
        } catch (_) {}

        if (!extracted.length) {
            try {
                const fixedRaw = '[' + rawBlock.replace(/}\s*{/g, '},{') + ']';
                const parsed = JSON.parse(fixedRaw);
                if (Array.isArray(parsed)) {
                    extracted = parsed.filter(p => p && p.name).map(p => ({ name: p.name, input: p.input || {} }));
                }
            } catch (_) {}
        }

        if (!extracted.length) {
            const lines = rawBlock.split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line.trim());
                    if (parsed && parsed.name) {
                        extracted.push({ name: parsed.name, input: parsed.input || {} });
                    }
                } catch (_) {}
            }
        }

        if (!extracted.length) {
            const nameMatch = rawBlock.match(/"name"\s*:\s*"([^"]+)"/);
            if (nameMatch) {
                extracted.push({ name: nameMatch[1], input: {} });
            } else {
                extracted.push({ name: 'parsing...', input: {} });
            }
        }

        results.push(...extracted);
    }
    return results;
}

// ─── Lenient parsing for running tools ───────────────────────────────────────
// Models do not always use the exact ```tool_call format. Gemini tends to write ```tool_code
// with a Python-style call, Hermes/Qwen-style models use <tool_call> tags, and some put JSON
// with "arguments" in a ```json block. These are only accepted for known tool names.

const KNOWN_TOOL_NAMES = () => new Set([...TOOL_DEFINITIONS.map(t => t.name), READ_PRESET_TOOL.name]);

function _normalizeCall(obj, known) {
    if (!obj || typeof obj !== 'object') return null;
    const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
    const name = fn.name || obj.tool || obj.tool_name;
    if (!name || !known.has(name)) return null;
    let input = fn.input ?? fn.arguments ?? fn.parameters ?? fn.args ?? obj.input ?? {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) { input = {}; } }
    return { name, input: input && typeof input === 'object' ? input : {} };
}

// Python-ish value: True/False/None, quotes, numbers, lists, dicts.
function _pyValue(raw) {
    const v = raw.trim()
        .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, x) => JSON.stringify(x));
    return JSON.parse(v);
}

function _splitTopLevel(str) {
    const parts = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (quote) { cur += ch; if (ch === '\\') { cur += str[++i] ?? ''; } else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

function _parsePythonCall(src, known) {
    // First call to a known tool name, e.g. inside print(default_api.read_preset(all=True)).
    let name = null, argStart = -1;
    for (const m of src.matchAll(/(\w+)\s*\(/g)) {
        if (known.has(m[1])) { name = m[1]; argStart = m.index + m[0].length; break; }
    }
    if (!name) return null;
    let depth = 1, i = argStart, quote = null;
    for (; i < src.length && depth > 0; i++) {
        const ch = src[i];
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
    }
    const args = src.slice(argStart, depth === 0 ? i - 1 : i);
    const input = {};
    for (const part of _splitTopLevel(args)) {
        const kv = part.match(/^\s*(\w+)\s*=\s*([\s\S]+)$/);
        if (!kv) continue;
        try { input[kv[1]] = _pyValue(kv[2]); } catch (_) { input[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, ''); }
    }
    return { name, input };
}

function _parseCallBody(body, known) {
    const raw = body.trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return (Array.isArray(parsed) ? parsed : [parsed]).map(x => _normalizeCall(x, known)).filter(Boolean);
    } catch (_) { /* not JSON */ }
    const py = _parsePythonCall(raw, known);
    return py ? [py] : [];
}

// Tool calls to run for a reply: the standard format first, then common variants.
export function parseToolCallsLenient(text) {
    if (typeof text !== 'string' || !text) return [];
    const known = KNOWN_TOOL_NAMES();
    const strict = parseToolCallsFromText(text).filter(c => c.name !== 'parsing...');
    if (strict.length) return strict;
    const calls = [];
    const fence = /```(?:tool_code|tool_use|tool_calls?|function_call|tool|python|json)[^\n]*\n([\s\S]*?)```/gi;
    for (const m of text.matchAll(fence)) calls.push(..._parseCallBody(m[1], known));
    const tags = /<(tool_call|function_call|tool_use)>([\s\S]*?)<\/\1>/gi;
    for (const m of text.matchAll(tags)) calls.push(..._parseCallBody(m[2], known));
    return calls;
}

// Whether a reply looks like it meant to call a tool (for diagnostics when nothing parsed).
export function mentionsToolCall(text) {
    if (typeof text !== 'string' || !text) return false;
    if (/```tool|<tool_call>|<function_call>/i.test(text)) return true;
    return [...KNOWN_TOOL_NAMES()].some(n => text.includes(n));
}

export function stripToolCallsFromText(text) {
    return text.replace(/```tool_call[\s\S]*?```/gi, '').trim();
}

export function buildToolCallsSystemBlock() {
    const tools = getEnabledTools();
    if (!tools.length) return '';
    const s = getSettings();
    
    const formatSchemaProps = (properties) => {
        if (!properties || Object.keys(properties).length === 0) return '{}';
        const lines = [];
        for (const [key, prop] of Object.entries(properties)) {
            lines.push(`"${key}": ${JSON.stringify(prop)}`);
        }
        return `{${lines.join(',\n    ')}}`;
    };

    const toolsList = tools.map(t =>
        `- **${t.name}**: ${t.description} | Params: ${formatSchemaProps(t.schema.properties)}`
    ).join("\n");
    
    let prompt = s.toolsSystemPrompt || DEFAULT_TOOLS_PROMPT;
    if (!prompt.includes('{{tools_list}}')) {
        prompt += '\n\nTools available:\n{{tools_list}}';
    }
    if (!prompt.includes('{{tool_call_format}}')) {
        prompt = prompt.replace('Format requirement:', 'Format requirement:\n{{tool_call_format}}');
    }
    
    const finalPrompt = prompt
        .replace('{{tools_list}}', toolsList)
        .replace('{{tool_call_format}}', TOOL_CALL_FORMAT_BLOCK);
        
    return '\n\n' + _ensureWrapped(finalPrompt, 'tool_calls_system');
}