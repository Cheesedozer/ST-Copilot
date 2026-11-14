import { expandMacros } from '../session.js';

export function getTagsForCharacter(char) {
    if (!char) return [];
    const ctx = SillyTavern.getContext();
    const avatar = char.avatar;
    if (!avatar) return [];
    
    const tagMap = ctx.tagMap || {};
    const tagIds = tagMap[avatar];
    if (!Array.isArray(tagIds)) return [];
    
    const allTags = ctx.tags || [];
    return tagIds.map(id => {
        const found = allTags.find(t => t.id === id);
        return found ? found.name : null;
    }).filter(Boolean);
}

export function getCharInfo() {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) return null;
    
    const d = char.data || {};
    const ov = ctx.chatMetadata?.character_overrides || {};
    
    const get = (field, macro) => {
        if (ov[field]) return ov[field];
        if (macro) {
            try { const r = expandMacros(macro); if (r && r !== macro) return r; } catch(_) {}
        }
        return d[field] || char[field] || '';
    };

    const getCharNote = () => {
        if (ov.depth_prompt && ov.depth_prompt.prompt) return ov.depth_prompt.prompt;
        return d.extensions?.depth_prompt?.prompt || char.extensions?.depth_prompt?.prompt || '';
    };

    return {
        name: char.name || 'Unknown',
        description: get('description', '{{description}}'),
        personality: get('personality', '{{personality}}'),
        scenario: get('scenario', '{{scenario}}'),
        mes_example: get('mes_example', '{{mesExamples}}'),
        character_note: getCharNote(),
        creator_notes: get('creator_notes'),
        system_prompt: get('system_prompt'),
        post_history_instructions: get('post_history_instructions'),
    };
}

export function getUserPersona() {
    const ctx = SillyTavern.getContext();
    
    try {
        let expanded = '';
        if (typeof ctx.substituteParams === 'function') {
            expanded = ctx.substituteParams('{{persona}}');
        } else if (typeof window.substituteParams === 'function') {
            expanded = window.substituteParams('{{persona}}');
        }
        if (expanded && expanded !== '{{persona}}') return expanded;
    } catch (_) {}

    try {
        const pu = window.power_user || ctx.powerUserSettings || {};
        let personaId = window.user_avatar || ctx.user_avatar || ctx.userAvatar || ctx.personaId || ctx.activePersonaId || ctx.active_persona_id;
        if (!personaId && typeof document !== 'undefined') {
            const selected = document.querySelector('#user_avatar_block .avatar-container.selected, #persona_container .avatar-container.selected, .persona_selected');
            if (selected) personaId = selected.getAttribute('data-avatar-id') || selected.dataset?.avatarId;
        }
        if (typeof personaId === 'object' && personaId !== null) {
            personaId = personaId.avatarId || personaId.avatar_id || personaId.user_avatar || personaId.userAvatar || personaId.id;
        }

        if (personaId && pu.persona_descriptions) {
            const pd = pu.persona_descriptions[personaId];
            if (typeof pd === 'string') return pd;
            if (typeof pd === 'object' && pd.description) return pd.description;
        }
        if (typeof pu.persona_description === 'string' && pu.persona_description) return pu.persona_description;
    } catch (_) {}

    return ctx.persona || ctx.userPersona || ctx.user_persona || '';
}

export function getAuthorsNote() {
    const ctx = SillyTavern.getContext();
    return ctx.chatMetadata?.note_prompt || ctx.authorsNote || ctx.authors_note || '';
}

/**
 * Snapshot of the user's active generation preset, for the AI context.
 * Chat Completion: preset name + enabled Prompt Manager prompts (markers skipped).
 * Text Completion: preset name + instruct/context template names + system prompt.
 * Returns null when nothing useful could be read.
 */
export function getActivePresetInfo() {
    const ctx = SillyTavern.getContext();
    const api = ctx.mainApi || '';
    const presetName = (apiId) => {
        try { return ctx.getPresetManager?.(apiId)?.getSelectedPresetName?.() || ''; } catch (_) { return ''; }
    };
    const expand = (text) => {
        if (typeof text !== 'string' || !text) return '';
        try { return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text; } catch (_) { return text; }
    };

    if (api === 'openai') {
        const prompts = [];
        try {
            const pm = ctx.promptManager;
            const list = pm?.getPromptsForCharacter?.(pm.activeCharacter, true) || [];
            for (const p of list) {
                if (!p || p.marker) continue;
                const content = expand(p.content || '').trim();
                if (!content) continue;
                prompts.push({ name: p.name || p.identifier || 'Prompt', role: p.role || 'system', content });
            }
        } catch (_) {}
        const name = presetName('openai') || ctx.chatCompletionSettings?.preset_settings_openai || '';
        if (!name && !prompts.length) return null;
        return { api, name, prompts };
    }

    const pu = ctx.powerUserSettings || {};
    const name = presetName(api);
    const info = { api, name, prompts: [] };
    if (pu.instruct?.enabled && pu.instruct.preset) info.instructTemplate = pu.instruct.preset;
    if (pu.context?.preset) info.contextTemplate = pu.context.preset;
    if (pu.sysprompt?.enabled !== false && pu.sysprompt?.content) {
        const content = expand(pu.sysprompt.content).trim();
        if (content) info.prompts.push({ name: pu.sysprompt.name || 'System Prompt', role: 'system', content });
    }
    if (!name && !info.instructTemplate && !info.contextTemplate && !info.prompts.length) return null;
    return info;
}

export function buildActivePresetBlock() {
    const info = getActivePresetInfo();
    if (!info) return '';
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const lines = [
        'This is the generation preset the user is currently roleplaying with. Its prompts are sent alongside the character card, so keep card edits consistent with it and avoid duplicating or contradicting its instructions.',
        `API: ${info.api || 'unknown'}`,
    ];
    if (info.name) lines.push(`Preset: ${info.name}`);
    if (info.instructTemplate) lines.push(`Instruct template: ${info.instructTemplate}`);
    if (info.contextTemplate) lines.push(`Context template: ${info.contextTemplate}`);
    for (const p of info.prompts) {
        lines.push(`\n<preset_prompt name="${esc(p.name)}" role="${esc(p.role)}">\n${p.content}\n</preset_prompt>`);
    }
    return `\n\n<active_preset>\n${lines.join('\n')}\n</active_preset>`;
}
