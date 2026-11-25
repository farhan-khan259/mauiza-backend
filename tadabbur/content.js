import { verseRoots, wordStudy } from './roots.js';

const legacy = 'https://api.quran.com/api/v4';
const cache = new Map();
let accessToken;
let accessRequest;

export function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getJson(url, options = {}) {
  const send = () => fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  let response;
  try { response = await send(); }
  catch { response = null; }
  if (!response || response.status >= 500) {
    await new Promise(resolve => setTimeout(resolve, 400));
    response = await send();
  }
  if (!response.ok) throw problem(response.status, `Upstream HTTP ${response.status}`);
  return response.json();
}

async function getAccessToken() {
  if (accessToken?.expires > Date.now()) return accessToken.value;
  if (!accessRequest) {
    const basic = Buffer.from(`${process.env.QURAN_CLIENT_ID}:${process.env.QURAN_CLIENT_SECRET}`).toString('base64');
    accessRequest = getJson('https://oauth2.quran.foundation/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: process.env.QURAN_CONTENT_SCOPE || 'content'
      })
    }).then(data => {
      accessToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
      return accessToken.value;
    }).finally(() => { accessRequest = undefined; });
  }
  return accessRequest;
}

async function quran(path, search = false) {
  const key = `${search}:${path}`;
  if (cache.has(key)) return cache.get(key);
  const request = (async () => {
    try {
      if (process.env.QURAN_CLIENT_ID && process.env.QURAN_CLIENT_SECRET) {
        try {
          const headers = { 'x-auth-token': await getAccessToken(), 'x-client-id': process.env.QURAN_CLIENT_ID };
          return await getJson(`https://apis.quran.foundation${search ? '/api/v1' : '/content/api/v4'}${path}`, { headers });
        } catch { /* The public content service also serves the study room's content routes. */ }
      }
      return await getJson(legacy + path);
    } catch (error) {
      if (error.status === 404 && path.startsWith('/tafsirs/')) throw problem(404, 'Commentary is unavailable from this source.');
      throw problem(502, 'The Quran source is temporarily unavailable. Please try again.');
    }
  })();
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, request);
  request.catch(() => cache.delete(key));
  return request;
}

export async function chapters() {
  const data = await quran('/chapters?language=en');
  return data.chapters.map(({ id, name_simple, name_arabic, verses_count }) => ({
    id, name: name_simple, arabic: name_arabic, count: verses_count
  }));
}

export async function passage(input) {
  const ruku = Number(input.ruku);
  if (input.kind === 'ruku') {
    if (!Number.isInteger(ruku) || ruku < 1 || ruku > 558) throw problem(400, 'Choose a ruku from 1 to 558.');
    let page = 1;
    const keys = [];
    while (page) {
      const result = await quran(`/verses/by_ruku/${ruku}?per_page=50&page=${page}`);
      keys.push(...result.verses.map(verse => verse.verse_key));
      page = result.pagination?.next_page;
    }
    if (!keys.length) throw problem(502, 'No verses were returned for this ruku.');
    return { label: `Ruku ${ruku}`, keys };
  }

  const start = Number(input.first);
  const end = Number(input.last || input.first);
  const chapter = (await chapters()).find(item => item.id === Number(input.chapter));
  if (!chapter || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > chapter.count) {
    throw problem(400, 'Choose a valid surah and ayah range.');
  }
  return { label: `${chapter.name} · ${start}${end === start ? '' : `–${end}`}`, keys: Array.from({ length: end - start + 1 }, (_, i) => `${chapter.id}:${start + i}`) };
}

export function ayahKey(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(value)) throw problem(400, 'Choose a valid ayah.');
  return value;
}

export const reciters = { 7: 'Mishary Rashid Alafasy', 1: 'Abdul Basit Abdus Samad (Mujawwad)', 2: 'Abdul Basit Abdus Samad (Murattal)' };

