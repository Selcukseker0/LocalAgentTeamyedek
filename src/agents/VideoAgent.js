import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';

const execFileAsync = promisify(execFile);

const SCALE_FILTER =
  'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30';
const TRANSITION_DURATION = 0.35;

function toAssTime(value) {
  const match = value.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) throw new Error(`Geçersiz altyazı zaman kodu: ${value}`);
  return `${Number(match[1])}:${match[2]}:${match[3]}.${Math.floor(Number(match[4]) / 10)
    .toString().padStart(2, '0')}`;
}

function srtToAnimatedAss(srt) {
  const events = srt.trim().split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex < 0) return [];

    const [start, end] = lines[timeLineIndex].split(/\s+-->\s+/);
    const text = lines.slice(timeLineIndex + 1)
      .join('\\N')
      .replace(/[{}]/g, '\\$&')
      .trim();
    if (!start || !end || !text) return [];

    return [
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Short,,0,0,0,,{\\fad(100,120)\\fscx86\\fscy86\\t(0,140,\\fscx100\\fscy100)}${text}`
    ];
  });

  if (events.length === 0) throw new Error('SRT içinde gösterilebilir altyazı bulunamadı.');

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Short,Arial,76,&H00FFFFFF,&H0000D7FF,&H00101010,&H96000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,360,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    ''
  ].join('\n');
}

export class VideoAgent {
  async getAudioDuration(audioPath) {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', audioPath
    ]);
    return parseFloat(JSON.parse(stdout).format.duration);
  }

  // Pixabay'den bir sorgu için video indirir. Dikey olanı tercih eder.
  async downloadPixabayClip(query, outPath) {
    const url =
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(config.pixabayApiKey)}` +
      `&q=${encodeURIComponent(query)}&per_page=10&safesearch=true`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pixabay API hatası (${res.status})`);

    const data = await res.json();
    const hits = data.hits || [];

    let chosen = null;
    for (const hit of hits) {
      for (const size of ['large', 'medium', 'small']) {
        const v = hit.videos?.[size];
        if (v?.url && v.height > v.width) {
          chosen = v.url;
          break;
        }
      }
      if (chosen) break;
    }

    if (!chosen) {
      chosen = hits[0]?.videos?.large?.url || hits[0]?.videos?.medium?.url || null;
    }
    if (!chosen) return false;

    const clipRes = await fetch(chosen);
    if (!clipRes.ok) return false;
    await fs.writeFile(outPath, Buffer.from(await clipRes.arrayBuffer()));
    return true;
  }

  async collectRawClips(queries, workDir) {
    const clips = [];
    if (!config.pixabayApiKey) {
      log('VideoAgent', 'PIXABAY_API_KEY tanımlı değil, yedek arka plan kullanılacak.', 'WARN');
      return clips;
    }

    for (let i = 0; i < queries.length; i++) {
      const outPath = path.join(workDir, `raw_${i}.mp4`);
      try {
        const ok = await this.downloadPixabayClip(queries[i], outPath);
        if (ok) clips.push(outPath);
        else log('VideoAgent', `Pixabay'de "${queries[i]}" için video bulunamadı.`, 'WARN');
      } catch (err) {
        log('VideoAgent', `Pixabay hatası ("${queries[i]}"): ${err.message}`, 'WARN');
      }
    }
    return clips;
  }

  // Stok video yoksa FFmpeg ile hareketli arka plan üretir.
  async generateFallbackBackground(duration, outPath) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x3a4f8a:s=1080x1920:r=30:d=${duration.toFixed(2)}`,
      '-vf', "hue=h=t*25,noise=alls=12:allf=t,zoompan=z='min(zoom+0.0003,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30",
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      outPath
    ]);
  }

  async renderShorts({ audioPath, srtPath, visualQueries, workDir }) {
    const duration = await this.getAudioDuration(audioPath);
    const rawClips = await this.collectRawClips(visualQueries, workDir);
    const normalized = [];

    if (rawClips.length === 0) {
      const bgPath = path.join(workDir, 'norm_0.mp4');
      await this.generateFallbackBackground(duration, bgPath);
      normalized.push(bgPath);
      log('VideoAgent', 'Yedek arka plan ile video oluşturuluyor.', 'WARN');
    } else {
      const segDuration =
        (duration + TRANSITION_DURATION * (rawClips.length - 1)) / rawClips.length;
      for (let i = 0; i < rawClips.length; i++) {
        const normPath = path.join(workDir, `norm_${i}.mp4`);
        const zoom = i % 2 === 0
          ? "min(zoom+0.00045,1.08)"
          : "if(eq(on,1),1.08,max(zoom-0.00045,1.0))";
        await execFileAsync('ffmpeg', [
          '-y',
          '-stream_loop', '-1',
          '-i', rawClips[i],
          '-t', segDuration.toFixed(2),
          '-vf', `${SCALE_FILTER},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`,
          '-an',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
          normPath
        ]);
        normalized.push(normPath);
      }
    }

    const segmentDuration =
      (duration + TRANSITION_DURATION * (normalized.length - 1)) / normalized.length;
    const transitionFilters = [];
    transitionFilters.push('[0:v]settb=AVTB,setpts=PTS-STARTPTS[clip0]');
    for (let i = 1; i < normalized.length; i++) {
      transitionFilters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[clip${i}]`);
      const offset = i * (segmentDuration - TRANSITION_DURATION);
      transitionFilters.push(
        `[${i === 1 ? 'clip0' : `transition${i - 1}`}][clip${i}]` +
      `xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${offset.toFixed(3)}` +
        `[transition${i}]`
      );
    }

    const mergedLabel = normalized.length === 1
      ? 'clip0'
      : `transition${normalized.length - 1}`;
    await execFileAsync('ffmpeg', [
      '-y',
      ...normalized.flatMap((clip) => ['-i', path.basename(clip)]),
      '-filter_complex', transitionFilters.join(';'),
      '-map', `[${mergedLabel}]`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      'merged.mp4'
    ], { cwd: workDir });

    const finalPath = path.join(workDir, 'final_shorts.mp4');
    const assPath = path.join(workDir, 'subs_animated.ass');
    const srtContent = await fs.readFile(srtPath, 'utf8');
    await fs.writeFile(assPath, srtToAnimatedAss(srtContent), 'utf8');

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', 'merged.mp4',
      '-i', path.basename(audioPath),
      '-vf', `ass=${path.basename(assPath)}`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      path.basename(finalPath)
    ], { cwd: workDir });

    log('VideoAgent', `Shorts hazır: ${finalPath} (${duration.toFixed(1)}s)`);
    return { videoPath: finalPath, duration };
  }
}