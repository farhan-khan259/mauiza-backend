import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { englishTafsir, tafsirCoverage } from '../tadabbur/content.js';
import { meetingNote } from '../../mauiza-frontend/src/pages/Tadabbur/meetingNotes.js';
import { ayahContext } from '../tadabbur/context.js';
import { rootReference } from '../tadabbur/roots.js';
import { registerStudyRoutes } from '../tadabbur/study.js';
import { cameraCrop } from '../../mauiza-frontend/src/pages/Tadabbur/effects.js';

const routes = new Map();
const room = {
  _id: 'room', creatorId: 'host', revision: 1, phase: 'live',
  study: { selection: { keys: ['1:5', '1:6', '1:7'] }, index: 0, document: { id: 'pdf' } }
};
const router = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, ...handlers) => routes.set(method + ' ' + path, handlers.at(-1))]));
registerStudyRoutes(router, {
  asHandler: handler => handler, roomFor: () => room, protect: req => req.member,
  write: (original, changes) => ({ ...original, ...changes }), notify() {}
});

async function invoke(method, path, req = {}) {
  let result;
  const res = { set() {}, json: data => { result = data; } };
  await routes.get(method + ' /rooms/:id/study/' + path)({ member: { _id: 'host' }, ...req }, res);
  return result;
}

test('Context includes only the selected surah and recorded ayah range', async () => {
  const context = await invoke('get', 'verse', { query: { kind: 'context', key: '1:5' } });
  assert.equal(context.key, '1:5');
  assert(context.entries.length > 0);
  assert(context.entries.every(entry => entry.surah === 1 && entry.from <= 5 && entry.to >= 5));
  assert.deepEqual(ayahContext('2:286').filter(entry => entry.surah !== 2 || entry.to < 286), []);
  assert.deepEqual(ayahContext('7:200'), []);
  await assert.rejects(invoke('get', 'verse', { query: { kind: 'context', key: '1:7' } }), { status: 404 });
});

test('Roots return local Corpus details only for a matching reference', async () => {
  const hit = await rootReference('1:5:4', '1:5:4');
  assert.equal(hit.word, 'نَسْتَعِينُ');
  assert.equal(hit.root, 'ع و ن');
  assert(hit.lemma);
  assert.equal(await rootReference('1:5:4', '1:5:2'), null);
});

test('Typed translation uses Google Cloud Translation and returns detected language', async t => {
  const savedGoogleKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  process.env.GOOGLE_TRANSLATE_API_KEY = 'google-test-key';
  t.after(() => {
    if (savedGoogleKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = savedGoogleKey;
  });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://translation.googleapis.com');
    assert.equal(url.searchParams.get('key'), 'google-test-key');
    assert.deepEqual(JSON.parse(options.body), { q: 'Hola', target: 'en', format: 'text' });
    return Response.json({ data: { translations: [{ translatedText: 'Hello', detectedSourceLanguage: 'es' }] } });
  });
  assert.deepEqual(await invoke('post', 'translate', { body: { text: 'Hola', target: 'en' } }), { text: 'Hello', detected: 'es' });
});

