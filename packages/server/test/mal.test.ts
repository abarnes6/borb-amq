import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MAL_USERS, formatNameList, possessiveLists } from '@borb/shared';
import { MalListError, normalizeMalUser, normalizeMalUsers } from '../src/mal.ts';

test('normalizeMalUser accepts real usernames', () => {
  assert.equal(normalizeMalUser('Xinil'), 'Xinil');
  assert.equal(normalizeMalUser('  spaced_out  '), 'spaced_out');
  assert.equal(normalizeMalUser('a-b_c123'), 'a-b_c123');
});

test('normalizeMalUser rejects anything that could escape the URL path', () => {
  for (const bad of [
    '../../etc/passwd',
    'user/../other',
    'user?status=7',
    'user#frag',
    'user name',
    'https://myanimelist.net/animelist/x',
    '',
    'a',
    'x'.repeat(33),
  ]) {
    assert.throws(() => normalizeMalUser(bad), MalListError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('normalizeMalUsers keeps order and drops blanks', () => {
  assert.deepEqual(normalizeMalUsers(['Xinil', ' ', 'Kineta', '']), ['Xinil', 'Kineta']);
});

test('normalizeMalUsers collapses the same person entered twice', () => {
  assert.deepEqual(normalizeMalUsers(['Xinil', 'xinil', 'XINIL']), ['Xinil']);
  assert.deepEqual(normalizeMalUsers(['a-b', 'Kineta', 'A-B']), ['a-b', 'Kineta']);
});

test('normalizeMalUsers rejects an empty set', () => {
  assert.throws(() => normalizeMalUsers([]), MalListError);
  assert.throws(() => normalizeMalUsers(['', '   ']), MalListError);
});

test('normalizeMalUsers rejects one bad name among good ones', () => {
  assert.throws(() => normalizeMalUsers(['Xinil', '../../etc/passwd']), MalListError);
});

test('normalizeMalUsers caps how many lists one filter can pull', () => {
  const names = Array.from({ length: MAX_MAL_USERS }, (_, i) => `user_${i}`);
  assert.equal(normalizeMalUsers(names).length, MAX_MAL_USERS);
  assert.throws(() => normalizeMalUsers([...names, 'one_too_many']), MalListError);
  assert.equal(normalizeMalUsers([...names, 'USER_0']).length, MAX_MAL_USERS);
});

test('name lists read as a sentence', () => {
  assert.equal(formatNameList([]), '');
  assert.equal(formatNameList(['alice']), 'alice');
  assert.equal(formatNameList(['alice', 'bob']), 'alice and bob');
  assert.equal(formatNameList(['alice', 'bob', 'carol']), 'alice, bob and carol');

  assert.equal(possessiveLists(['alice']), "alice's list");
  assert.equal(possessiveLists(['alice', 'bob']), "alice and bob's lists");
});
