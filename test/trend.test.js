import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrendAgent } from '../src/agents/TrendAgent.js';

const trend = new TrendAgent();

test('somut ve soru biçimli başlık yüksek puan alır', () => {
  assert.ok(trend.scoreTopic('Bal neden bozulmaz?') >= 6);
  assert.ok(trend.scoreTopic("Mısır'da 3000 yıllık bal bulundu") >= 6);
});

test('soyut / magazin başlık reddedilir', () => {
  assert.ok(trend.scoreTopic('Sakızlı balıkların gizemli hayatı') < 2);
  assert.ok(trend.scoreTopic('Ünlü yıldızın skandal aşk iddiası') < 2);
});

test('çok uzun başlık ceza alır', () => {
  const long = 'Bu başlık gerçekten çok uzun ve tek bir konuya odaklanmıyor çünkü her şeyi anlatmaya çalışıyor '
    + 've sonunda hiçbir şey anlatmıyor';
  assert.ok(trend.scoreTopic(long) < trend.scoreTopic('Buz neden kaygandır?'));
});

test('boş başlık en düşük puanı alır', () => {
  assert.ok(trend.scoreTopic('') <= -4);
});