test('Typed translation reports Google failures without using another provider', async t => {
  const savedGoogleKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  process.env.GOOGLE_TRANSLATE_API_KEY = 'google-test-key';
  t.after(() => {
    if (savedGoogleKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = savedGoogleKey;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  await assert.rejects(
    invoke('post', 'translate', { body: { text: 'Hola', target: 'en' } }),
    { status: 502, message: 'Google Cloud Translation is unavailable. Check its API key, billing, quota, and network access.' }
  );
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(invoke('post', 'translate', { body: { text: '   ', target: 'en' } }), { status: 400 });
  assert(!routes.has('post /rooms/:id/study/captions'));
});

test('Typed translation reports missing Google configuration', async t => {
  const savedGoogleKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  t.after(() => {
    if (savedGoogleKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = savedGoogleKey;
  });
  await assert.rejects(
    invoke('post', 'translate', { body: { text: 'Hola', target: 'en' } }),
    { status: 503, message: 'Google Cloud Translation is not configured. Add GOOGLE_TRANSLATE_API_KEY to the backend environment.' }
  );
});

test('Document deletion is scoped to the room and requires ownership or host rights', async t => {
  const Document = mongoose.model('TadabburStudyDocument');
  t.mock.method(Document, 'findOne', async filter => {
    assert.equal(filter.room, 'room');
    return { owner: 'owner' };
  });
  const remove = t.mock.method(Document, 'deleteOne', async filter => {
    assert.deepEqual(filter, { _id: 'pdf', room: 'room' });
  });
  await assert.rejects(invoke('delete', 'documents/:document', { params: { document: 'pdf' }, member: { _id: 'guest' } }), { status: 403 });
  assert.equal(remove.mock.callCount(), 0);
  assert.deepEqual(await invoke('delete', 'documents/:document', { params: { document: 'pdf' } }), { deleted: true });
  assert.equal(remove.mock.callCount(), 1);
});

test('Document byte ranges return only requested bytes and reject unsupported ranges', async t => {
  const Document = mongoose.model('TadabburStudyDocument');
  const data = Buffer.from('0123456789');
  t.mock.method(Document, 'findOne', () => ({ select: () => Promise.resolve({ type: 'application/pdf', data }) }));
  let status, headers, body;
  const res = {
    status(code) { status = code; return this; },
    set(name, value) {
      headers = typeof name === 'string' ? { ...headers, [name]: value } : { ...headers, ...name };
      return this;
    },
    end(value) { body = value; }
  };
  await routes.get('get /rooms/:id/study/documents/:document')({
    params: { document: 'pdf' }, headers: { range: 'bytes=2-6' }, member: { _id: 'host' }
  }, res);
  assert.equal(status, 206);
  assert.equal(headers['Content-Range'], 'bytes 2-6/10');
  assert.equal(headers['Content-Length'], '5');
  assert.equal(body.toString(), '23456');
  status = undefined;
  headers = undefined;
  await routes.get('get /rooms/:id/study/documents/:document')({
    params: { document: 'pdf' }, headers: { range: 'bytes=50-' }, member: { _id: 'host' }
  }, res);
  assert.equal(status, 416);
  assert.equal(headers['Content-Range'], 'bytes */10');
});

test('Camera framing zooms distant subjects while keeping the crop on screen', () => {
  assert.deepEqual(cameraCrop(null, 640, 360), [0, 0, 640, 360]);
  const [x, y, w, h] = cameraCrop({ x: 600, y: 10, width: 20, height: 28 }, 640, 360, true);
  assert(w < 640 && x >= 0 && x + w <= 640 && y >= 0 && y + h <= 360);
  assert.equal(w / h, 640 / 360);
});

test('Tafsir uses verified grouped coverage and falls back to another English source', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const path = new URL(input).pathname;
    paths.push(path);
    if (path.endsWith('/resources/tafsirs')) return Response.json({ tafsirs: [
      { id: 169, name: 'Ibn Kathir', language_name: 'English' },
      { id: 168, name: 'Maarif', language_name: 'English' },
      { id: 16, name: 'Al Muyassar', language_name: 'Arabic' }
    ] });
    if (path.includes('/169/')) return new Response(null, { status: 404 });
    return Response.json({ tafsir: { text: '<p>Grouped commentary</p>', verses: { '15:4': {}, '15:5': {} } } });
  });
  const sources = await invoke('get', 'tafsirs');
  assert.deepEqual(sources.map(item => item.id), [169, 168]);
  const result = await englishTafsir('15:5', '169');
  assert.equal(result.name, 'Maarif');
  assert.equal(result.fallbackFrom, 'Ibn Kathir');
  assert.deepEqual(result.coverage, ['15:4', '15:5']);
  assert(!paths.some(path => path.includes('/16/')));
  assert.deepEqual(tafsirCoverage({ text: 'Other verses', verses: { '15:4': {} } }, '15:5'), []);
});

test('Meeting notes combine legacy entries and keep a deliberately cleared meeting note empty', () => {
  const legacy = { private: { text: 'General note' }, '1:5': { text: 'First reflection' }, '7:200': { text: 'Second reflection' } };
  assert.equal(meetingNote(legacy).text, 'General note\n\nAyah 1:5\nFirst reflection\n\nAyah 7:200\nSecond reflection');
  assert.equal(meetingNote({ ...legacy, meeting: { text: '' } }).text, '');
  assert.equal(meetingNote({ ...legacy, meeting: { text: 'Final meeting draft' } }).text, 'Final meeting draft');
});