const partOfSpeechNames = { N: 'noun', V: 'verb', ADJ: 'adjective', PN: 'proper noun', PRON: 'pronoun', P: 'preposition', DET: 'determiner', CONJ: 'conjunction' };

function morphologyFields(segment) {
  const features = segment?.features || [];
  const feature = prefix => features.find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
  const has = value => features.includes(value);
  return {
    partOfSpeech: partOfSpeechNames[segment?.pos] || segment?.pos || '',
    lemma: feature('LEM:'),
    form: feature('FORM:'),
    tense: has('IMPF') ? 'imperfect' : has('PERF') ? 'perfect' : feature('MOOD:'),
    person: has('1P') ? 'first person' : has('2P') ? 'second person' : has('3P') ? 'third person' : '',
    gender: has('MS') ? 'masculine' : has('FS') ? 'feminine' : has('MD') ? 'masculine dual' : has('FD') ? 'feminine dual' : '',
    number: has('DU') ? 'dual' : has('PL') ? 'plural' : has('SG') || has('MS') || has('FS') ? 'singular' : ''
  };
}

function compatibleSegment(segment) {
  return { ...segment, ...morphologyFields(segment) };
}

export function audioLink(value) {
  if (!value) return null;
  const url = new URL(value, 'https://verses.quran.com/');
  return url.protocol === 'https:' ? url.href : null;
}

