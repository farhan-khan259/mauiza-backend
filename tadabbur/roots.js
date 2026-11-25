import { readFile } from 'node:fs/promises';

// Quranic Arabic Corpus morphology v0.4, Copyright 2011 Kais Dukes.
// The bundled source retains its full license.
const from = "'|>&<}AbptvjHxd*rzs$SDTZEg_fqklmnhwYyFNKaui~o`{";
const to = 'ءآأؤإئابةتثجحخدذرزسشصضطظعغـفقكلمنهوىيًٌٍَُِّْٰٱ';
const characters = new Map([...from].map((value, i) => [value, to[i]]));
const arabic = value => [...value].map(char => characters.get(char) ?? char).join('');
const normalize = value => value.normalize('NFC').replace(/[\s\u0640\u064b-\u0652\u0670]/g, '');
let index;

async function loadIndex() {
  const [source, dictionary] = await Promise.all([
    readFile(new URL('./quranic-corpus-morphology-0.4.txt', import.meta.url), 'utf8'),
    readFile(new URL('./lughat_all_four_volumes.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  const words = new Map(), occurrences = new Map(), definitions = new Map();
  for (const row of source.split('\n')) {
    const [location, form, pos, featureText] = row.trim().split('\t');
    const address = /^\((\d+:\d+:\d+):\d+\)$/.exec(location)?.[1];
    if (!address || !featureText) continue;
    const word = words.get(address) || { segments: [] };
    const features = featureText.split('|');
    const rootCode = features.find(value => value.startsWith('ROOT:'))?.slice(5);
    if (rootCode) {
      word.rootCode = rootCode;
      word.root = [...arabic(rootCode)].join(' ');
      if (!occurrences.has(rootCode)) occurrences.set(rootCode, new Set());
      occurrences.get(rootCode).add(address);
    }
    const lemma = features.find(value => value.startsWith('LEM:'))?.slice(4);
    if (lemma) word.lemma = arabic(lemma);
    word.segments.push({ form: arabic(form), pos, features });
    words.set(address, word);
  }
  for (const entry of dictionary.entries) {
    const roots = new Set([entry.root_ar, ...(entry.corpus_roots || [])].filter(value => typeof value === 'string' && value).map(normalize));
    for (const root of roots) {
      if (!definitions.has(root)) definitions.set(root, []);
      definitions.get(root).push(entry);
    }
  }
  return { words, occurrences, definitions };
}

function corpus() {
  index ??= loadIndex().catch(error => { index = undefined; throw error; });
  return index;
}

export async function verseRoots(key, words) {
  const { words: values, occurrences } = await corpus();
  return words.map(word => {
    const morphology = values.get(`${key}:${word.position}`);
    return {
      ...word,
      ...morphology,
      rootOccurrences: morphology?.rootCode ? occurrences.get(morphology.rootCode)?.size || 0 : 0
    };
  });
}

export async function wordStudy(address, page) {
  const { words, occurrences, definitions } = await corpus();
  const word = words.get(address);
  if (!word) return null;
  const references = [...(occurrences.get(word.rootCode) || [])];
  const entries = (word.root ? definitions.get(normalize(word.root)) || [] : [])
    .filter(entry => typeof entry.english === 'string' && entry.english.trim())
    .map(({ id, heading, english, volume, pdf_page, link }) => ({ id, heading, english, volume, pdfPage: pdf_page, match: link }));
  return { ...word, entries, count: references.length, references: references.slice((page - 1) * 30, page * 30) };
}

export async function rootReference(address, reference) {
  const { words } = await corpus();
  const word = words.get(address), occurrence = words.get(reference);
  if (!word?.rootCode || word.rootCode !== occurrence?.rootCode) return null;
  return { ...occurrence, address: reference, word: occurrence.segments.map(segment => segment.form).join('') };
}
