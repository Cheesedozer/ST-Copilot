import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = globalThis.document || { getElementById: () => null };
const { _getLiveConnection, _liveChatCompletionFields } = await import('../src/api.js');

test('reads the live chat-completion model after switching from Claude to Gemini', () => {
    const oai = { chat_completion_source: 'claude', claude_model: 'claude-opus-5-5', google_model: 'gemini-argon-4' };
    const ctx = { mainApi: 'openai', chatCompletionSettings: oai };
    assert.equal(_getLiveConnection(ctx).model, 'claude-opus-5-5');

    oai.chat_completion_source = 'makersuite';
    const live = _getLiveConnection(ctx);
    assert.equal(live.source, 'makersuite');
    assert.equal(live.model, 'gemini-argon-4');
    assert.deepEqual(_liveChatCompletionFields(live), { chat_completion_source: 'makersuite', model: 'gemini-argon-4' });
});

test('prefers SillyTavern\'s own model resolver when available', () => {
    const ctx = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'openrouter', openrouter_model: 'stale' },
        getChatCompletionModel: () => 'resolved-model',
    };
    assert.equal(_getLiveConnection(ctx).model, 'resolved-model');
});

test('passes custom endpoint and reverse proxy from live settings', () => {
    const live = _getLiveConnection({ mainApi: 'openai', chatCompletionSettings: {
        chat_completion_source: 'custom', custom_model: 'm', custom_url: 'http://x/v1',
    } });
    assert.deepEqual(_liveChatCompletionFields(live), { chat_completion_source: 'custom', model: 'm', custom_url: 'http://x/v1' });
});

test('no chat-completion overrides for text completion APIs', () => {
    const live = _getLiveConnection({ mainApi: 'textgenerationwebui', textCompletionSettings: { type: 'koboldcpp' } });
    assert.deepEqual(_liveChatCompletionFields(live), {});
});
