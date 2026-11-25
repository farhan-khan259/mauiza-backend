import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./asbab_all.json', import.meta.url), 'utf8'));
const bySurah = new Map();
for (const entry of data.entries) {
  if (!bySurah.has(entry.surah)) bySurah.set(entry.surah, []);
  bySurah.get(entry.surah).push(entry);
}

export function ayahContext(key) {
  const [surah, ayah] = key.split(':').map(Number);
  return (bySurah.get(surah) || []).filter(entry => entry.from <= ayah && ayah <= entry.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from));
}
