import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findAbstractWords,
  checkGrounding,
  validateScript,
  dedupeScenes,
  sanitizeScenes,
  checkSentence,
  deriveLabel,
  normalizeScenes
} from '../src/agents/ScriptAgent.js';
import { buildTimelineFromWords, splitSentences } from '../src/agents/WhiteboardVideoAgent.js';
import { cleanText, similarity } from '../src/utils/text.js';

const sentence = 'Mısır mezarlarında 3000 yıllık bal küpleri bulundu.';
const facts = [sentence];

function scenes(count = 12, text = sentence, objects = ['bal küpü', 'mezar']) {
  return Array.from({ length: count }, (_, i) => ({
    narration: text.replace('3000', String(3000 + i)),
    visualObjects: objects
  }));
}

test('soyut kelimeler çekim ekleriyle de yakalanır', () => {
  assert.deepEqual(findAbstractWords('Bu gizemli bir hikaye'), ['gizemli']);
  assert.deepEqual(findAbstractWords('ilginçti ve şaşırtıcıydı'), ['ilginçti', 'şaşırtıcıydı']);
  assert.deepEqual(findAbstractWords('bal hızla bozulur'), []);
});

test('validateScript soyut kelimeyi hata sayar', () => {
  const list = scenes(12);
  list[3] = { narration: 'Bu gerçekten gizemli bir kavanoz hikayesi.', visualObjects: ['kavanoz'] };
  const result = validateScript(list, { facts });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /soyut kelime/);
});

test('validateScript kaynakta olmayan sayıyı yakalar', () => {
  const list = Array.from({ length: 12 }, () => ({
    narration: 'Mısır mezarlarında 5000 yıllık bal küpleri bulundu.',
    visualObjects: ['bal küpü', 'mezar']
  }));
  // tekrar hatası da çıkar; kaynak kontrolüne bakıyoruz
  const result = validateScript(list, { facts });
  assert.match(result.problems.join(' '), /kaynakta olmayan sayı/);
});

test('checkGrounding kaynak yoksa sessiz kalır', () => {
  const result = checkGrounding(scenes(3), []);
  assert.deepEqual(result.problems, []);
});

test('çizilebilir nesne eksikse uyarı verilir, hata değil', () => {
  const list = scenes(12).map((scene) => ({ ...scene, visualObjects: [] }));
  const result = validateScript(list, { facts });
  assert.equal(result.ok, result.problems.length === 0);
  assert.match(result.warnings.join(' '), /çizilebilir nesne yok/);
});

test('aynı cümle tekrarı senaryoyu bozar', () => {
  const list = Array.from({ length: 12 }, () => ({ narration: sentence, visualObjects: ['bal'] }));
  const result = validateScript(list, { facts });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /tekrar/);
});

test('checkSentence etiketi ve yarım cümleyi reddeder', () => {
  assert.equal(checkSentence('Kanca cümlesi: bal bozulmaz.').ok, false);
  assert.equal(checkSentence('Bal hava almadığı için bozulmaz ve').ok, false);
  assert.equal(checkSentence(sentence).ok, true);
});

test('normalizeScenes visual_objects ve image_prompt alanlarını okur', () => {
  const [scene] = normalizeScenes({
    scenes: [{
      narration: sentence,
      visual_objects: ['bal küpü', 'mezar'],
      image_prompt: 'mezarda duran bal küpü',
      title: '3000 YIL'
    }]
  });
  assert.deepEqual(scene.visualObjects, ['bal küpü', 'mezar']);
  assert.equal(scene.imagePrompt, 'mezarda duran bal küpü');
  assert.equal(scene.titleHint, '3000 YIL');
});

test('dedupeScenes kelime örtüşmesine göre eler', () => {
  const list = [
    { narration: 'Bal hava almadığı için binlerce yıl bozulmadan kaldı.' },
    { narration: 'Bal hava almadığı için binlerce yıl bozulmadan kalır.' },
    { narration: 'Arılar petek gözlerine bal doldurur.' }
  ];
  assert.equal(dedupeScenes(list).length, 2);
});

test('sanitizeScenes bozuk cümleleri atar', () => {
  const kept = sanitizeScenes([
    { narration: '3): kanca cümlesi burada duruyor.' },
    { narration: sentence }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].narration, sentence);
});

test('buildTimelineFromWords kelime zamanlarından sahne süresi çıkarır', () => {
  const words = 'Bal hava almadığı için bozulmaz.'.split(' ').map((word, i) => ({
    word,
    start: i * 0.4,
    end: i * 0.4 + 0.35
  }));
  const timeline = buildTimelineFromWords([words.map((w) => w.word).join(' ')], words, 2.4);
  assert.equal(timeline.length, 1);
  assert.ok(timeline[0].duration > 0);
});

test('splitSentences kısaltmaları bölmez', () => {
  assert.equal(splitSentences('Bal, süt vb. gıdalar bozulur.').length, 1);
});

test('deriveLabel sayıyı ve konu kelimesini etiket yapar', () => {
  assert.equal(deriveLabel(sentence, 'bal'), '3000 YIL');
  assert.equal(deriveLabel('Kavanoz taştan yapılmıştı.', 'kavanoz'), 'KAVANOZ');
});

test('cleanText ve similarity temel davranış', () => {
  assert.equal(cleanText('  çok   fazla   boşluk  '), 'çok fazla boşluk');
  assert.equal(similarity('bal küpü mezar', 'bal küpü mezar'), 1);
  assert.equal(similarity('bal küpü', 'roket uzay'), 0);
});