export async function translationOptions() {
  const result = await quran('/resources/translations?language=en');
  return (result.translations || []).filter(item => Number.isSafeInteger(Number(item.id)) && item.name)
    .map(item => ({
      id: Number(item.id), name: item.name, language: item.language_name || 'Other',
      rtl: /^(arabic|urdu|persian|farsi|hebrew|pashto|dari|uyghur|sindhi|kurdish|kashmiri|dhivehi)$/i.test(item.language_name || '')
    })).sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

export async function verse(value, language = 'en', reciter = 7) {
  const key = ayahKey(value);
  const translationId = language === 'ur' ? 97 : language === 'en' ? 20 : Number(language);
  const selected = !['en', 'ur'].includes(language)
    ? (await translationOptions()).find(item => item.id === translationId)
    : null;
  if (!['en', 'ur'].includes(language) && !selected) throw problem(400, 'Choose an available Quran translation.');
  const data = await quran(`/verses/by_key/${key}?fields=text_uthmani&translations=${translationId}&words=true&word_fields=text_uthmani&language=en&audio=${reciter}`);
  const item = data.verse;
  if (!item?.text_uthmani || item.verse_key !== key) throw problem(502, 'The Quran source did not return the requested Uthmani text.');
  const words = await verseRoots(key, (item.words || []).filter(word => word.char_type_name === 'word').map(word => ({
    position: word.position, arabic: word.text_uthmani || word.text,
    meaning: word.translation?.text, transliteration: word.transliteration?.text
  })));
  return {
    key, arabic: item.text_uthmani, translation: item.translations?.find(entry => entry.resource_id === translationId)?.text,
    translationName: selected?.name || (language === 'ur' ? 'Tafheem e Qur’an · Syed Abu Ali Maududi' : 'Saheeh International'),
    translationDirection: selected?.rtl || language === 'ur' ? 'rtl' : 'auto',
    audio: audioLink(item.audio?.url), audioSegments: item.audio?.segments || [],
    words: await Promise.all(words.map(async word => {
      const segments = (word.segments || []).map(compatibleSegment);
      const study = word.root ? await wordStudy(`${key}:${word.position}`, 1) : null;
      return {
        ...word,
        ...morphologyFields(segments[0]),
        segments,
        lughat: study?.entries || []
      };
    }))
  };
}

const tafsirSourceIds = {
  kathir: 169,
  tabari: 15,
  qurtubi: 90,
  sadi: 91,
  maarif: 168
};

export async function tafsirOptions() {
  const response = await quran('/resources/tafsirs?language=en');
  return (response.tafsirs || []).filter(item => Number.isSafeInteger(Number(item.id)) && (item.name || item.translated_name?.name || item.slug))
    .map(item => {
      const languageName = (item.language_name || item.translated_name?.language_name || '').toLowerCase();
      const languageCodes = { arabic: 'ar', bengali: 'bn', english: 'en', russian: 'ru', urdu: 'ur' };
      const slugLanguage = /^(ar|bn|en|ru|ur)-/i.exec(item.slug || '')?.[1]?.toLowerCase();
      return {
        id: Number(item.id),
        name: item.translated_name?.name || item.name || item.slug,
        language: languageCodes[languageName] || slugLanguage || (Number(item.language_id) === 38 ? 'en' : 'und')
      };
    }).sort((a, b) => Number(b.id === 169) - Number(a.id === 169) || a.name.localeCompare(b.name));
}

export function exactTafsir(record, key) {
  const keys = record?.verses && Object.keys(record.verses);
  const exact = keys?.length === 1 && keys[0] === key;
  const groups = record?.group_verses || record?.groupVerseKeys;
  if ((Array.isArray(groups) && (groups.length !== 1 || groups[0] !== key)) ||
      (record?.group_verse_key && record.group_verse_key !== key) ||
      (record?.groupVerseKey && record.groupVerseKey !== key) ||
      (record?.verse_key && record.verse_key !== key) ||
      (keys?.length && !exact)) return null;
  const groupedExactly = Array.isArray(groups) && groups.length === 1 && groups[0] === key;
  return exact || groupedExactly ? record.text || null : null;
}

export function tafsirCoverage(record, key) {
  if (exactTafsir(record, key)) return [key];
  if (typeof record?.text !== 'string' || !record.text.trim()) return [];
  const keys = record.verses && typeof record.verses === 'object' ? Object.keys(record.verses) : [];
  const groupKeys = record.group_verses || record.groupVerseKeys;
  const verified = keys.includes(key) ? keys : Array.isArray(groupKeys) && groupKeys.includes(key) ? groupKeys : [];
  return [...new Set(verified.filter(value => /^\d{1,3}:\d{1,3}$/.test(value)))];
}

export async function tafsir(value, source) {
  const key = ayahKey(value);
  const sourceKey = typeof source === 'string' && Object.hasOwn(tafsirSourceIds, source) ? source : null;
  const sourceId = sourceKey ? tafsirSourceIds[sourceKey] : Number(source ?? 169);
  const option = (await tafsirOptions()).find(item => item.id === sourceId);
  if (!option) throw problem(400, 'Choose an available tafsir.');
  const record = (await quran(`/tafsirs/${option.id}/by_ayah/${key}?fields=verse_key,resource_name`)).tafsir;
  const coverage = tafsirCoverage(record, key);
  if (!coverage.length) throw problem(404, 'Commentary is unavailable for this ayah from the selected source.');
  const text = record.text;
  const canonicalSource = sourceKey || Object.keys(tafsirSourceIds).find(name => tafsirSourceIds[name] === option.id);
  return {
    name: record.resource_name || option.name,
    language: option.language,
    text,
    key,
    ayahKey: key,
    ...(coverage.length > 1 && { coverage }),
    ...(canonicalSource && { source: canonicalSource })
  };
}

export async function englishTafsir(key, preferred) {
  const sources = (await tafsirOptions()).filter(item => item.language === 'en');
  const selected = sources.find(item => String(item.id) === String(preferred)) || sources[0];
  if (!selected) throw problem(404, 'The Quran provider returned no English tafsir sources.');
  let selectedError;
  try { return await tafsir(key, selected.id); }
  catch (error) { selectedError = error; }

  try {
    return await Promise.any(sources.filter(item => item.id !== selected.id).map(async item => ({
      ...await tafsir(key, item.id), fallbackFrom: selected.name
    })));
  } catch (error) {
    if ([selectedError, ...(error.errors || [])].some(failure => failure.status !== 404)) {
      throw problem(502, 'English tafsir is temporarily unavailable. Please retry.');
    }
    throw problem(404, 'No English tafsir was provided for this ayah.');
  }
}
