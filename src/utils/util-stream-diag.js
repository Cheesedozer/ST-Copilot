// Reads why a provider stopped (finish reason, safety block, in-stream error) from the raw
// response of a generation request.
//
// SillyTavern's request services drop this information when streaming: errors inside the
// stream are swallowed and the finish reason is not passed on. A blocked or failed reply then
// looks like a successful empty one. Copilot reads a clone of the response alongside
// SillyTavern to recover it.

const MAX_TOKENS_REASONS = ['length', 'max_tokens', 'max_output_tokens', 'stop_limit', 'model_length'];
const BLOCK_REASONS = ['safety', 'prohibited_content', 'blocklist', 'spii', 'recitation', 'image_safety', 'content_filter', 'refusal', 'language', 'malformed_function_call'];

function errorText(err) {
    if (!err) return null;
    if (typeof err === 'string') return err;
    if (err === true) return 'Unknown provider error';
    return err.message || err.error?.message || err.status || JSON.stringify(err).slice(0, 300);
}

// Folds one parsed JSON payload (an SSE `data:` object or a whole JSON body) into `diag`.
export function collectDiagnostics(diag, data) {
    if (!data || typeof data !== 'object') return diag;
    // Errors: OpenAI/proxy style, Claude style, Google style.
    if (data.error) diag.error = errorText(data.error);
    else if (data.type === 'error') diag.error = errorText(data.error || data);
    else if (typeof data.message === 'string' && !data.choices && !data.candidates && !data.type) diag.error = data.message;
    else if (data.detail && !data.choices) diag.error = errorText(data.detail);

    // Google: prompt blocked before generation.
    if (data.promptFeedback?.blockReason) diag.blockReason = data.promptFeedback.blockReason;
    // Google: finish reason per candidate.
    const cand = data.candidates?.[0];
    if (cand?.finishReason) diag.finishReason = cand.finishReason;
    if (cand?.finishMessage) diag.finishMessage = cand.finishMessage;
    // OpenAI-compatible.
    const choice = data.choices?.[0];
    if (choice?.finish_reason) diag.finishReason = choice.finish_reason;
    if (choice?.delta?.refusal || choice?.message?.refusal) diag.refusal = choice.delta?.refusal || choice.message?.refusal;
    // Claude.
    if (data.delta?.stop_reason) diag.finishReason = data.delta.stop_reason;
    if (data.stop_reason) diag.finishReason = data.stop_reason;
    return diag;
}

// Parses a full response text: either an SSE stream or a single JSON body.
export function diagnoseResponseText(text, diag = {}) {
    if (typeof text !== 'string' || !text) return diag;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const body = JSON.parse(trimmed);
            for (const item of Array.isArray(body) ? body : [body]) collectDiagnostics(diag, item);
            return diag;
        } catch (_) { /* fall through to SSE parsing */ }
    }
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m || !m[1] || m[1] === '[DONE]') continue;
        try { collectDiagnostics(diag, JSON.parse(m[1])); } catch (_) { /* partial or non-JSON line */ }
    }
    return diag;
}

// Reads a cloned Response in the background. Never throws.
export async function diagnoseResponse(response) {
    const diag = { httpStatus: response?.status };
    try {
        diagnoseResponseText(await response.text(), diag);
    } catch (_) { /* aborted or unreadable */ }
    return diag;
}

export function isMaxTokensReason(reason) {
    return !!reason && MAX_TOKENS_REASONS.includes(String(reason).toLowerCase());
}

export function isBlockReason(reason) {
    return !!reason && BLOCK_REASONS.includes(String(reason).toLowerCase());
}

// A short explanation for a reply that came back with no text, or null if nothing is known.
export function explainEmptyReply(diag) {
    if (!diag) return null;
    if (diag.error) return `The provider returned an error: ${diag.error}`;
    if (diag.blockReason) return `The provider blocked the prompt (${diag.blockReason}). Google models refuse some content regardless of safety settings; try a different model for this request.`;
    if (diag.refusal) return `The model refused: ${diag.refusal}`;
    if (isBlockReason(diag.finishReason)) {
        const extra = diag.finishMessage ? ` ${diag.finishMessage}` : '';
        return `The provider stopped the reply with no text (finish reason ${diag.finishReason}), which means its content filter blocked it.${extra} Try a different model for this request.`;
    }
    if (isMaxTokensReason(diag.finishReason)) return null; // handled by the Max Tokens warning
    if (diag.finishReason) return `The provider ended the reply with no text (finish reason ${diag.finishReason}).`;
    return null;
}
