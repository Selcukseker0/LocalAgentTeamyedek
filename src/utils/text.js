/** Ortak metin yardımcıları (ajanlar arasında tekrar etmesin). */

export function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/…{2,}/g, '…')
    .replace(/\.{3,}/g, '…')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/\s+([.,!?…])/g, '$1')
    .trim();
}

export function countWords(text) {
  return text ? String(text).split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Metni cümlelere böler.
 * Türkçe kısaltmalar (vb., vs., Dr., Prof.) cümle sonu sayılmaz.
 */
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const protectedText = clean.replace(/\b(vb|vs|Dr|Prof|No|ör)\./gi, (m) => m.replace('.', '\u0001'));
  return protectedText
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.replace(/\u0001/g, '.').trim())
    .filter(Boolean);
}

export function normalizeTr(text) {
  return String(text || '').toLocaleLowerCase('tr');
}

export function tokenSet(text) {
  return new Set(
    String(text || '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
  );
}

/** İki metnin kelime örtüşmesi (Jaccard). 0-1 arası. */
export function similarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let common = 0;
  for (const token of setA) if (setB.has(token)) common += 1;
  return common / new Set([...setA, ...setB]).size;
}
