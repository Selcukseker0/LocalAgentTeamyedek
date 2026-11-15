import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { log } from '../logger.js';
import { probeMedia, resolveBinaries } from '../utils/ffmpeg.js';

const execFileAsync = promisify(execFile);

export class QualityAgent {
  async inspect(videoPath, srtPath, expectedAudioDuration) {
    const errors = [];

    // 1. Dosya boyutu ve altyazı kontrolü
    const stat = await fs.stat(videoPath).catch(() => null);
    if (!stat || stat.size < 500_000) {
      errors.push('Video dosyası yok veya çok küçük.');
    }

    const srtContent = await fs.readFile(srtPath, 'utf8').catch(() => '');
    if (srtContent.trim().length < 20 || !srtContent.includes('-->')) {
      errors.push('Altyazı (SRT) dosyası boş veya bozuk.');
    }
    // Altyazı parça sayısı cümle sayısıyla uyumlu mu?
    const cueCount = (srtContent.match(/-->/g) || []).length;
    if (cueCount && cueCount < 6) {
      log('QualityAgent', `Altyazı parçası az: ${cueCount} (cümle sayısı beklenirdi)`, 'WARN');
    }

    // 2. Çözünürlük, ses akışı, süre ve ses-görüntü senkron kontrolü
    const info = await probeMedia(videoPath);
    const vStream = info.streams?.find(s => s.codec_type === 'video');
    const aStream = info.streams?.find(s => s.codec_type === 'audio');
    const vDuration = parseFloat(vStream?.duration || info.format?.duration || '0');
    const aDuration = parseFloat(aStream?.duration || '0');

    if (!vStream || vStream.width !== 1080 || vStream.height !== 1920) {
      errors.push(`Çözünürlük 1080x1920 değil (${vStream?.width}x${vStream?.height}).`);
    }
    if (!aStream) {
      errors.push('Videoda ses kanalı yok.');
    }
    // Hedef 30-45 sn (87-128 kelime). 25 sn altı/55 sn üstü kabul edilmez.
    if (vDuration < 25 || vDuration > 55) {
      errors.push(`Süre hedefin dışında: ${vDuration.toFixed(1)}s (hedef 30-45s, kabul 25-55s)`);
    } else if (vDuration < 28 || vDuration > 48) {
      log('QualityAgent', `Süre hedefin biraz dışında: ${vDuration.toFixed(1)}s (hedef 30-45s)`, 'WARN');
    }
    if (Math.abs(vDuration - expectedAudioDuration) > 1.5 || Math.abs(vDuration - aDuration) > 1.5) {
      errors.push(`Ses-görüntü senkron farkı çok yüksek (Video: ${vDuration.toFixed(1)}s, Ses: ${aDuration.toFixed(1)}s).`);
    }

    const { ffmpeg } = await resolveBinaries();

    // 3. Siyah ekran kontrolü
    const { stderr: blackErr } = await execFileAsync(ffmpeg, [
      '-i', videoPath, '-vf', 'blackdetect=d=1.5:pix_th=0.10', '-an', '-f', 'null', '-'
    ]).catch(err => ({ stderr: err.stderr || '' }));

    if (blackErr.includes('black_duration')) {
      errors.push('1.5 saniyeden uzun siyah ekran tespit edildi.');
    }

    // 4. Sessiz ses kontrolü (mean_volume -60dB altındaysa ses boştur)
    const { stderr: volErr } = await execFileAsync(ffmpeg, [
      '-i', videoPath, '-af', 'volumedetect', '-vn', '-f', 'null', '-'
    ]).catch(err => ({ stderr: err.stderr || '' }));

    const volMatch = volErr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (volMatch && parseFloat(volMatch[1]) < -55) {
      errors.push(`Ses seviyesi aşırı düşük veya sessiz (${volMatch[1]} dB).`);
    }

    const passed = errors.length === 0;
    log('QualityAgent', passed ? 'Tüm kalite kontrolleri GEÇTİ.' : `Kalite HATALARI: ${errors.join(' | ')}`, passed ? 'INFO' : 'WARN');
    return { passed, errors, duration: vDuration };
  }
}