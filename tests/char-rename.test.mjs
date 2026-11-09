import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = globalThis.document || { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
const { applyCharChanges } = await import('../src/features/feature-character-ui.js');

// Fake SillyTavern server: card files keyed by avatar. Renaming moves the file, like ST does.
function setup(name) {
    const files = new Map([[`${name}.png`, { name }]]);
    const calls = [];
    const characters = [{ name, avatar: `${name}.png`, data: { name, description: 'old' } }];
    globalThis.__stContext = { characters, characterId: 0, getRequestHeaders: () => ({}), name1: 'User' };
    globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, body });
        const avatar = body.avatar_url || body.avatar;
        if (!files.has(avatar)) return { ok: false, status: 500, text: async () => 'ENOENT' };
        if (url === '/api/characters/rename') {
            const next = `${body.new_name}.png`;
            files.set(next, { ...files.get(avatar), name: body.new_name });
            files.delete(avatar);
            return { ok: true, status: 200, json: async () => ({ avatar: next }) };
        }
        return { ok: true, status: 200, text: async () => '' };
    };
    return { files, calls, char: characters[0] };
}

test('a rename in the same batch no longer breaks the other edits', async () => {
    const { files, char } = setup('Rose');
    const failed = await applyCharChanges([
        { field: 'name', action: 'overwrite', value: 'Rosalind' },
        { field: 'description', action: 'overwrite', value: 'new desc' },
        { field: 'personality', action: 'overwrite', value: 'kind' },
    ], char);
    assert.deepEqual(failed, []);
    assert.ok(files.has('Rosalind.png'));
    assert.equal(char.avatar, 'Rosalind.png');
    assert.equal(char.name, 'Rosalind');
});

test('edits applied after a rename target the renamed card file', async () => {
    const { calls, char } = setup('Rose');
    await applyCharChanges([{ field: 'name', action: 'overwrite', value: 'Rosalind' }], char);
    const failed = await applyCharChanges([{ field: 'scenario', action: 'overwrite', value: 's' }], char);
    assert.deepEqual(failed, []);
    assert.equal(calls.at(-1).body.avatar_url, 'Rosalind.png');
});

test('failed edits are returned so they can stay pending', async () => {
    const { char, files } = setup('Rose');
    files.clear();
    const change = { field: 'description', action: 'overwrite', value: 'x' };
    assert.deepEqual(await applyCharChanges([change], char), [change]);
});
