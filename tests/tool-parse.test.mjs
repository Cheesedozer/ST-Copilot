import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallsLenient, mentionsToolCall } from '../src/features/feature-tools-engine.js';

const T = '```';

test('standard tool_call block', () => {
    assert.deepEqual(parseToolCallsLenient(`${T}tool_call\n{"name":"read_preset","input":{"all":true}}\n${T}`), [{ name: 'read_preset', input: { all: true } }]);
});

test('Gemini-style tool_code with a Python call', () => {
    assert.deepEqual(parseToolCallsLenient(`Reading.\n${T}tool_code\nprint(default_api.read_preset(all=True, prompts=["a", 'b(1)']))\n${T}`),
        [{ name: 'read_preset', input: { all: true, prompts: ['a', 'b(1)'] } }]);
});

test('<tool_call> tags and "arguments" (object or JSON string)', () => {
    assert.deepEqual(parseToolCallsLenient('<tool_call>{"name": "search_chat", "arguments": {"queries": ["x"]}}</tool_call>'), [{ name: 'search_chat', input: { queries: ['x'] } }]);
    assert.deepEqual(parseToolCallsLenient(`${T}json\n{"name":"read_preset","arguments":"{\\"all\\": true}"}\n${T}`), [{ name: 'read_preset', input: { all: true } }]);
    assert.deepEqual(parseToolCallsLenient(`${T}json\n{"function":{"name":"read_preset","arguments":{"all":true}}}\n${T}`), [{ name: 'read_preset', input: { all: true } }]);
});

test('ignores unknown names and ordinary code', () => {
    assert.deepEqual(parseToolCallsLenient(`${T}json\n{"name":"not_a_tool","arguments":{}}\n${T}`), []);
    assert.deepEqual(parseToolCallsLenient(`${T}python\nprint("hello")\n${T}`), []);
    assert.deepEqual(parseToolCallsLenient('Plain answer with no calls.'), []);
});

test('mentionsToolCall flags replies that tried to call a tool', () => {
    assert.ok(mentionsToolCall('I will use read_preset now.'));
    assert.ok(mentionsToolCall(`${T}tool_code\nfoo()\n${T}`));
    assert.ok(!mentionsToolCall('Here is my review.'));
});
