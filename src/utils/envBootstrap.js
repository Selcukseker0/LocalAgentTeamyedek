/**
 * Giriş betiklerinin İLK import'u: `.env`'i diğer modüller `process.env`'i
 * okumadan önce yükler (ve temizler).
 *
 * ESM'de import'lar sırayla değerlendirilir; bu dosya ilk sıradaysa
 * ScriptAgent/provider gibi modüllerin modül-seviyesi sabitleri temiz değerleri
 * görür. Aksi hâlde `GROUNDING_MIN_NUMBER` gibi sabitler .env yüklenmeden
 * hesaplanıyordu.
 */

import { loadEnvFile } from './envLoad.js';

// Sessiz: giriş betikleri (doctor, auto-video) raporu kendileri yazar.
loadEnvFile({ quiet: true });
