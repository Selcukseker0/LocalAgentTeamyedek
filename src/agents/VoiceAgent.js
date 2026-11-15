import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMING_SCRIPT = path.resolve(HERE, '../whiteboard/tts_timing.py');

function vttToSrt(vttContent) {
  const lines = vttContent.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('-->')) {
      const timeLine = lines[i].replace(/\./g, ',');
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }
      if (textLines.length > 0) {
        blocks.push(`${index++}\n${timeLine}\n${textLines.join('\n')}`);
      }
    }
  }
  return blocks.join('\n\n') + '\n';
}

export class VoiceAgent {
  /**
   * edge-tts ile seslendirir.
   *
   * Önce Python kütüphanesi üzerinden kelime zaman damgaları alınır
   * (altyazı ve sahne geçişleri gerçek zamana oturur). Bu yol çalışmazsa
   * eski CLI yoluna düşülür: ses üretilir, altyazı edge-tts'in kendi VTT'sinden gelir.
   */
  async synthesize(narration, workDir) {
    const audioPath = path.join(workDir, 'voice.mp3');
    const vttPath = path.join(workDir, 'subs.vtt');
    const srtPath = path.join(workDir, 'subs.srt');
    const wordsPath = path.join(workDir, 'words.json');
    const textPath = path.join(workDir, 'narration.txt');

    const cleanText = narration.replace(/\s+/g, ' ').trim();
    await fs.writeFile(textPath, cleanText, 'utf8');

    const timing = await this.synthesizeWithTimings(cleanText, { audioPath, wordsPath, srtPath });
    if (timing) return timing;

    // --- yedek yol: CLI (kelime zamanı yok) ---
    try {
      await execFileAsync(config.pythonBin, [
        '-m', 'edge_tts',
        '--voice', config.ttsVoice,
        '--rate=+20%',
        '--text', cleanText,
        '--write-media', audioPath,
        '--write-subtitles', vttPath
      ], { maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const detail = String(err?.stderr || err?.message || '').trim().slice(0, 300);
      throw new Error(
        `Seslendirme başarısız (${config.pythonBin} -m edge_tts): ${detail}\n` +
        'İnternet bağlantısı ve "python -m pip install edge-tts" kurulumunu kontrol edin.'
      );
    }

    const audioStat = await fs.stat(audioPath).catch(() => null);
    if (!audioStat || audioStat.size < 5000) {
      throw new Error(
        `Ses dosyası oluşmadı veya boş (${audioPath}). ` +
        'edge-tts çıktı vermediyse internet bağlantısını kontrol edin.'
      );
    }
    log('VoiceAgent', `Ses dosyası: ${(audioStat.size / 1024).toFixed(0)} KB (kelime zamanı yok)`);

    const vtt = await fs.readFile(vttPath, 'utf8');
    await fs.writeFile(srtPath, vttToSrt(vtt), 'utf8');
    log('VoiceAgent', `Ses ve altyazı üretildi: ${audioPath}`);

    return { audioPath, srtPath, wordsPath: null, cues: [] };
  }

  /** Python kütüphanesi ile kelime zaman damgalı seslendirme. */
  async synthesizeWithTimings(cleanText, { audioPath, wordsPath, srtPath }) {
    try {
      const { stdout } = await execFileAsync(config.pythonBin, [
        TIMING_SCRIPT,
        '--text-file', path.join(path.dirname(audioPath), 'narration.txt'),
        '--voice', config.ttsVoice,
        '--rate=+20%',
        '--media', audioPath,
        '--words', wordsPath,
        '--srt', srtPath
      ], { maxBuffer: 16 * 1024 * 1024 });
      const info = JSON.parse(String(stdout).trim().split('\n').at(-1) || '{}');
      if (!info.ok) throw new Error(info.error || 'bilinmeyen hata');

      const audioStat = await fs.stat(audioPath).catch(() => null);
      if (!audioStat || audioStat.size < 5000) {
        throw new Error('ses dosyası boş');
      }

      const payload = JSON.parse(await fs.readFile(wordsPath, 'utf8'));
      log(
        'VoiceAgent',
        `Ses: ${(audioStat.size / 1024).toFixed(0)} KB, ${info.words} kelime zamanı, ` +
        `${info.cues} altyazı parçası.`
      );

      return {
        audioPath,
        srtPath,
        wordsPath,
        cues: payload.cues || [],
        words: payload.words || []
      };
    } catch (err) {
      log(
        'VoiceAgent',
        `Kelime zamanlaması alınamadı (${String(err?.message || err).slice(0, 160)}); ` +
        'CLI yedeğine geçiliyor.',
        'WARN'
      );
      return null;
    }
  }
}
