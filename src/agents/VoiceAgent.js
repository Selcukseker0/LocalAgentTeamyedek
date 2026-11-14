import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

const execFileAsync = promisify(execFile);

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
  async synthesize(narration, workDir) {
    const audioPath = path.join(workDir, 'voice.mp3');
    const vttPath = path.join(workDir, 'subs.vtt');
    const srtPath = path.join(workDir, 'subs.srt');

    const cleanText = narration.replace(/\s+/g, ' ').trim();

    // edge-tts komutu yerine "python -m edge_tts" kullanılır (PATH sorununu önler)
    await execFileAsync(config.pythonBin, [
      '-m', 'edge_tts',
      '--voice', config.ttsVoice,
      '--rate=+20%',
      '--text', cleanText,
      '--write-media', audioPath,
      '--write-subtitles', vttPath
    ]);

    const vtt = await fs.readFile(vttPath, 'utf8');
    await fs.writeFile(srtPath, vttToSrt(vtt), 'utf8');

    log('VoiceAgent', `Ses ve altyazı üretildi: ${audioPath}`);
    return { audioPath, srtPath };
  }
}