import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newRoomToken, parseRoomInput, roomLabel, roomPath, roomTokenFromPath, roomUrl } from './room-id.ts';

test('room tokens are 22 url-safe characters and unique', () => {
  const tokens = new Set(Array.from({ length: 1000 }, newRoomToken));
  assert.equal(tokens.size, 1000);
  for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{22}$/);
});

test('room path round trip', () => {
  const t = newRoomToken();
  assert.equal(roomTokenFromPath(roomPath(t)), t);
  assert.equal(roomTokenFromPath(`${roomPath(t)}/`), t);
  assert.equal(roomLabel(t), t.slice(0, 4));
});

test('short or guessable paths are not rooms', () => {
  for (const p of ['/', '/r/123456', '/r/', '/r/abc', `/r/${'a'.repeat(21)}`, `/r/${'a'.repeat(23)}`, `/x/${'a'.repeat(22)}`]) {
    assert.equal(roomTokenFromPath(p), null, p);
  }
});

test('invite url opens LINE links in the external browser and still routes to the room', () => {
  (globalThis as { location?: unknown }).location ??= { origin: 'https://talk.example.com' };
  const t = newRoomToken();
  const url = new URL(roomUrl(t));
  assert.equal(url.searchParams.get('openExternalBrowser'), '1');
  assert.equal(roomTokenFromPath(url.pathname), t);
});

test('pasted invite links, messages and bare codes resolve to the room', () => {
  const t = 'lWnfsojK-Z7zrZY5lYVong';
  assert.equal(parseRoomInput(t), t);
  assert.equal(parseRoomInput(`  ${t}\n`), t);
  assert.equal(parseRoomInput(`https://walkie-talkie.example.workers.dev/r/${t}`), t);
  assert.equal(parseRoomInput(`https://walkie-talkie.example.workers.dev/r/${t}?openExternalBrowser=1`), t);
  assert.equal(parseRoomInput(`一起加入對講機房間（只有收到這個連結的人才進得來） https://x.dev/r/${t}?openExternalBrowser=1`), t);
});

test('room labels, numbers and broken links are rejected', () => {
  for (const input of ['', 'lWnf', '123456', 'https://x.dev/', 'https://x.dev/r/lWnfsojK', `https://x.dev/r/${'a'.repeat(23)}`, 'a'.repeat(23)]) {
    assert.equal(parseRoomInput(input), null, input);
  }
});
