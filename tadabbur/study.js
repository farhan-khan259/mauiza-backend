import { ayahContext } from './context.js';
import express from 'express';
import mongoose, { Schema } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { problem } from './quran.js';
import { rootReference, wordStudy } from './roots.js';
import { ayahKey, chapters as quranChapters, passage, reciters, englishTafsir, tafsirOptions, translationOptions, verse } from './content.js';

export const phases = ['Read', 'Reflect', 'Reveal', 'Discuss'];
const initialPassage = { label: 'Al-Fatihah', keys: ['1:5', '1:6', '1:7'] };

export function adjacentAyahKey(value, direction, chapters) {
  if (direction !== -1 && direction !== 1) throw problem(400, 'Choose a valid navigation direction.');
  const [chapterId, verseNumber] = ayahKey(value).split(':').map(Number);
  const index = chapters.findIndex(chapter => chapter.id === chapterId);
  const chapter = chapters[index];
  if (!chapter || verseNumber > chapter.count) throw problem(400, 'The current ayah is unavailable.');
  if (direction === -1) {
    if (verseNumber > 1) return `${chapter.id}:${verseNumber - 1}`;
    const previous = chapters[index - 1];
    return previous ? `${previous.id}:${previous.count}` : null;
  }
  if (verseNumber < chapter.count) return `${chapter.id}:${verseNumber + 1}`;
  const next = chapters[index + 1];
  return next ? `${next.id}:1` : null;
}

const Document = mongoose.model('TadabburStudyDocument', new Schema({
  _id: String, room: { type: String, index: true }, owner: String, ownerName: String,
  name: String, type: String, data: { type: Buffer, select: false }, gridFsId: String, size: Number, shared: Boolean
}, { timestamps: true }));
let gridFsDatabase;
let gridFsBucket;
function documentBucket() {
  const database = mongoose.connection.db;
  if (!database) throw problem(503, 'Room storage is temporarily unavailable.');
  if (database !== gridFsDatabase) {
    gridFsDatabase = database;
    gridFsBucket = new mongoose.mongo.GridFSBucket(database, { bucketName: 'tadabburStudyDocuments' });
  }
  return gridFsBucket;
}
const documentReaders = new Map();
const sweepReaders = setInterval(() => {
  for (const [room, readers] of documentReaders) {
    for (const [owner, entry] of readers) if (entry.expires <= Date.now()) readers.delete(owner);
    if (!readers.size) documentReaders.delete(room);
  }
}, 30000);
sweepReaders.unref();
const audioLanguages = new Set(['en', 'es', 'ar', 'ur', 'fr', 'tr', 'id', 'pt', 'de', 'hi']);

export function studyState(room) {
  return {
    selection: initialPassage, index: 0, notes: [], document: null,
    recitation: null, ...room.study, phase: room.study?.phase === 'Act' ? 'Discuss' : room.study?.phase || 'Reflect'
  };
}

export function publicStudy(room) {
  const state = studyState(room);
  const now = Date.now();
  const readers = [...(documentReaders.get(room._id) || [])].flatMap(([owner, entry]) =>
    entry.expires > now && room.members.some(member => member._id === owner && !member.removed)
      ? [{ owner, mode: entry.mode === 'follow' && entry.document === state.document?.id ? 'follow' : 'browse' }]
      : []
  );
  return {
    ...state, readers,
    translationAvailable: Boolean(process.env.GOOGLE_TRANSLATE_API_KEY?.trim())
  };
}

async function translateWithGoogle(text, target, source, html) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  if (!key) throw new Error('Google Cloud Translation is not configured.');
  const params = new URLSearchParams({ key });
  const reply = await fetch('https://translation.googleapis.com/language/translate/v2?' + params, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target, ...(source ? { source } : {}), format: html ? 'html' : 'text' }),
    signal: AbortSignal.timeout(9000)
  });
  if (reply.status === 401 || reply.status === 403) throw problem(503, 'Google Cloud Translation rejected its API key or project configuration.');
  if (reply.status === 429) throw problem(429, 'Google Cloud Translation quota reached.');
  if (!reply.ok) throw new Error('Google Cloud Translation request failed.');
  const result = await reply.json();
  const translation = result?.data?.translations?.[0];
  if (!translation?.translatedText) throw new Error('Google Cloud Translation response was empty.');
  return { text: translation.translatedText, detected: translation.detectedSourceLanguage || source || null };
}

