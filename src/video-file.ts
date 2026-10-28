import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function inspectVideo(file: string, ffmpegPath: string, signal?: AbortSignal) {
  let details: string;
  try {
    const result = await execFileAsync(ffmpegPath, [
      '-hide_banner', '-nostdin', '-i', file, '-frames:v', '1', '-f', 'null', '-',
    ], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    details = result.stderr;
  } catch (error) {
    throw new Error(`File tải về không phải video hợp lệ: ${error instanceof Error ? error.message : String(error)}`);
  }

  const video = details.split(/\r?\n/).find(line => /Stream #\d+:\d+.*Video:/.test(line));
  if (!video) throw new Error('File tải về không có luồng video');
  const audio = details.split(/\r?\n/).find(line => /Stream #\d+:\d+.*Audio:/.test(line));
  return {
    compatible: /Input #0, (?:mov|mp4|m4a|3gp)/.test(details)
      && /Video: h264\b/.test(video)
      && /\byuv420p\b/.test(video)
      && (!audio || /Audio: aac\b/.test(audio)),
  };
}

export async function playableMp4(source: string, output: string, ffmpegPath: string, signal?: AbortSignal): Promise<string> {
  const input = await inspectVideo(source, ffmpegPath, signal);
  if (input.compatible) return source;

  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source,
    '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart',
    '-y', output,
  ], { signal, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });

  if (!(await inspectVideo(output, ffmpegPath, signal)).compatible) {
    throw new Error('Không thể tạo file MP4 H.264/AAC có thể phát');
  }
  return output;
}
