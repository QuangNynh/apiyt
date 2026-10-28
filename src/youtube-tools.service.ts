import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import Ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { create as createYoutubeDl } from 'youtube-dl-exec';
import { youtubeVideoId } from './youtube-download-policy';
import { playableMp4 } from './video-file';
import { youtubeVideoDate } from './youtube-video-date';

const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
Ffmpeg.setFfmpegPath(ffmpegPath);

const ytdlBinary = process.env.YTDLP_PATH || (fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : undefined);
const youtubeDlExec = ytdlBinary ? createYoutubeDl(ytdlBinary) : require('youtube-dl-exec').exec;

const loadYoutube = new Function('return import("youtubei.js")') as () => Promise<any>;
const loadTranscript = new Function('return import("youtube-transcript-plus")') as () => Promise<any>;
const fetchTranscript = async (id: string, options: any) => (await loadTranscript()).fetchTranscript(id, options);

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    try { return await task(); }
    finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  };
}

export interface MediaFile {
  file: string;
  title: string;
  extension: string;
}

export class YouTubeToolsService {
  private youtube: any;
  private initialization?: Promise<void>;

  private getCookieOption(): Record<string, string> {
    // 1. Nếu có biến môi trường YT_COOKIES dạng chuỗi base64 hoặc raw text
    if (process.env.YT_COOKIES && process.env.YT_COOKIES.trim()) {
      const targetPath = '/tmp/youtube_cookies.txt';
      try {
        let content = process.env.YT_COOKIES.trim();
        // Nếu là base64 thì giải mã
        if (!content.includes('\t') && !content.includes('# Netscape') && content.length > 50) {
          try { content = Buffer.from(content, 'base64').toString('utf8'); } catch { /* Ignore */ }
        }
        if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, 'utf8') !== content) {
          fs.writeFileSync(targetPath, content, { mode: 0o600 });
        }
        return { cookies: targetPath };
      } catch (e) {
        console.warn('[Cookies] Failed to write cookie from env:', e);
      }
    }

    // 2. Nếu có file cookies.txt ở đường dẫn chỉ định hoặc /app/cookies.txt
    const cookiePath = process.env.YT_COOKIES_PATH || (fs.existsSync('/app/cookies.txt') ? '/app/cookies.txt' : undefined);
    if (cookiePath && fs.existsSync(cookiePath)) {
      return { cookies: cookiePath };
    }
    return {};
  }

  private async ready() {
    if (!this.initialization) {
      this.initialization = loadYoutube().then(async ({ Innertube, Log }) => {
        if (Log?.setLevel) {
          Log.setLevel(Log.Level.ERROR);
        }
        this.youtube = await Innertube.create();
      }).catch(error => { this.initialization = undefined; throw error; });
    }
    await this.initialization;
  }

  private extractVideoId(value: string): string {
    return youtubeVideoId(value);
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildMetadata(info: any, videoId: string) {
    return {
      videoId,
      title: info.basic_info.title,
      description: info.basic_info.short_description,
      author: info.basic_info.author,
      channelId: info.basic_info.channel_id,
      thumbnails: info.basic_info.thumbnail,
      durationSeconds: info.basic_info.duration,
      viewCount: Number(info.basic_info.view_count || 0),
      likeCount: Number(info.basic_info.like_count || 0),
      isLive: info.basic_info.is_live,
      category: info.basic_info.category,
      keywords: info.basic_info.keywords,
    };
  }

  private async fetchTranscriptWithFallback(videoId: string, preferredLang = 'en') {
    const langs = [preferredLang, 'en', undefined];
    let usedLang = preferredLang;

    for (const lang of langs) {
      try {
        const transcript = await fetchTranscript(videoId, lang ? { lang } : {});
        usedLang = lang || 'auto';
        return { transcript, usedLang };
      } catch (err: any) {
        if (!err.message?.includes('transcript')) throw err;
      }
    }
    return { transcript: null, usedLang: null };
  }

  async getTranscript(videoId: string, preferredLang = 'en') {
    videoId = this.extractVideoId(videoId);
    const maxRetries = 3;
    let lastError: any;

    // 1. Luôn ưu tiên lấy phụ đề bằng youtube-transcript-plus trước
    // Phương thức này dùng endpoint timedtext của YouTube, không bị 403 chặn như Innertube getInfo()
    let transcriptData: { transcript: any; usedLang: string | null } = { transcript: null, usedLang: null };
    try {
      transcriptData = await this.fetchTranscriptWithFallback(videoId, preferredLang);
    } catch (err: any) {
      lastError = err;
    }

    // 2. Thử lấy metadata bằng youtubei (nếu bị 403 do IP Datacenter thì fallback về cơ bản)
    let metadata: any = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.ready();
        const info = await this.youtube.getInfo(videoId);
        metadata = this.buildMetadata(info, videoId);
        break;
      } catch (error: any) {
        lastError = error;
        // Nếu dính 403 Forbidden do YouTube chặn Innertube trên IP Datacenter
        if (error?.status === 403 || String(error?.message).includes('403')) {
          try {
            const basic = await this.youtube.getBasicInfo(videoId);
            metadata = this.buildMetadata(basic, videoId);
            break;
          } catch {
            // Dừng retry nếu bị chặn IP để không tốn thời gian
            break;
          }
        }
        if (attempt < maxRetries) await this.sleep(1000 * attempt);
      }
    }

    const hasTranscript = !!transcriptData.transcript;
    return {
      success: hasTranscript || !!metadata,
      videoId,
      transcript: transcriptData.transcript,
      transcriptLanguage: transcriptData.usedLang,
      metadata,
      error: !hasTranscript && !metadata ? (lastError?.message || 'Unknown error') : undefined,
      attempts: maxRetries,
    };
  }

  async getAll(videoId: string) {
    try {
      await this.ready();
      const info = await this.youtube.getInfo(videoId);
      return { metadata: this.buildMetadata(info, videoId) };
    } catch (error: any) {
      throw new Error(`Error fetching video info: ${error.message}`);
    }
  }

  private readonly transcriptLimit = pLimit(6);

  async getTranscripts(videoIds: string[], preferredLang = 'en') {
    const tasks = videoIds.map((videoId) =>
      this.transcriptLimit(async () => {
        try { return await this.getTranscript(videoId, preferredLang); }
        catch (error) {
          return { success: false, videoId, transcript: null, transcriptLanguage: null, metadata: null,
            error: error instanceof Error ? error.message : String(error), attempts: 0 };
        }
      }),
    );
    return Promise.all(tasks);
  }

  private sanitizeFilename(filename: string): string {
    return (
      filename
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
        .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
        .replace(/[^\x20-\x7E]/g, '')
        .trim()
        .substring(0, 200) || 'media'
    );
  }

  async getChannelVideos(url: string, concurrency = 6) {
    try {
      const ytDlOpts: any = {
        dumpSingleJson: true,
        flatPlaylist: true,
        ignoreConfig: true,
        noWarnings: true,
        socketTimeout: 30,
        retries: 3,
        extractorRetries: 1,
        sleepRequests: 0.75,
        ...this.getCookieOption(),
      };
      let result: any;
      try {
        result = await youtubeDlExec(url, ytDlOpts);
      } catch (err: any) {
        const errorMsg = String(err.stderr || err.message || '');
        console.error('[yt-dlp channel error]', errorMsg);
        throw new Error(errorMsg || err.message || 'Lỗi khi quét kênh bằng yt-dlp');
      }
      if (!result) throw new Error('No data returned from youtube-dl');

      const parsed = JSON.parse(result.stdout);
      const rawEntries: any[] = [];
      const visit = (entry: any) => {
        if (!entry || typeof entry !== 'object') return;
        if (Array.isArray(entry.entries)) entry.entries.forEach(visit);
        else if (entry.id) rawEntries.push(entry);
      };
      visit(parsed);

      const seen = new Set<string>();
      const entries = rawEntries.filter(entry => {
        if (!/^[\w-]{11}$/.test(entry.id) || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      }).map(entry => ({
        id: entry.id,
        title: entry.title ?? null,
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        description: entry.description ?? null,
        duration: entry.duration ?? null,
        view_count: entry.view_count ?? null,
        like_count: entry.like_count ?? null,
        channel_id: entry.channel_id ?? parsed.channel_id ?? null,
        channel: entry.channel ?? entry.uploader ?? parsed.channel ?? null,
        thumbnails: entry.thumbnails ?? null,
        keywords: entry.tags ?? [],
        is_live: entry.live_status === 'is_live',
        category: entry.categories?.[0] ?? null,
        ...youtubeVideoDate(entry),
      }));

      try { await this.ready(); } catch { /* Ignore */ }
      const enrich = async (entry: typeof entries[number]) => {
        try {
          const info = await this.youtube.getInfo(entry.id);
          const b = info.basic_info;
          const microformat = info.page?.[0]?.microformat;
          const published = microformat?.publish_date || microformat?.upload_date;
          const publishedText = info.primary_info?.published?.text || info.primary_info?.published?.toString();
          const candidates = [published, b.start_timestamp, publishedText];
          let createdAt: string | null = null;
          for (const candidate of candidates) {
            if (!(candidate instanceof Date) && (typeof candidate !== 'string' || !/\b\d{4}\b/.test(candidate))) continue;
            const date = new Date(candidate);
            if (Number.isFinite(date.getTime())) { createdAt = date.toISOString(); break; }
          }
          const dates = youtubeVideoDate({ updated_at: b.updated_at, modified_date: b.modified_date, modified_timestamp: b.modified_timestamp });
          return {
            ...entry,
            title: b.title ?? entry.title,
            description: b.short_description ?? entry.description,
            duration: b.duration ?? entry.duration,
            view_count: b.view_count == null ? entry.view_count : Number(b.view_count),
            like_count: b.like_count == null ? entry.like_count : Number(b.like_count),
            channel_id: b.channel_id ?? entry.channel_id,
            channel: b.author ?? entry.channel,
            thumbnails: b.thumbnail ?? entry.thumbnails,
            keywords: b.keywords ?? entry.keywords,
            is_live: b.is_live ?? entry.is_live,
            category: b.category ?? entry.category,
            created_at: createdAt ?? entry.created_at,
            updated_at: dates.updated_at ?? entry.updated_at,
          };
        } catch { return entry; }
      };

      const validVideos = [...entries];
      const missing = () => validVideos.map((video, index) => ({ video, index })).filter(({ video }) => !video.created_at && !video.updated_at);
      const width = Math.max(1, Math.min(6, Math.floor(concurrency) || 6));

      for (const [round, workers] of [width, Math.min(width, 3), 1].entries()) {
        const pending = round === 0 ? validVideos.map((video, index) => ({ video, index })) : missing();
        if (!pending.length) break;
        if (round) await this.sleep(round === 1 ? 1500 : 4000);
        const limit = pLimit(workers);
        for (let offset = 0; offset < pending.length; offset += 30) {
          await Promise.all(pending.slice(offset, offset + 30).map(({ index }) => limit(async () => {
            validVideos[index] = await enrich(validVideos[index]);
          })));
          if (offset + 30 < pending.length) await this.sleep(300);
        }
      }

      const fallback = missing();
      const fallbackLimit = pLimit(2);
      for (let offset = 0; offset < fallback.length; offset += 10) {
        await Promise.all(fallback.slice(offset, offset + 10).map(({ index }) => fallbackLimit(async () => {
          const video = validVideos[index];
          try {
            const result = await youtubeDlExec(video.url, {
              dumpSingleJson: true, skipDownload: true, noPlaylist: true, ignoreConfig: true,
              noWarnings: true, ignoreNoFormatsError: true, socketTimeout: 15,
              retries: 1, extractorRetries: 1, sleepRequests: 0.75,
              ...this.getCookieOption(),
            } as any, { timeout: 45_000 });
            const metadata = JSON.parse(result.stdout);
            if (metadata.id !== video.id) return;
            const dates = youtubeVideoDate(metadata);
            validVideos[index] = { ...video, created_at: video.created_at ?? dates.created_at, updated_at: video.updated_at ?? dates.updated_at };
          } catch { /* Ignore */ }
          finally { await this.sleep(500); }
        })));
      }

      return {
        type: parsed.extractor_key ?? parsed._type ?? 'unknown',
        channelId: parsed.channel_id ?? parsed.uploader_id ?? null,
        channel: parsed.channel ?? parsed.uploader ?? null,
        channelUrl: parsed.channel_url ?? null,
        title: parsed.title ?? null,
        totalVideos: validVideos.length,
        videos: validVideos,
      };
    } catch (error: any) {
      throw new Error(`Error fetching channel videos: ${(error as Error).message}`);
    }
  }

  async downloadImage(imageUrl: string, res: Response) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      let buffer: Buffer = Buffer.from(response.data);
      if (buffer.length === 0) throw new Error('Downloaded image is empty');

      let contentType = 'image/jpeg';
      let extension = 'jpg';
      let needsConversion = false;

      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        contentType = 'image/jpeg';
        extension = 'jpg';
      } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        contentType = 'image/png';
        extension = 'png';
      } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        contentType = 'image/gif';
        extension = 'gif';
      } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        needsConversion = true;
        contentType = 'image/jpeg';
        extension = 'jpg';
      }

      if (needsConversion) {
        buffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
      }

      const urlParts = imageUrl.split('/');
      const urlFilename = urlParts[urlParts.length - 1].split('?')[0].split('.')[0];
      const filename = `${this.sanitizeFilename(urlFilename || 'image')}.${extension}`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length.toString());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.end(buffer);
    } catch (error: any) {
      throw new Error(`Error downloading image: ${error.message}`);
    }
  }

  private async download(url: string, output: string, format: string, video = false, signal?: AbortSignal): Promise<string> {
    const options: any = {
      format, output, noPlaylist: true, noWarnings: true, ignoreConfig: true,
      ffmpegLocation: ffmpegPath,
      postprocessorArgs: 'ffmpeg:-loglevel error',
      continue: true, part: true, socketTimeout: 30,
      retries: 3, fragmentRetries: 3, extractorRetries: 1, fileAccessRetries: 2,
      retrySleep: ['http:exp=2:15', 'fragment:exp=2:15', 'extractor:5'],
      sleepRequests: 0.75, concurrentFragments: 2,
      abortOnUnavailableFragments: true,
      matchFilters: '!is_live',
      print: ['after_move:LENYT_TITLE=%(title)j', 'after_move:LENYT_FILE=%(filepath)j'],
      ...(video ? { mergeOutputFormat: 'mkv' } : {}),
      ...this.getCookieOption(),
    };
    const child = youtubeDlExec(`https://www.youtube.com/watch?v=${this.extractVideoId(url)}`, options, { signal });
    try {
      const result = await child;
      return result.stdout || '';
    } catch (error: any) {
      if (error.stderr) error.message = error.stderr;
      throw error;
    }
  }

  async prepareMedia(url: string, kind: 'video' | 'audio', directory: string, quality = '1080p', signal?: AbortSignal): Promise<MediaFile> {
    const heights: Record<string, number> = { '2160p': 2160, '4k': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240, '144p': 144 };
    const height = heights[quality] || 1080;
    const format = kind === 'audio' ? 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio'
      : `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    const output = await this.download(url, path.join(directory, 'media.%(ext)s'), format, kind === 'video', signal);
    const encodedPath = output.match(/^LENYT_FILE=(.*)$/m)?.[1];
    if (!encodedPath) throw new Error('Không tìm thấy file media đã tải');
    const raw = JSON.parse(encodedPath);
    if (typeof raw !== 'string' || path.dirname(path.resolve(raw)) !== path.resolve(directory)) throw new Error('Đường dẫn file tải không hợp lệ');
    if (!fs.statSync(raw).size) throw new Error('File tải về rỗng');
    let file = raw;
    if (kind === 'video') {
      file = await playableMp4(raw, path.join(directory, 'video.mp4'), ffmpegPath, signal);
    } else {
      const inspection = await execFileAsync(ffmpegPath, ['-hide_banner', '-nostdin', '-i', raw, '-map', '0:a:0', '-t', '1', '-f', 'null', '-'], {
        signal, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      if (!/Audio:/.test(inspection.stderr)) throw new Error('File tải về không có audio hợp lệ');
    }
    return { file, title: this.titleFromDownload(output, this.extractVideoId(url)), extension: path.extname(file).slice(1) };
  }

  private titleFromDownload(output: string, fallback: string) {
    const json = output.match(/^LENYT_TITLE=(.*)$/m)?.[1];
    if (json) {
      try {
        const title = JSON.parse(json);
        if (typeof title === 'string') return this.sanitizeFilename(title);
      } catch { /* Ignore */ }
    }
    return fallback;
  }

  private async title(url: string) {
    try {
      await this.ready();
      const info = await this.youtube.getBasicInfo(this.extractVideoId(url));
      return this.sanitizeFilename(info.basic_info.title || 'video');
    } catch { return 'video'; }
  }

  private sendFile(file: string, filename: string, type: string, res: Response, directory: string) {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', fs.statSync(file).size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const stream = fs.createReadStream(file);
    const cleanup = () => { stream.destroy(); fs.rmSync(directory, { recursive: true, force: true }); };
    res.once('close', cleanup);
    stream.once('error', error => res.destroy(error));
    stream.pipe(res);
  }

  async streamAudio(url: string, res: Response) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lenyt-audio-'));
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const { file, title, extension } = await this.prepareMedia(url, 'audio', directory, undefined, controller.signal);
      const types: Record<string, string> = { m4a: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg' };
      this.sendFile(file, `${title}.${extension}`, types[extension] || 'application/octet-stream', res, directory);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }

  async streamVideo(url: string, res: Response, quality = '1080p') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lenyt-video-'));
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const { file, title } = await this.prepareMedia(url, 'video', directory, quality, controller.signal);
      this.sendFile(file, `${title}.mp4`, 'video/mp4', res, directory);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }

  async downloadAudioYoutubei(url: string, res: Response, format: 'mp3' | 'm4a' = 'mp3') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lenyt-youtubei-'));
    try {
      await this.ready();
      const id = this.extractVideoId(url);
      const title = await this.title(url);
      const webStream = await this.youtube.download(id, { type: 'audio', quality: 'best' });
      const raw = path.join(directory, 'raw');
      await pipeline(Readable.fromWeb(webStream as any), fs.createWriteStream(raw));
      const output = path.join(directory, `audio.${format}`);
      await new Promise<void>((resolve, reject) => {
        Ffmpeg(raw).noVideo().audioCodec(format === 'mp3' ? 'libmp3lame' : 'aac')
          .save(output).on('end', () => resolve()).on('error', reject);
      });
      this.sendFile(output, `${title}.${format}`, format === 'mp3' ? 'audio/mpeg' : 'audio/mp4', res, directory);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (!res.headersSent) return this.streamAudio(url, res);
      throw error;
    }
  }
}

export const youtubeToolsService = new YouTubeToolsService();