async function translateText(text, target, source, html = false) {
  if (target === source) return { text, detected: source };
  if (!process.env.GOOGLE_TRANSLATE_API_KEY?.trim()) {
    throw problem(503, 'Google Cloud Translation is not configured. Add GOOGLE_TRANSLATE_API_KEY to the backend environment.');
  }
  try {
    return await translateWithGoogle(text, target, source, html);
  } catch (error) {
    if (error.status) throw error;
    throw problem(502, 'Google Cloud Translation is unavailable. Check its API key, billing, quota, and network access.');
  }
}

const translationCache = new Map();
function translated(caption, target, room) {
  const key = [room, caption.id, target].join(':');
  if (!translationCache.has(key)) {
    if (translationCache.size >= 300) translationCache.delete(translationCache.keys().next().value);
    const promise = translateText(caption.text, target, caption.language).then(result => result.text);
    translationCache.set(key, promise);
    promise.catch(() => translationCache.delete(key));
  }
  return translationCache.get(key);
}

function identify(file) {
  const start = file.subarray(0, 12);
  if (start.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (start.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (start.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (start.subarray(0, 4).toString() === 'RIFF' && start.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

function inspectDocumentType() {
  let header = Buffer.alloc(0);
  let type = '';
  let size = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (header.length === 12) return callback(null, chunk);
      const prefixLength = Math.min(12 - header.length, chunk.length);
      const remainder = chunk.subarray(prefixLength);
      header = Buffer.concat([header, chunk.subarray(0, prefixLength)]);
      if (header.length < 12) return callback();
      type = identify(header);
      if (!type) return callback(problem(400, 'Choose a PDF, PNG, JPEG or WebP file.'));
      callback(null, remainder.length ? Buffer.concat([header, remainder]) : header);
    },
    flush(callback) {
      if (!type) {
        type = identify(header);
        if (!type) return callback(problem(400, 'Choose a PDF, PNG, JPEG or WebP file.'));
        this.push(header);
      }
      callback();
    }
  });
  return { stream, get type() { return type; }, get size() { return size; } };
}

async function documentInfo(record) {
  let size = record.size ?? record.data?.length;
  if (size == null && record.gridFsId) {
    const file = await documentBucket().find({ _id: record.gridFsId }).next();
    size = file?.length;
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw problem(500, 'Stored document size is unavailable.');
  return { id: record._id, owner: record.owner, ownerName: record.ownerName, name: record.name, type: record.type, size, shared: record.shared };
}

export function registerStudyRoutes(router, { asHandler, roomFor, protect, write, notify }) {
  function handle(fn, options) {
    return asHandler(async (req, res, next) => {
      const room = await roomFor(req);
      const member = protect(req, room, options);
      return fn(req, res, room, member, studyState(room), next);
    });
  }
  async function update(req, res, room, study, changes) {
    const next = await write(room, { study: { ...study, ...changes } });
    notify(req, next);
    res.json({ study: publicStudy(next), revision: next.revision });
  }

  router.get('/rooms/:id/study/chapters', handle(async (_req, res) => {
    res.json(await quranChapters());
  }));

  router.get('/rooms/:id/study/verse', handle(async (req, res, _room, _member, study) => {
    const key = ayahKey(req.query.key || study.selection.keys[study.index]);
    const index = study.selection.keys.indexOf(key);
    if (index < 0 || index > study.index + 1) throw problem(404, 'This ayah has not been opened yet.');
    const language = typeof req.query.translation === 'string' && /^[1-9]\d{0,5}$/.test(req.query.translation)
      ? req.query.translation : req.query.lang === 'ur' ? 'ur' : 'en';
    if (req.query.kind === 'context') return res.json({ key, entries: ayahContext(key) });
    if (req.query.kind === 'tafsir') return res.json(await englishTafsir(key, req.query.source));
    res.json(await verse(key, language));
  }));

  router.get('/rooms/:id/study/translations', handle(async (_req, res) => {
    res.json(await translationOptions());
  }));

  router.post('/rooms/:id/study/translate', handle(async (req, res) => {
    const { text, target } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || text.length > 3000 || !audioLanguages.has(target)) {
      throw problem(400, 'Enter up to 3,000 characters and choose a translation language.');
    }
    res.set('Cache-Control', 'private, no-store');
    res.json(await translateText(text.trim(), target));
  }));

  router.get('/rooms/:id/study/tafsirs', handle(async (_req, res) => {
    res.json((await tafsirOptions()).filter(item => item.language === 'en'));
  }));

  router.get('/rooms/:id/study/word', handle(async (req, res, _room, _member, study) => {
    const address = typeof req.query.address === 'string' ? req.query.address : '';
    const match = /^(\d{1,3}:\d{1,3}):[1-9]\d{0,2}$/.exec(address);
    const index = match ? study.selection.keys.indexOf(match[1]) : -1;
    if (index < 0 || index > study.index + 1) throw problem(404, 'This word has not been opened yet.');
    if (req.query.reference !== undefined) {
      const reference = typeof req.query.reference === 'string' &&
        /^\d{1,3}:\d{1,3}:[1-9]\d{0,2}$/.test(req.query.reference) ? req.query.reference : '';
      const occurrence = await rootReference(address, reference);
      if (!occurrence) throw problem(404, 'This root occurrence is unavailable.');
      return res.json(occurrence);
    }
    const page = Math.max(1, Math.min(5000, Number.parseInt(req.query.page, 10) || 1));
    const result = await wordStudy(address, page);
    if (!result) throw problem(404, 'Corpus data is unavailable for this word.');
    res.json(result);
  }));

  router.post('/rooms/:id/study/lead', handle(async (req, res, room, _member, study) => {
    const { action, value } = req.body;
    if (action === 'phase' && phases.includes(value)) return update(req, res, room, study, { phase: value });
    if (action === 'ayah-step' && (value === -1 || value === 1)) {
      const chapters = await quranChapters();
      const key = study.selection.keys[study.index];
      const nextKey = adjacentAyahKey(key, value, chapters);
      if (!nextKey) {
        res.json({ study: publicStudy(room), revision: room.revision });
        return;
      }
      const [chapter, first] = nextKey.split(':').map(Number);
      const selection = await passage({ chapter, first, last: first });
      return update(req, res, room, study, { selection, index: 0, recitation: null });
    }
    if (action === 'ayah' && Number.isInteger(value) && study.selection.keys[value]) {
      return update(req, res, room, study, { index: value, recitation: null });
    }
    if (action === 'passage') {
      const selection = await passage(value || {});
      if (selection.keys.length > 30) throw problem(400, 'Choose no more than 30 ayahs per study passage.');
      return update(req, res, room, study, { selection, index: 0, recitation: null });
    }
    if (action === 'stop') return update(req, res, room, study, { recitation: null });
    if (action === 'recite' && Object.hasOwn(reciters, value)) {
      const result = await verse(study.selection.keys[study.index], 'en', value);
      if (!result.audio) throw problem(502, 'The selected recitation is unavailable.');
      return update(req, res, room, study, { recitation: { url: result.audio, segments: result.audioSegments, name: reciters[value], starts: Date.now() + 2500 } });
    }
    throw problem(400, 'Choose a valid study action.');
  }, { creator: true }));

  router.post('/rooms/:id/study/reveal', handle(async (req, res, room, member, study) => {
    const key = ayahKey(req.body.key);
    if (req.body.hide !== true && !study.selection.keys.includes(key)) throw problem(400, 'Choose an ayah from this passage.');
    const notes = study.notes.filter(note => note.owner !== member._id || note.key !== key);
    if (req.body.hide !== true) {
      if (!['Reveal', 'Discuss'].includes(study.phase)) throw problem(409, 'Wait for the host to open the Reveal phase.');
      const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 3000) : '';
      if (!text) throw problem(400, 'Write a note before revealing it.');
      if (notes.length >= 60) throw problem(409, 'The room has reached its shared note limit.');
      notes.push({ owner: member._id, name: member.name, key, text });
    }
    return update(req, res, room, study, { notes });
  }));

  router.get('/rooms/:id/study/revealed-translation', handle(async (req, res, room, _member, study) => {
    const { owner, key, language } = req.query;
    if (!audioLanguages.has(language)) throw problem(400, 'Choose a supported translation language.');
    const note = study.notes.find(item => item.owner === owner && item.key === key);
    if (!note) throw problem(404, 'This reflection is no longer revealed.');
    const id = createHash('sha256').update(note.text).digest('hex');
    const text = await translated({ id, text: note.text }, language, room._id);
    res.json({ text });
  }));

  router.post('/rooms/:id/study/reader', handle(async (req, res, room, member) => {
    const { mode, document } = req.body;
    if (!['follow', 'browse', 'leave'].includes(mode)) throw problem(400, 'Choose a reading mode.');
    const readers = documentReaders.get(room._id) || new Map();
    const previous = readers.get(member._id);
    if (mode === 'leave') readers.delete(member._id);
    else {
      if (typeof document !== 'string' || !/^[a-f\d-]{36}$/i.test(document)) throw problem(400, 'Choose a document.');
      if ((!previous || previous.document !== document) && !await Document.exists({ _id: document, room: room._id, $or: [{ owner: member._id }, { shared: true }] })) throw problem(404, 'Document not found.');
      readers.set(member._id, { mode, document, expires: Date.now() + 19000 });
    }
    if (readers.size) documentReaders.set(room._id, readers);
    else documentReaders.delete(room._id);
    if (!previous || previous.mode !== mode || previous.document !== document) notify(req, room);
    res.json({ accepted: true });
  }));

  router.get('/rooms/:id/study/documents', handle(async (_req, res, room, member) => {
    const documents = await Document.find({ room: room._id, $or: [{ owner: member._id }, { shared: true }] }).select('+data').sort('createdAt');
    res.json(await Promise.all(documents.map(documentInfo)));
  }));

  router.post('/rooms/:id/study/documents', handle(async (req, res, room, member) => {
    const name = typeof req.query.name === 'string' ? req.query.name.replace(/[\u0000-\u001f]/g, '').slice(0, 120) : '';
    if (!name) throw problem(400, 'Choose a document file.');
    const id = randomUUID();
    const bucket = documentBucket();
    const upload = bucket.openUploadStreamWithId(id, name);
    const inspected = inspectDocumentType();
    let record;
    try {
      await pipeline(req, inspected.stream, upload);
      record = await Document.create({
        _id: id, room: room._id, owner: member._id, ownerName: member.name,
        name, type: inspected.type, gridFsId: id, size: inspected.size, shared: false
      });
    } catch (error) {
      try {
        await upload.abort();
      } catch {
        try {
          await bucket.delete(id);
        } catch (cleanupError) {
          console.error('Mauiza document upload cleanup:', cleanupError.message);
        }
      }
      throw error;
    }
    res.status(201).json(await documentInfo(record));
  }));

  router.delete('/rooms/:id/study/documents/:document', handle(async (req, res, room, member, study) => {
    const id = req.params.document;
    const record = await Document.findOne({ _id: id, room: room._id, $or: [{ owner: member._id }, { shared: true }] });
    if (!record) throw problem(404, 'Document not found.');
    if (record.owner !== member._id && room.creatorId !== member._id) throw problem(403, 'Only the owner or host can delete this document.');
    const next = await write(room, study.document?.id === id ? { study: { ...study, document: null } } : {});
    if (record.gridFsId) await documentBucket().delete(record.gridFsId);
    await Document.deleteOne({ _id: id, room: room._id });
    notify(req, next);
    res.json({ deleted: true });
  }));

  router.get('/rooms/:id/study/documents/:document', handle(async (req, res, room, member, _study, next) => {
    const record = await Document.findOne({ _id: req.params.document, room: room._id, $or: [{ owner: member._id }, { shared: true }] }).select('+data');
    if (!record) throw problem(404, 'Document not found.');
    res.set({ 'Content-Type': record.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' });
    const range = req.headers.range;
    if (!range) {
      if (!record.gridFsId) return res.send(record.data);
      const download = documentBucket().openDownloadStream(record.gridFsId);
      download.on('error', error => {
        if (res.headersSent) res.destroy(error);
        else next(error);
      });
      return download.pipe(res);
    }
    let size = record.size ?? record.data?.length;
    if (size == null && record.gridFsId) {
      const file = await documentBucket().find({ _id: record.gridFsId }).next();
      size = file?.length;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!Number.isSafeInteger(size) || size <= 0 || !match) {
      return res.status(416).set('Content-Range', `bytes */${size || 0}`).end();
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) + 1 : size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd <= start) {
      return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }
    const end = Math.min(requestedEnd, size);
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end - 1}/${size}`,
      'Content-Length': String(end - start)
    });
    if (!record.gridFsId) return res.end(record.data.subarray(start, end));
    const download = documentBucket().openDownloadStream(record.gridFsId, { start, end });
    download.on('error', error => {
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
    download.pipe(res);
  }));

  router.post('/rooms/:id/study/present', handle(async (req, res, room, member, study) => {
    const { document, page, stop } = req.body;
    if (stop) {
      if (study.document?.presenter !== member._id && room.creatorId !== member._id) throw problem(403, 'Only the presenter or host can stop presenting.');
      return update(req, res, room, study, { document: null });
    }
    const record = await Document.findOne({ _id: typeof document === 'string' ? document : '', room: room._id, $or: [{ owner: member._id }, { shared: true }] });
    if (!record) throw problem(404, 'Document not found.');
    if (!Number.isInteger(page) || page < 1 || page > 5000 || (record.type !== 'application/pdf' && page !== 1)) throw problem(400, 'Invalid document page.');
    if (study.document && study.document.presenter !== member._id && member._id !== room.creatorId) throw problem(409, 'Someone is already presenting. Ask them to stop first.');
    if (!record.shared) { record.shared = true; await record.save(); }
    return update(req, res, room, study, { document: { id: record._id, presenter: member._id, name: member.name, page } });
  }));

}
