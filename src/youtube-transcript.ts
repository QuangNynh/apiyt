import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { captionCookies, normalizeCookies } from './youtube-cookies';

export function parseJson3(body: any, lang: string) {
  if (typeof body === 'string') body = JSON.parse(body);
  const segments = (body.events || []).flatMap((event: any) => {
    const text = (event.segs || []).map((s: any) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    const offset = Number(event.tStartMs) / 1000;
    const duration = Number(event.dDurationMs || 0) / 1000;
    return text && Number.isFinite(offset) && Number.isFinite(duration)
      ? [{ text, offset, duration, lang }] : [];
  });
  if (!segments.length) throw new Error('YouTube returned empty captions');
  return segments;
}

export function selectCaption(info: any, preferred: string) {
  // Prefer the requested language, then English, then the original language.
  // Never download all auto-translated tracks.
  const manual = info.subtitles || {};
  const auto = info.automatic_captions || {};
  const available = [...new Set([...Object.keys(manual), ...Object.keys(auto)])].filter(k => k !== 'live_chat');
  const languages = [...new Set([preferred, 'en', info.language, ...available.filter(k => k.endsWith('-orig')), ...available])];
  for (const lang of languages) {
    if (!lang) continue;
    const track = [...(manual[lang] || []), ...(auto[lang] || [])].find(t => t.ext === 'json3' && t.url);
    if (track) return { lang, track };
  }
  throw new Error('No accessible caption tracks for this video');
}

export async function fetchYtdlpTranscript(
  videoId: string, lang: string, run: (url: string, options: any, processOptions: any) => Promise<any>,
  cookies: Record<string, string>,
) {
  const proxy = process.env.YT_PROXY_URL;
  if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error('YT_PROXY_URL must use http:// or https://');
  // yt-dlp mutates its jar; isolate each worker and preserve refreshed cookies
  // for the caption request within this invocation.
  let directory: string | undefined;
  let stage = 'cookies';
  try {
    if (cookies.cookies) {
      const content = normalizeCookies(fs.readFileSync(cookies.cookies, 'utf8'));
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apiyt-caption-'));
      const file = path.join(directory, 'cookies.txt');
      fs.writeFileSync(file, content, { mode: 0o600 });
      cookies = { ...cookies, cookies: file };
    }
    stage = 'extract';
    const result = await run(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true, skipDownload: true, noPlaylist: true, ignoreConfig: true,
      noWarnings: true, socketTimeout: 10, retries: 0, extractorRetries: 0,
      jsRuntimes: 'node',
      extractorArgs: 'youtube:skip=hls,dash,translated_subs',
      ...cookies, ...(proxy ? { proxy } : {}),
    }, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
    stage = 'select';
    const raw = result.stdout ?? result;
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const selected = selectCaption(info, lang);
    const cookie = cookies.cookies ? captionCookies(cookies.cookies, selected.track.url) : '';
    stage = 'captions';
    const response = await axios.get(selected.track.url, {
      timeout: 10_000, maxContentLength: 8 * 1024 * 1024,
      headers: { ...info.http_headers, ...(cookie ? { Cookie: cookie } : {}) },
      ...(proxy ? { proxy: false as const, httpsAgent: new HttpsProxyAgent(proxy) } : {}),
    });
    stage = 'parse';
    return {
      transcript: parseJson3(response.data, selected.lang), usedLang: selected.lang,
      metadata: {
        videoId, title: info.title, description: info.description, author: info.uploader,
        channelId: info.channel_id, thumbnails: info.thumbnails,
        durationSeconds: info.duration, viewCount: info.view_count || 0,
        likeCount: info.like_count || 0, isLive: info.is_live || false,
        category: info.categories?.[0] || null, keywords: info.tags,
      },
    };
  } catch (error: any) {
    error.stage = stage;
    error.upstreamStatus = error.response?.status;
    throw error;
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
