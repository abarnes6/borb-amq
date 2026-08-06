import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  displayTitle,
  editDistance,
  matchesAnyTitle,
  normalizeTitle,
  typoBudget,
} from '@borb/shared';
import { sanitizeSettings } from '../src/room.ts';

test('normalizeTitle folds macrons and diacritics', () => {
  assert.equal(normalizeTitle('Chūnibyō'), 'chunibyo');
  assert.equal(normalizeTitle('Chūnibyō demo Koi ga Shitai!'), 'chunibyo demo koi ga shitai');
  assert.equal(normalizeTitle('Fate/Zero'), 'fate zero');
  assert.equal(normalizeTitle('K-On!'), 'k on');
  assert.equal(normalizeTitle('  Steins;Gate  '), 'steins gate');
});

test('normalizeTitle strips apostrophes rather than splitting words', () => {
  assert.equal(normalizeTitle("JoJo's Bizarre Adventure"), 'jojos bizarre adventure');
  assert.equal(normalizeTitle('JoJo’s Bizarre Adventure'), 'jojos bizarre adventure');
});

test('normalizeTitle preserves non-Latin scripts', () => {
  assert.equal(normalizeTitle('進撃の巨人'), '進撃の巨人');
  assert.notEqual(normalizeTitle('進撃の巨人'), '');
});

test('editDistance is correct and respects its bail-out budget', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(editDistance('flaw', 'lawn'), 2);
  assert.ok(editDistance('kitten', 'sitting', 1) > 1);
});

test('short titles get no typo budget', () => {
  assert.equal(typoBudget(normalizeTitle('Steins;Gate')), 1);
  assert.equal(typoBudget('bleach'), 0);
});

test('matchesAnyTitle accepts synonyms and light typos', () => {
  const accepted = ['shingeki no kyojin', 'attack on titan'].map(normalizeTitle);
  assert.ok(matchesAnyTitle('Attack on Titan', accepted));
  assert.ok(matchesAnyTitle('shingeki no kyojin', accepted));
  assert.ok(matchesAnyTitle('Attack on Titen', accepted), 'one typo in a long title should pass');
  assert.equal(matchesAnyTitle('Sword Art Online', accepted), null);
  assert.equal(matchesAnyTitle('', accepted), null);
  assert.equal(matchesAnyTitle('   ', accepted), null);
});

test('an exact match is never stolen by a fuzzy near-miss', () => {
  const accepted = ['steins gate 0', 'steins gate'];
  assert.equal(matchesAnyTitle('Steins;Gate', accepted), 'steins gate');
  assert.equal(matchesAnyTitle('Steins;Gate 0', accepted), 'steins gate 0');
});

test('displayTitle leads with English and keeps romaji as subtext', () => {
  assert.deepEqual(displayTitle('Your Name.', 'Kimi no Na wa.'), {
    primary: 'Your Name.',
    secondary: 'Kimi no Na wa.',
  });
  assert.deepEqual(displayTitle('SCHOOL-LIVE!', 'Gakkou Gurashi!'), {
    primary: 'SCHOOL-LIVE!',
    secondary: 'Gakkou Gurashi!',
  });
});

test('displayTitle falls back to romaji when there is no English title', () => {
  assert.deepEqual(displayTitle(null, 'Nichijou'), { primary: 'Nichijou', secondary: null });
  assert.deepEqual(displayTitle(undefined, 'Nichijou'), { primary: 'Nichijou', secondary: null });
  assert.deepEqual(displayTitle('   ', 'Nichijou'), { primary: 'Nichijou', secondary: null });
});

test('displayTitle suppresses a subtext that just repeats the headline', () => {
  assert.equal(displayTitle('ONE PIECE', 'One Piece').secondary, null);
  assert.equal(displayTitle('Steins;Gate', 'Steins;Gate').secondary, null);
  assert.equal(displayTitle('Fruits Basket', 'Fruits Basket').secondary, null);
  assert.equal(displayTitle('Spirited Away', 'Sen to Chihiro no Kamikakushi').secondary,
    'Sen to Chihiro no Kamikakushi');
});

test('sanitizeSettings clamps hostile input', () => {
  const hostile = {
    ...DEFAULT_SETTINGS,
    totalRounds: 100_000,
    guessWindowMs: -5,
    answerMs: 0,
    themeTypes: ['OP', 'NOPE'] as never,
    yearMin: 1,
  };
  const safe = sanitizeSettings(hostile);
  assert.ok(safe.totalRounds <= 100);
  assert.ok(safe.guessWindowMs >= 5_000);
  assert.ok(safe.answerMs >= 3_000);
  assert.deepEqual(safe.themeTypes, ['OP']);
  assert.ok((safe.yearMin ?? 0) >= 1950);
});

test('sanitizeSettings falls back when every theme type is filtered out', () => {
  const safe = sanitizeSettings({ ...DEFAULT_SETTINGS, themeTypes: [] });
  assert.ok(safe.themeTypes.length > 0, 'an empty type list would make every round unplayable');
});

test('sanitizeSettings keeps the reveal long enough to watch but bounded', () => {
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, revealMs: 45_000 }).revealMs, 45_000);
  assert.ok(sanitizeSettings({ ...DEFAULT_SETTINGS, revealMs: 10 ** 9 }).revealMs <= 90_000);
  assert.ok(sanitizeSettings({ ...DEFAULT_SETTINGS, revealMs: -1 }).revealMs >= 2_000);
});

test('sanitizeSettings treats revealVideo as opt-out, not arbitrary truthiness', () => {
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, revealVideo: false }).revealVideo, false);
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, revealVideo: true }).revealVideo, true);
  const missing = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
  delete missing.revealVideo;
  assert.equal(sanitizeSettings(missing as typeof DEFAULT_SETTINGS).revealVideo, true);
});
