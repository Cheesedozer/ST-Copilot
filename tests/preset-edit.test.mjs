import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    detectChatCompletionPreset, serializePreset, editedFileName, buildPresetContextBlock, buildPresetEditAIInstructions,
    parsePresetChangesFromText, stripPresetChangesBlock, applyPresetChanges, validatePresetData, readPresetItems,
    protectVerbatim, transformOutsideVerbatim, stripVerbatimMarkers, PRESET_INLINE_CHAR_BUDGET,
} from '../src/features/feature-preset-engine.js';

const basePreset = () => ({
    temperature: 0.75,
    stream_openai: true,
    impersonation_prompt: '[Write as {{user}}]',
    prompts: [
        { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'Write {{char}}.\n{{#if .x}}A{{/if}}\n{{#if .y}}B{{/if}}', marker: false, enabled: true },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        { identifier: 'abc-1', name: 'Style', system_prompt: false, role: 'system', content: 'Be vivid. Use {{outlet::Style}}.', marker: false, enabled: false,
          injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false },
        { identifier: 'abc-2', name: 'Header', system_prompt: false, marker: true, content: 'old notes' },
    ],
    prompt_order: [
        { character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'abc-2', enabled: true }, { identifier: 'abc-1', enabled: true }, { identifier: 'chatHistory', enabled: true }] },
    ],
    extensions: { regex_scripts: [{ id: 'r1', scriptName: 'Hide tags', findRegex: '/<t>/g', replaceString: '', placement: [2], disabled: false }], other_ext: { a: 1 } },
});

const sessionPreset = (data = basePreset()) => ({ fileName: 'My Preset.json', data, format: { indent: 4 }, version: 1 });

test('detects Chat Completion presets and round-trips formatting exactly', () => {
    for (const [indent, eol, trailing] of [[4, '\n', false], ['  ', '\n', true], [4, '\r\n', true], [0, '\n', false]]) {
        const text = serializePreset(basePreset(), { indent, eol, trailingNewline: trailing });
        const d = detectChatCompletionPreset(text);
        assert.ok(d, `detected with indent=${JSON.stringify(indent)}`);
        assert.equal(serializePreset(d.data, d.format), text);
    }
    assert.equal(detectChatCompletionPreset('{"temperature": 1}'), null);
    assert.equal(detectChatCompletionPreset('not json'), null);
    assert.equal(detectChatCompletionPreset('{"prompts": []}'), null);
});

test('edited file name', () => {
    assert.equal(editedFileName('DEUS_EX_MACHINA_V3.json'), 'DEUS_EX_MACHINA_V3 (edited).json');
    assert.equal(editedFileName('X (edited).json'), 'X (edited).json');
    assert.equal(editedFileName('noext'), 'noext (edited).json');
});

