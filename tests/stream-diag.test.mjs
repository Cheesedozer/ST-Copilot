import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseResponseText, diagnoseResponse, explainEmptyReply, isMaxTokensReason } from '../src/utils/util-stream-diag.js';

const sse = (...objs) => objs.map(o => `data: ${JSON.stringify(o)}\n\n`).join('');

test('Google prompt block in a stream', () => {
    const d = diagnoseResponseText(sse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 27000 } }));
    assert.equal(d.blockReason, 'PROHIBITED_CONTENT');
    assert.match(explainEmptyReply(d), /blocked the prompt \(PROHIBITED_CONTENT\)/);
});

test('Google candidate stopped by safety with no text', () => {
    const d = diagnoseResponseText(sse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }));
    assert.equal(d.finishReason, 'SAFETY');
    assert.match(explainEmptyReply(d), /content filter blocked it/);
});

test('error object inside an OpenAI-style stream (swallowed by SillyTavern)', () => {
    const d = diagnoseResponseText(sse({ error: { message: 'Upstream rate limit', code: 429 } }) + 'data: [DONE]\n\n');
    assert.equal(d.error, 'Upstream rate limit');
    assert.match(explainEmptyReply(d), /returned an error: Upstream rate limit/);
});

test('plain JSON bodies: error and normal completion', () => {
    assert.equal(diagnoseResponseText('{"error":{"message":"Gemini API returned no candidate"}}').error, 'Gemini API returned no candidate');
    const ok = diagnoseResponseText('{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}');
    assert.equal(ok.finishReason, 'stop');
    assert.equal(ok.error, undefined);
});

test('finish reasons across providers', () => {
    assert.equal(diagnoseResponseText(sse({ choices: [{ delta: {}, finish_reason: 'length' }] })).finishReason, 'length');
    assert.equal(diagnoseResponseText(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } })).finishReason, 'max_tokens');
    assert.equal(diagnoseResponseText(sse({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).finishReason, 'MAX_TOKENS');
    for (const r of ['length', 'max_tokens', 'MAX_TOKENS']) assert.ok(isMaxTokensReason(r));
    assert.ok(!isMaxTokensReason('stop'));
    assert.equal(explainEmptyReply({ finishReason: 'MAX_TOKENS' }), null, 'left to the Max Tokens warning');
    assert.equal(explainEmptyReply({}), null);
});

test('reads a real Response object and never throws', async () => {
    const d = await diagnoseResponse(new Response(sse({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }), { status: 200 }));
    assert.equal(d.httpStatus, 200);
    assert.equal(d.finishReason, 'PROHIBITED_CONTENT');
    const broken = await diagnoseResponse({ status: 0, text: () => Promise.reject(new Error('aborted')) });
    assert.deepEqual(broken, { httpStatus: 0 });
});
