import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchQuery,
  pickBestArticle,
  relevanceScore,
  stemTr,
  topicKeywords
} from '../src/agents/ResearchAgent.js';

// Gerçek olay: "Buzun sırrı ne?" konusu Wikipedia'da "Mehmed Selim Sırrı Paşa"
// maddesine gidiyordu; senaryo bambaşka bir konuda yazılıyordu.
test('soru kelimeleri arama sorgusundan temizlenir', () => {
  assert.equal(buildSearchQuery('Buzun sırrı ne?'), 'buz');
  assert.deepEqual(topicKeywords('Buzun sırrı ne?'), ['buz']);
  assert.ok(buildSearchQuery('Mısır piramitleri nasıl yapıldı?').startsWith('mısır'));
});

test('Türkçe çekim ekleri gövdeye indirilir', () => {
  assert.equal(stemTr('buzun'), 'buz');
  assert.equal(stemTr('suyun'), 'su');
  assert.equal(stemTr('kediler'), 'kedi');
  assert.equal(stemTr('ağırdır'), 'ağır');
});

test('konuyla ilgisiz madde seçilmez (kelime tesadüfü)', () => {
  const wrong = [{ title: 'Mehmed Selim Sırrı Paşa', snippet: 'Sırrı Paşa Osmanlı devlet adamıdır.' }];
  assert.equal(pickBestArticle('Buzun sırrı ne?', wrong), null);
});

test('doğru madde seçilir', () => {
  const candidates = [
    { title: 'Buzul', snippet: 'Buzullar binlerce yılda oluşur.' },
    { title: 'Buz', snippet: 'Su 0 derecenin altında donarak buzu oluşturur.' }
  ];
  assert.equal(pickBestArticle('Buzun sırrı ne?', candidates)?.title, 'Buz');
  assert.equal(
    pickBestArticle('Bal neden bozulmaz?', [{ title: 'Balık', snippet: 'Suda yaşayan hayvan.' }]),
    null,
    'bal ≠ balık'
  );
  assert.equal(
    pickBestArticle('Bal neden bozulmaz?', [{ title: 'Bal', snippet: 'Arıların ürettiği tatlı madde.' }])?.title,
    'Bal'
  );
});

test('alaka puanı 0-1 arasında ve örtüşmeyle artar', () => {
  const relevant = relevanceScore('Buzun sırrı ne?', 'Su donduğunda buz oluşur.');
  const irrelevant = relevanceScore('Buzun sırrı ne?', 'Osmanlı devlet adamı paşa.');
  assert.ok(relevant > irrelevant);
  assert.ok(relevant <= 1 && irrelevant >= 0);
});
