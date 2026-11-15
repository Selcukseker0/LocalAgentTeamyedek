import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalNumber,
  checkGrounding,
  checkSentence,
  sanitizeScenes,
  splitLongSentence
} from '../src/agents/ScriptAgent.js';

// qwen2.5:7b 17-38 kelimelik cümleler yazıyor; eskiden hepsi "çok uzun" diye
// atılıyordu ve senaryo 20 dakika sonra hata veriyordu.
test('uzun cümle atılmaz, anlamlı sınırlardan bölünür', () => {
  const long = 'Buz su molekülleri donduğunda altıgen kristal bir yapı oluşur ve bu yapı sayesinde '
    + 'buz suyun üzerinde yüzer, çünkü yoğunluğu sıvı sudan azdır.';
  assert.ok(long.split(/\s+/).length > 16);

  const pieces = splitLongSentence(long);
  assert.ok(pieces.length >= 2, 'en az iki parça');
  for (const piece of pieces) {
    const verdict = checkSentence(piece);
    assert.ok(verdict.ok, `parça geçerli olmalı: ${piece} (${verdict.reason})`);
    assert.ok(piece.split(/\s+/).length <= 16);
  }
  // bağlaç/virgül korunur: kelimeler bitişik yazılmaz
  assert.ok(pieces.every((piece) => !/\w,\s*$/.test(piece)));
});

test('kısa cümle atılmaz, öncekine eklenir', () => {
  const kept = sanitizeScenes([
    { narration: 'Buz suyun üzerinde yüzer.' },
    { narration: 'Çok soğuk.' }
  ]);
  assert.equal(kept.length, 1);
  assert.match(kept[0].narration, /, çok soğuk\.$/);
});

test('sayı biçimleri aynı sayıya indirgenir', () => {
  assert.equal(canonicalNumber('3.000'), '3000');
  assert.equal(canonicalNumber('3 000'), '3000');
  assert.equal(canonicalNumber('3000'), '3000');
  assert.equal(canonicalNumber('2,5'), '2.5');
});

test('küçük sayılar serbest, büyük sayılar kaynağa bağlı', () => {
  const facts = ['Mısır da 3000 yıllık bal küpleri bulundu.'];

  // 0-99 arası sayılar denetlenmez (gerçek hayatta serbest)
  assert.equal(checkGrounding([{ narration: 'Bal 0 derecenin altında donmaz.' }], facts).problems.length, 0);
  assert.equal(checkGrounding([{ narration: 'Balın içinde yüzde 17 su vardır.' }], facts).problems.length, 0);

  // 3000 kaynakta var, "3.000" yazımı da eşleşir
  assert.equal(checkGrounding([{ narration: 'Bal 3.000 yıl sonra bile yenilebilir.' }], facts).problems.length, 0);

  // kaynakta olmayan yıl yakalanır
  const bad = checkGrounding([
    { narration: 'Mısır da 3000 yıllık bal bulundu.' },
    { narration: 'Bal 1851 yılında keşfedildi.' }
  ], facts);
  assert.ok(bad.problems.length || bad.warnings.length, '1851 kaynakta yok');
});