test('outline uses prompt_order for on/off and keeps macros verbatim', () => {
    const block = stripVerbatimMarkers(buildPresetContextBlock(sessionPreset()));
    // prompts[].enabled says false, but the global prompt_order (100001) says true.
    assert.match(block, /<prompt id="abc-1" name="Style" role="system" enabled="true" position="relative">/);
    assert.match(block, /\{\{outlet::Style\}\}/);
    assert.match(block, /\{\{#if \.x\}\}A\{\{\/if\}\}/);
    assert.match(block, /<prompt id="chatHistory" name="Chat History" marker="true" enabled="true"\/>/);
    assert.match(block, /id="abc-2"[^>]*unsent_text_chars="9"/);
    assert.match(block, /temperature: 0\.75/);
    assert.match(block, /<regex name="Hide tags" placement="ai_output"\/>/);
    assert.match(block, /Other data .*extensions\.other_ext/);
    assert.ok(buildPresetContextBlock(sessionPreset()).startsWith(''), 'outline is protected from macro expansion');
});

test('large presets get previews instead of full text', () => {
    const data = basePreset();
    data.prompts[0].content = 'word '.repeat(PRESET_INLINE_CHAR_BUDGET / 4);
    const block = buildPresetContextBlock(sessionPreset(data));
    assert.match(block, /chars="\d+" preview="true"/);
    assert.match(block, /Call read_preset/);
    assert.ok(block.length < PRESET_INLINE_CHAR_BUDGET / 2);
});

test('instructions only exist with a preset', () => {
    assert.equal(buildPresetEditAIInstructions(null), '');
    assert.match(buildPresetEditAIInstructions(sessionPreset()), /preset-changes/);
});

test('parses a preset-changes block', () => {
    const text = `Here you go.
\`\`\`preset-changes
<edit_prompt id="main">
<<<<<<< ANCHOR
Write {{char}}.
=======
Write {{char}} vividly.
>>>>>>> REPLACE
</edit_prompt>
<edit_prompt id="abc-1" enabled="false"/>
<add_prompt name="New &quot;one&quot;" role="user" after="main">
Line 1
  Line 2 {{user}}
</add_prompt>
<set_setting key="impersonation_prompt">
New text
with lines
</set_setting>
<edit_regex name="Hide tags"><find>/<b>/g</find><replace>x</replace></edit_regex>
\`\`\``;
    const ch = parsePresetChangesFromText(text);
    assert.equal(ch.length, 5);
    assert.deepEqual(ch[0].patches, [{ search: 'Write {{char}}.', replace: 'Write {{char}} vividly.' }]);
    assert.deepEqual(ch[1], { op: 'edit_prompt', id: 'abc-1', enabled: 'false' });
    assert.equal(ch[2].name, 'New "one"');
    assert.equal(ch[2].content, 'Line 1\n  Line 2 {{user}}');
    assert.equal(ch[3].content, 'New text\nwith lines');
    assert.equal(ch[4].find, '/<b>/g');
    assert.equal(stripPresetChangesBlock(text), 'Here you go.');
});

test('a truncated block keeps complete operations only', () => {
    const ch = parsePresetChangesFromText('```preset-changes\n<edit_prompt id="abc-1" enabled="false"/>\n<add_prompt name="X">\npartial');
    assert.equal(ch.length, 1);
    assert.equal(parsePresetChangesFromText('no block here'), null);
});

test('applies edits without touching the original or unrelated data', () => {
    const data = basePreset();
    const before = JSON.stringify(data);
    const changes = parsePresetChangesFromText(`\`\`\`preset-changes
<edit_prompt id="main">
<<<<<<< ANCHOR
Write {{char}}.
=======
Write {{char}} vividly.
>>>>>>> REPLACE
</edit_prompt>
<edit_prompt id="abc-1" enabled="false" name="Style 2" position="in_chat" depth="2"/>
<add_prompt name="Extra" after="main">
Extra text
</add_prompt>
<move_prompt id="chatHistory" before="abc-2"/>
<set_setting key="temperature" value="1.1"/>
<set_setting key="stream_openai" value="false"/>
<edit_regex name="Hide tags" disabled="true"><replace>gone</replace></edit_regex>
<add_regex name="New" placement="user_input,ai_output"><find>/a/g</find><replace>b</replace></add_regex>
\`\`\``);
    const { data: out, results } = applyPresetChanges(data, changes);
    assert.equal(JSON.stringify(data), before, 'input is not mutated');
    assert.ok(results.every(r => r.ok), JSON.stringify(results.filter(r => !r.ok)));
    assert.equal(out.prompts[0].content, 'Write {{char}} vividly.\n{{#if .x}}A{{/if}}\n{{#if .y}}B{{/if}}');
    const style = out.prompts.find(p => p.identifier === 'abc-1');
    assert.equal(style.name, 'Style 2');
    assert.equal(style.injection_position, 1);
    assert.equal(style.injection_depth, 2);
    assert.equal(style.enabled, false, 'prompts[].enabled left as it was');
    assert.equal(out.prompt_order[1].order.find(e => e.identifier === 'abc-1').enabled, false);
    const ids = out.prompt_order[1].order.map(e => e.identifier);
    const extra = out.prompts.find(p => p.name === 'Extra');
    assert.deepEqual(ids, ['main', extra.identifier, 'chatHistory', 'abc-2', 'abc-1']);
    assert.equal(out.prompt_order[1].order[1].enabled, true);
    assert.equal(out.temperature, 1.1);
    assert.equal(out.stream_openai, false);
    assert.equal(out.extensions.regex_scripts[0].disabled, true);
    assert.equal(out.extensions.regex_scripts[0].replaceString, 'gone');
    assert.equal(out.extensions.regex_scripts[0].findRegex, '/<t>/g');
    assert.deepEqual(out.extensions.regex_scripts[1].placement, [1, 2]);
    assert.deepEqual(out.extensions.other_ext, { a: 1 });
    assert.deepEqual(validatePresetData(out), []);
});

test('failed changes are skipped and reported; the rest still apply', () => {
    const data = basePreset();
    const { data: out, results } = applyPresetChanges(data, [
        { op: 'edit_prompt', id: 'main', patches: [{ search: '{{/if}}', replace: '' }] },
        { op: 'edit_prompt', id: 'nope', enabled: 'true' },
        { op: 'delete_prompt', id: 'chatHistory' },
        { op: 'edit_prompt', id: 'chatHistory', content: 'text' },
        { op: 'set_setting', key: 'temperature', value: 'hot' },
        { op: 'set_setting', key: 'not_a_key', value: '1' },
        { op: 'delete_prompt', id: 'abc-1' },
    ]);
    assert.match(results[0].error, /appears 2 times/);
    assert.match(results[1].error, /No prompt/);
    assert.match(results[2].error, /core prompt/);
    assert.match(results[3].error, /marker/);
    assert.match(results[4].error, /must be a number/);
    assert.match(results[5].error, /Unknown setting/);
    assert.ok(results[6].ok);
    assert.equal(out.prompts[0].content, data.prompts[0].content);
    assert.ok(!out.prompts.some(p => p.identifier === 'abc-1'));
    assert.ok(!out.prompt_order[1].order.some(e => e.identifier === 'abc-1'));
    assert.equal(out.temperature, 0.75);
});

test('anchors tolerate whitespace differences and support first || last ranges', () => {
    const data = basePreset();
    data.prompts[0].content = 'Alpha beta\n  gamma delta. Middle part here. End of it.';
    const { data: out, results } = applyPresetChanges(data, [
        { op: 'edit_prompt', id: 'main', patches: [{ search: 'beta gamma', replace: 'BG' }] },
        { op: 'edit_prompt', id: 'main', patches: [{ search: 'Middle || here.', replace: 'M.' }] },
    ]);
    assert.ok(results.every(r => r.ok && !r.warning), JSON.stringify(results));
    assert.equal(out.prompts[0].content, 'Alpha BG delta. M. End of it.');
});

test('read_preset returns exact text', () => {
    const p = sessionPreset();
    const out = readPresetItems(p, { prompts: ['Style', 'missing'], regex: ['Hide tags'] });
    assert.match(out, /<prompt id="abc-1" name="Style" chars="\d+">\nBe vivid\. Use \{\{outlet::Style\}\}\.\n<\/prompt>/);
    assert.match(out, /No prompt with id or name "missing"/);
    assert.match(out, /<find>\/<t>\/g<\/find>/);
    assert.match(readPresetItems(null, {}), /No preset/);
});

test('macro expansion skips verbatim regions', async () => {
    const text = `before {{outlet::A}} ${protectVerbatim('keep {{outlet::A}}')} after`;
    const out = await transformOutsideVerbatim(text, t => t.replaceAll('{{outlet::A}}', 'X'));
    assert.equal(out, 'before X keep {{outlet::A}} after');
});

test('assembled prompt carries the outline, labels files and never expands outlets in attachments', async () => {
    globalThis.__stContext = { characters: [], name1: 'User', chat: [], chatMetadata: {}, extensionSettings: {} };
    try {
        const { assembleMessages } = await import('../src/api.js');
        const session = { id: 's', messages: [
            { id: 'm1', role: 'user', content: 'Edit it', attachments: [
                { name: 'notes.txt', isTextFile: true, sendAsText: true, textContent: 'Has {{outlet::Lore}} inside' },
            ] },
        ], preset: sessionPreset() };
        const msgs = await assembleMessages(session, { contextDepth: 0, localHistoryLimit: 50 }, null);
        const sys = msgs[0].content;
        assert.match(sys, /<attached_preset file="My Preset.json"/);
        assert.match(sys, /\{\{outlet::Style\}\}/, 'outlet inside the preset outline is kept');
        assert.match(sys, /<preset_editing>/);
        assert.match(sys, /read_preset/);
        assert.ok(!/[]/.test(msgs.map(m => m.content).join('')), 'sentinels are removed');
        const user = msgs.at(-1).content;
        assert.equal(user, '[Attached file "notes.txt"]\nHas {{outlet::Lore}} inside\n[End of attached file "notes.txt"]\n\nEdit it');

        const noPreset = await assembleMessages({ ...session, preset: undefined }, { contextDepth: 0 }, null);
        assert.doesNotMatch(noPreset[0].content, /preset_editing|attached_preset|read_preset/);
    } finally { delete globalThis.__stContext; }
});

test('an attached preset becomes a placeholder plus payload; other JSON stays a labelled file', async () => {
    const { _processAttachmentsBeforeSend } = await import('../src/features/feature-attachments.js');
    globalThis.__stContext = { characters: [], name1: 'User', extensionSettings: {} };
    try {
        const presetText = serializePreset(basePreset(), { indent: 4 });
        const [p, other] = await _processAttachmentsBeforeSend([
            { name: 'My Preset.json', type: 'application/json', isImage: false, textContent: presetText },
            { name: 'data.json', type: 'application/json', isImage: false, textContent: '{"a": "{{outlet::X}}"}' },
        ]);
        assert.equal(p.isPreset, true);
        assert.match(p.textContent, /Attached SillyTavern Chat Completion preset "My Preset.json"/);
        assert.ok(!p.textContent.includes('prompt_order'), 'raw file is not sent');
        assert.equal(p.presetPayload.fileName, 'My Preset.json');
        assert.equal(serializePreset(p.presetPayload.data, p.presetPayload.format), presetText);
        assert.equal(other.isTextFile, true);
        assert.equal(other.textContent, '{"a": "{{outlet::X}}"}');
    } finally { delete globalThis.__stContext; }
});

test('read_preset all returns enabled prompts with text in order', async () => {
    const { PRESET_READ_ALL_CHAR_CAP } = await import('../src/features/feature-preset-engine.js');
    const data = basePreset();
    data.prompt_order[1].order.find(e => e.identifier === 'abc-1').enabled = false;
    let out = readPresetItems(sessionPreset(data), { all: true });
    assert.match(out, /^1 enabled prompts with text/);
    assert.match(out, /<prompt id="main"/);
    assert.doesNotMatch(out, /abc-1|abc-2|chatHistory/, 'disabled and marker prompts are left out');
    out = readPresetItems(sessionPreset(data), { all: true, include_disabled: true });
    assert.match(out, /<prompt id="main"[\s\S]*<prompt id="abc-1"[^>]*enabled="false"/);

    data.prompt_order[1].order.find(e => e.identifier === 'abc-1').enabled = true;
    data.prompts[0].content = 'x'.repeat(PRESET_READ_ALL_CHAR_CAP);
    out = readPresetItems(sessionPreset(data), { all: true });
    assert.match(out, /1 more did not fit in one result; read them by id: abc-1/);
});

test('render throttle coalesces updates and flush runs the latest one', async () => {
    const { createRenderThrottle } = await import('../src/utils/util-dom.js');
    const t = createRenderThrottle(30);
    const seen = [];
    for (let i = 0; i < 50; i++) t.schedule(() => seen.push(i));
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(seen, [49]);
    t.schedule(() => seen.push('a'));
    t.schedule(() => seen.push('b'));
    t.flush();
    assert.deepEqual(seen, [49, 'b']);
    t.flush();
    assert.deepEqual(seen, [49, 'b'], 'nothing pending, nothing runs');
});
