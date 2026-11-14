import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

let cachedBinaries = null;

async function commandExists(bin) {
  try {
    await execFileAsync(bin, ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function resolvePython() {
  const candidates = [process.env.PYTHON_BIN || config.pythonBin, 'python3', 'python'].filter(Boolean);
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version']);
      return bin;
    } catch {
      // sıradaki aday
    }
  }
  return null;
}

/**
 * ffmpeg/ffprobe yollarını bulur.
 * Sıra: FFMPEG_PATH/FFPROBE_PATH -> PATH -> python imageio-ffmpeg paketi.
 * imageio-ffmpeg kuruluysa sistemde ffmpeg olmasa da video üretilebilir.
 */
export async function resolveBinaries() {
  if (cachedBinaries) return cachedBinaries;

  let ffmpeg = null;
  let ffprobe = null;

  const envFfmpeg = process.env.FFMPEG_PATH;
  if (envFfmpeg && (await commandExists(envFfmpeg))) ffmpeg = envFfmpeg;

  if (!ffmpeg && (await commandExists('ffmpeg'))) ffmpeg = 'ffmpeg';
  if (await commandExists('ffprobe')) ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

  if (!ffmpeg) {
    const python = await resolvePython();
    if (python) {
      try {
        const { stdout } = await execFileAsync(python, [
          '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'
        ]);
        const bin = stdout.trim();
        if (bin && (await commandExists(bin))) ffmpeg = bin;
      } catch {
        // imageio-ffmpeg yok
      }
    }
  }

  if (!ffmpeg) {
    throw new Error(
      'ffmpeg bulunamadı. `pip install imageio-ffmpeg` ile kurun ' +
      'ya da FFMPEG_PATH ortam değişkenini ayarlayın.'
    );
  }

  cachedBinaries = { ffmpeg, ffprobe, python: await resolvePython() };
  return cachedBinaries;
}

/** ffprobe yoksa `ffmpeg -i` çıktısından medya bilgisini çıkarır. */
function parseFfmpegInfo(stderr) {
  const text = String(stderr || '');
  const durationMatch = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  const duration = durationMatch
    ? +durationMatch[1] * 3600 + +durationMatch[2] * 60 + +durationMatch[3] + +durationMatch[4] / 100
    : 0;

  const streams = [];
  const videoMatch = text.match(/Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})/);
  if (videoMatch) {
    streams.push({
      codec_type: 'video',
      width: Number(videoMatch[1]),
      height: Number(videoMatch[2]),
      duration: String(duration)
    });
  }
  if (/Stream #\d+:\d+.*?Audio:/.test(text)) {
    streams.push({ codec_type: 'audio', duration: String(duration) });
  }
  return { format: { duration: String(duration) }, streams };
}

/** Medya bilgisini döndürür: {format, streams} (ffprobe JSON şemasına yakın). */
export async function probeMedia(filePath) {
  const { ffprobe, ffmpeg } = await resolveBinaries();

  if (ffprobe) {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ]);
    return JSON.parse(stdout);
  }

  const { stderr } = await execFileAsync(ffmpeg, ['-i', filePath]).catch((err) => ({
    stderr: err.stderr || ''
  }));
  return parseFfmpegInfo(stderr);
}

export async function getAudioDuration(audioPath) {
  try {
    const info = await probeMedia(audioPath);
    const duration = parseFloat(info?.format?.duration);
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {
    // sessizce yut; çağıran taraf yedek davranış uygular
  }
  return 0;
}
