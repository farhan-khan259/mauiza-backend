import assert from 'node:assert/strict';
import test from 'node:test';
import { exactTafsir, tafsir, tafsirOptions, verse } from '../tadabbur/content.js';
import { wordStudy } from '../tadabbur/roots.js';
import { adjacentAyahKey, studyState } from '../tadabbur/study.js';
import { insertNote } from '../../mauiza-frontend/src/pages/Tadabbur/noteInsertion.js';

test('Corpus and Lughat join at the selected word address', async () => {
  const [worship, help, segmented] = await Promise.all(
    ['1:5:2', '1:5:4', '1:1:1'].map(address => wordStudy(address, 1))
  );
  assert.equal(worship.root, 'ع ب د');
  assert.equal(help.root, 'ع و ن');
  assert(worship.entries.some(entry => entry.id === 1018 && entry.pdfPage === 709));
  assert(help.entries.some(entry => entry.id === 1119 && entry.pdfPage === 776));
  assert.equal(new Set(help.references).size, help.references.length);
  assert.equal(segmented.segments.length, 2);
  assert.equal(await wordStudy('1:5:99', 1), null);
});

test('Verse responses keep the word-study fields used by room research tabs', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ verse: {
    verse_key: '1:5',
    text_uthmani: 'إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ',
    translations: [{ resource_id: 20, text: 'You alone we worship.' }],
    words: [{
      position: 2,
      char_type_name: 'word',
      text_uthmani: 'نَعْبُدُ',
      translation: { text: 'we worship' }
    }]
  } }));

  const result = await verse('1:5');
  const word = result.words[0];
  assert.equal(word.rootOccurrences, 275);
  assert.equal(word.partOfSpeech, 'verb');
  assert.equal(word.tense, 'imperfect');
  assert.equal(word.person, 'first person');
  assert.equal(word.segments[0].partOfSpeech, 'verb');
  assert(word.lughat.some(entry => entry.id === 1018));
});

test('Tafsir accepts only verified one-ayah scope and discovers provider choices', async t => {
  assert.equal(exactTafsir({ verses: { '1:5': {} }, text: 'Verse commentary' }, '1:5'), 'Verse commentary');
  assert.equal(exactTafsir({ verses: { '1:5': {}, '1:6': {} }, text: 'Grouped commentary' }, '1:5'), null);
  assert.equal(exactTafsir({ text: 'Unknown scope' }, '1:5'), null);
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/resources/tafsirs')) return Response.json({ tafsirs: [
      { id: 169, name: 'Tafsir Ibn Kathir', language_name: 'english' },
      { id: '16', name: 'Al-Muyassar', language_name: 'arabic' },
      { id: 164, name: 'Tafseer ibn Kathir', language_name: 'bengali' }
    ] });
    const key = url.pathname.endsWith('1:5') ? '1:5' : '1:6';
    return Response.json({ tafsir: { verses: { [key]: {} }, text: url.pathname } });
  });
  const sources = await tafsirOptions();
  assert.deepEqual(sources.map(source => source.id), [169, 16, 164]);
  assert.equal(sources.find(source => source.id === 164).language, 'bn');
  assert.equal((await tafsir('1:5', '169')).key, '1:5');
  assert.equal((await tafsir('1:6', '16')).language, 'ar');
  assert.deepEqual(
    (({ source, ayahKey }) => ({ source, ayahKey }))(await tafsir('1:5', 'kathir')),
    { source: 'kathir', ayahKey: '1:5' }
  );
  await assert.rejects(() => tafsir('1:5', '990'), { status: 400 });
});

test('Legacy Act rooms resolve to Discuss without removing saved notes', () => {
  const notes = [{ text: 'Existing note' }];
  const study = studyState({ study: { phase: 'Act', notes } });
  assert.equal(study.phase, 'Discuss');
  assert.equal(study.notes, notes);
});

test('Ayah navigation moves across verses and surah boundaries, stopping at Quran ends', () => {
  const chapters = [{ id: 1, count: 7 }, { id: 2, count: 286 }, { id: 3, count: 200 }];
  assert.equal(adjacentAyahKey('2:5', -1, chapters), '2:4');
  assert.equal(adjacentAyahKey('2:1', -1, chapters), '1:7');
  assert.equal(adjacentAyahKey('1:7', 1, chapters), '2:1');
  assert.equal(adjacentAyahKey('1:1', -1, chapters), null);
  assert.equal(adjacentAyahKey('3:200', 1, chapters), null);
  assert.throws(() => adjacentAyahKey('2:287', 1, chapters), { status: 400 });
});

test('Note insertion preserves surrounding content and keeps source links', () => {
  const block = 'نَسْتَعِينُ\nCorpus word: https://corpus.quran.com/wordmorphology.jsp';
  const first = insertNote('Before After', block, { start: 7, end: 7 });
  assert.equal(first.text, 'Before \n\n' + block + '\n\nAfter');
  const second = insertNote(first.text, 'نَعْبُدُ', { start: first.caret, end: first.caret });
  assert.equal(second.text, 'Before \n\n' + block + '\n\nنَعْبُدُ\n\nAfter');
  assert.equal(insertNote('Prior draft', block).text, 'Prior draft\n\n' + block);
});
