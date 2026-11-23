import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CARD_GUIDE_PROMPT, CARD_REVIEW_QUICK_PROMPT, KNOWN_DEFAULT_PROMPT_HASHES } from '../src/constants.js';
import { promptHash } from '../src/utils/util-text.js';
import { buildCardGuideInstructions, buildCharEditAIInstructions, parseCharChangesFromText, getCharFieldValue } from '../src/features/feature-character-engine.js';

const S = await import('../src/session.js');

function freshContext(saved) {
    globalThis.__stContext = {
        characters: [], name1: 'User',
        extensionSettings: { st_copilot: saved },
        saveSettingsDebounced() {},
    };
}

beforeEach(() => freshContext({}));

test('guide is sent only when both character editing and the guide are on', () => {
    const on = buildCardGuideInstructions({ charEditAIEnabled: true, cardGuideEnabled: true });
    assert.match(on, /^<card_craft_guide>\n/);
    assert.ok(on.includes('<engine>'));
    assert.equal(buildCardGuideInstructions({ charEditAIEnabled: true, cardGuideEnabled: false }), '');
    assert.equal(buildCardGuideInstructions({ charEditAIEnabled: false, cardGuideEnabled: true }), '');
});

test('an edited guide replaces the default; an empty one falls back to it', () => {
    const custom = buildCardGuideInstructions({ charEditAIEnabled: true, cardGuideEnabled: true, cardGuidePrompt: 'My rules.' });
    assert.equal(custom, '<card_craft_guide>\nMy rules.\n</card_craft_guide>');
    const blank = buildCardGuideInstructions({ charEditAIEnabled: true, cardGuideEnabled: true, cardGuidePrompt: '   ' });
    assert.ok(blank.includes(DEFAULT_CARD_GUIDE_PROMPT.trim()));
});

test('the shipped guide is a known default, so saved unedited copies keep updating', () => {
    assert.ok(KNOWN_DEFAULT_PROMPT_HASHES.includes(promptHash(DEFAULT_CARD_GUIDE_PROMPT)));
});

test('new installs get the guide on and the Card Review quick prompt', () => {
    const s = S.getSettings();
    assert.equal(s.cardGuideEnabled, true);
    assert.equal(s.quickPrompts.filter(q => q.id === CARD_REVIEW_QUICK_PROMPT.id).length, 1);
    assert.equal(s.charEditFields.creator_notes, false);
});

test('existing installs get Card Review added once, and a deleted one stays deleted', () => {
    const saved = { quickPrompts: [{ id: 'mine', label: 'Mine', icon: '⚡', text: 'x' }], charEditFields: { description: true } };
    freshContext(saved);
    let s = S.getSettings();
    assert.deepEqual(s.quickPrompts.map(q => q.id), ['mine', CARD_REVIEW_QUICK_PROMPT.id]);
    assert.equal(s.charEditFields.creator_notes, false);
    assert.equal(s.charEditFields.description, true);

    s.quickPrompts = s.quickPrompts.filter(q => q.id !== CARD_REVIEW_QUICK_PROMPT.id);
    s = S.getSettings();
    assert.deepEqual(s.quickPrompts.map(q => q.id), ['mine']);
});

test('the review prompt holds back edits until the Human says rewrite', () => {
    assert.match(CARD_REVIEW_QUICK_PROMPT.text, /Do not output a character-changes block yet/);
    assert.match(CARD_REVIEW_QUICK_PROMPT.text, /"Works as is" is a valid verdict/);
    // Quick prompts are macro-expanded, so the persona macro would turn into a name.
    assert.ok(!CARD_REVIEW_QUICK_PROMPT.text.includes('{{user}}'));
});

test('creator_notes is listed as editable only when enabled', () => {
    const off = buildCharEditAIInstructions({ charEditAIEnabled: true, charEditFields: { description: true, creator_notes: false } });
    assert.ok(!/Editable fields: [^\n]*creator_notes/.test(off));
    const on = buildCharEditAIInstructions({ charEditAIEnabled: true, charEditFields: { description: true, creator_notes: true } });
    assert.match(on, /Editable fields: [^\n]*creator_notes/);
});

test('creator notes field aliases resolve, and V1 creatorcomment is read', () => {
    const text = 'ok\n```character-changes\n<overwrite char="A" field="Creator Note">Decisions</overwrite>\n```';
    assert.equal(parseCharChangesFromText(text)[0].field, 'creator_notes');
    assert.equal(getCharFieldValue({ creatorcomment: 'old notes', data: {} }, 'creator_notes'), 'old notes');
    assert.equal(getCharFieldValue({ data: { creator_notes: 'v2 notes' } }, 'creator_notes'), 'v2 notes');
});
