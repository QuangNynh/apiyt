import * as fs from 'fs';

export function normalizeCookies(value: string): string {
  let content = value.trim();
  if (!content.startsWith('#') && !content.includes('\t')) {
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) throw new Error('YT_COOKIES must be Netscape text or base64');
    content = Buffer.from(content, 'base64').toString('utf8').trim();
  }
  content = content.replace(/\r\n?/g, '\n').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(content)) throw new Error('YT_COOKIES is missing Netscape header');
  const records = content.split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  if (!records.length || records.some(line => {
    const fields = line.split('\t');
    return fields.length !== 7 || !/^\d+$/.test(fields[4]) || !/^(TRUE|FALSE)$/.test(fields[3]);
  })) throw new Error('YT_COOKIES contains invalid Netscape rows; preserve seven tab-separated columns');
  return content.replace(/\n+$/, '') + '\n';
}

export function captionCookies(file: string, url: string): string {
  const target = new URL(url);
  // Only send these account cookies to YouTube, never arbitrary caption hosts.
  if (target.protocol !== 'https:' || !(target.hostname === 'youtube.com' || target.hostname.endsWith('.youtube.com'))) return '';
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    else if (line.startsWith('#')) return [];
    const fields = line.split('\t');
    if (fields.length !== 7) return [];
    const [domain, subdomains, path, , expiry, name, value] = fields;
    const host = domain.replace(/^\./, '').toLowerCase();
    if (!(target.hostname === host || (subdomains === 'TRUE' && target.hostname.endsWith('.' + host)))) return [];
    if (!(target.pathname === path || target.pathname.startsWith(path.endsWith('/') ? path : path + '/'))) return [];
    if (Number(expiry) !== 0 && Number(expiry) <= Date.now() / 1000) return [];
    return [`${name}=${value.trimEnd()}`];
  }).join('; ');
}
