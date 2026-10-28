export function youtubeVideoId(value: string): string {
  if (typeof value !== 'string') throw new Error('URL YouTube không hợp lệ');
  value = value.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) throw new Error();
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/)?.[1];
    if (id && /^[\w-]{11}$/.test(id)) return id;
  } catch { /* Report the same validation error for all invalid inputs. */ }
  throw new Error(`Video ID hoặc URL YouTube không hợp lệ: ${value.slice(0, 120)}`);
}
