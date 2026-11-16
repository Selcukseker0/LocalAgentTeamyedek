/**
 * Sağlayıcının gerçek model listesini yazar.
 *
 *   npm.cmd run models            # .env'deki LLM_PROVIDER için
 *   npm.cmd run models -- groq    # belirli bir sağlayıcı için
 *
 * Model adları sık değişiyor (Groq'ta `llama-3.3-70b-versatile` kaldırıldı ve
 * 404 döndü). Tahmin etmek yerine listeyi görmek en hızlı yol.
 */

import '../utils/envBootstrap.js';
import { CUSTOM_PRESETS, activeProvider, listProviderModels, pickModel } from '../llm/provider.js';

const provider = (process.argv[2] || activeProvider()).toLowerCase();

if (provider === 'ollama') {
  console.log('Ollama için: ollama list');
  process.exit(0);
}

if (!CUSTOM_PRESETS[provider] && !process.env.LLM_API_URL) {
  console.log(`ℹ️  ${provider} OpenAI uyumlu değil. Desteklenen: ${Object.keys(CUSTOM_PRESETS).join(', ')} + custom`);
  process.exit(1);
}

try {
  const models = await listProviderModels(provider);
  const best = pickModel(models);
  console.log(`\n${provider} — ${models.length} model (${process.env.LLM_API_URL || CUSTOM_PRESETS[provider]})\n`);
  for (const id of models) {
    console.log(`${id === best ? '→' : ' '} ${id}`);
  }
  if (best) {
    console.log(`\nÖnerilen: LLM_MODEL=${best}`);
    console.log('  (ya da LLM_MODEL satırını boş bırakın — kod her çalıştırmada listeyi okuyup seçer)');
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  console.error('   LLM_API_KEY doğru mu? Anahtarın sonunda boşluk/nokta olmasın.');
  process.exit(1);
}
