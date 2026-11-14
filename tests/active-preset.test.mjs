import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getActivePresetInfo, buildActivePresetBlock } from '../src/utils/util-st.js';

const withCtx = (ctx, fn) => { globalThis.__stContext = ctx; try { return fn(); } finally { delete globalThis.__stContext; } };

test('chat completion: preset name and enabled non-marker prompts', () => {
    const pm = {
        activeCharacter: { id: 100000 },
        getPromptsForCharacter: (c, onlyEnabled) => {
            assert.equal(onlyEnabled, true);
            return [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write as {{char}}.' },
                { identifier: 'charDescription', name: 'Char Description', marker: true },
                { identifier: 'empty', name: 'Empty', content: '   ' },
                { identifier: 'nsfw', name: 'Style <rules>', role: 'user', content: 'Be vivid.' },
            ];
        },
    };
    withCtx({
        mainApi: 'openai',
        promptManager: pm,
        getPresetManager: () => ({ getSelectedPresetName: () => 'Bunny Preset' }),
        substituteParams: s => s.replace('{{char}}', 'Rose'),
    }, () => {
        const info = getActivePresetInfo();
        assert.equal(info.name, 'Bunny Preset');
        assert.deepEqual(info.prompts.map(p => p.name), ['Main Prompt', 'Style <rules>']);
        assert.equal(info.prompts[0].content, 'Write as Rose.');
        const block = buildActivePresetBlock();
        assert.match(block, /<active_preset>/);
        assert.match(block, /Preset: Bunny Preset/);
        assert.match(block, /name="Style &lt;rules>" role="user"/);
    });
});

test('text completion: preset, templates and system prompt', () => {
    withCtx({
        mainApi: 'textgenerationwebui',
        getPresetManager: () => ({ getSelectedPresetName: () => 'Universal-Creative' }),
        powerUserSettings: {
            instruct: { enabled: true, preset: 'ChatML' },
            context: { preset: 'Default' },
            sysprompt: { enabled: true, name: 'Roleplay', content: 'You are a narrator.' },
        },
    }, () => {
        const info = getActivePresetInfo();
        assert.equal(info.name, 'Universal-Creative');
        assert.equal(info.instructTemplate, 'ChatML');
        assert.equal(info.contextTemplate, 'Default');
        assert.equal(info.prompts[0].content, 'You are a narrator.');
    });
});

test('nothing readable yields no block', () => {
    withCtx({ mainApi: 'openai' }, () => {
        assert.equal(getActivePresetInfo(), null);
        assert.equal(buildActivePresetBlock(), '');
    });
});
