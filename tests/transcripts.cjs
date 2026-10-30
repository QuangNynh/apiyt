const { test } = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeToolsService } = require('../dist/youtube-tools.service');
const { parseJson3, selectCaption, fetchYtdlpTranscript } = require('../dist/youtube-transcript');
const axios = require('axios');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCookies, captionCookies } = require('../dist/youtube-cookies');
const ids = ['Q5VD0Ha-D_U', '5K34NH3cTZc', 'qgxUwQQvrFM', '3cSwIMyD-30'];
const data = { transcript: [{ text: 'Hello', offset: 0, duration: 1, lang: 'en' }], usedLang: 'en', metadata: { title: 'Example' } };
test('JSON3 parser joins text, normalizes seconds, and ignores empty events', () => {
  assert.deepEqual(parseJson3({ events: [{}, { tStartMs: 1200, dDurationMs: 2300, segs: [{ utf8: 'Hello ' }, { utf8: 'world\n' }] }] }, 'en'),
    [{ text: 'Hello world', offset: 1.2, duration: 2.3, lang: 'en' }]);
  assert.throws(() => parseJson3({ events: [] }, 'en'), /empty captions/);
});
test('selects one requested-language track, prefers manual, falls back to original', () => {
  const t = url => [{ ext: 'json3', url }];
  const info = { language: 'vi', subtitles: { vi: t('manual') }, automatic_captions: { vi: t('auto'), 'vi-orig': t('original') } };
  assert.equal(selectCaption(info, 'vi').track.url, 'manual');
  assert.equal(selectCaption(info, 'en').lang, 'vi');
  assert.throws(() => selectCaption({ subtitles: { live_chat: t('chat') } }, 'en'), /No accessible/);
});
test('yt-dlp extracts captions without media download and builds real metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apiyt-test-'));
  const cookieFile = path.join(directory, 'cookies.txt');
  fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tTEST\tsynthetic\n');
  let workerFile;
  const previous = axios.default.get;
  const proxy = process.env.YT_PROXY_URL;
  process.env.YT_PROXY_URL = 'http://user:password@127.0.0.1:8080';
  try {
    axios.default.get = async (url, options) => {
      assert.equal(url, 'https://www.youtube.com/api/timedtext');
      assert.equal(options.proxy, false);
      assert.ok(options.httpsAgent);
      assert.equal(options.timeout, 10000);
      assert.equal(options.headers.Cookie, 'TEST=synthetic');
      return { data: { events: [{ tStartMs: 0, segs: [{ utf8: 'Hello' }] }] } };
    };
    const r = await fetchYtdlpTranscript(ids[0], 'en', async (url, flags, opts) => {
      assert.equal(flags.skipDownload, true);
      assert.equal(flags.ignoreConfig, true);
      workerFile = flags.cookies;
      assert.notEqual(workerFile, cookieFile);
      assert.ok(fs.existsSync(workerFile));
      assert.equal(flags.proxy, process.env.YT_PROXY_URL);
      assert.equal(opts.timeout, 90000);
      return { stdout: JSON.stringify({ title: 'Real title', subtitles: { en: [{ ext: 'json3', url: 'https://www.youtube.com/api/timedtext' }] } }) };
    }, { cookies: cookieFile });
    assert.equal(fs.existsSync(workerFile), false);
    assert.equal(r.metadata.title, 'Real title');
    assert.equal(r.transcript[0].text, 'Hello');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    axios.default.get = previous;
    if (proxy === undefined) delete process.env.YT_PROXY_URL; else process.env.YT_PROXY_URL = proxy;
  }
});
test('batch preserves order, limits concurrency, deduplicates requests and caches success', async () => {
  const s = new YouTubeToolsService();
  let active = 0, peak = 0, calls = 0;
  s.fetchYtdlpTranscript = async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return data;
  };
  const results = await s.getTranscripts([...ids, ids[0]]);
  assert.deepEqual(results.map(r => r.videoId), [...ids, ids[0]]);
  assert.equal(calls, 4);
  assert.equal(peak, 1);
  assert.equal(results[0].text, 'Hello');
  await s.getTranscript(ids[0]);
  assert.equal(calls, 4);
});
test('failure is explicit, redacts credentials, and is not cached', async () => {
  const s = new YouTubeToolsService();
  let calls = 0;
  s.fetchYtdlpTranscript = async () => { calls++; throw new Error('403 http://user:secret@proxy'); };
  const r = await s.getTranscript(ids[0]);
  assert.equal(r.success, false);
  assert.equal(r.text, null);
  assert.equal(r.errorCode, 'YOUTUBE_ACCESS_BLOCKED');
  assert.doesNotMatch(r.error, /secret/);
  await s.getTranscript(ids[0]);
  assert.equal(calls, 2);
});
test('invalid IDs fail individually in batch', async () => {
  const s = new YouTubeToolsService();
  const [r] = await s.getTranscripts(['invalid']);
  assert.equal(r.success, false);
  assert.equal(r.text, null);
  assert.ok(r.error);
});

test('cookie normalizer accepts raw, base64, CRLF and escaped separators', () => {
  const raw = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tTEST\tsynthetic\n';
  assert.equal(normalizeCookies(Buffer.from(raw).toString('base64')), raw);
  assert.equal(normalizeCookies(raw.replace(/\n/g, '\\n').replace(/\t/g, '\\t')), raw);
  assert.equal(normalizeCookies(raw.replace(/\n/g, '\r\n')), raw);
  assert.throws(() => normalizeCookies('# Netscape HTTP Cookie File\ninvalid'), /invalid Netscape/);
});
test('caption cookie header excludes expired cookies and unrelated domains', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apiyt-test-'));
  const file = path.join(directory, 'cookies.txt');
  try {
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' +
      '.youtube.com\tTRUE\t/\tTRUE\t1\tEXPIRED\tx\n' +
      '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tVALID\tx\n' +
      '.example.com\tTRUE\t/\tTRUE\t0\tOTHER\tx\n');
    assert.equal(captionCookies(file, 'https://www.youtube.com/api/timedtext'), 'VALID=x');
    assert.equal(captionCookies(file, 'https://example.com/'), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('HTTP failures retain stage and status without leaking upstream URLs', async () => {
  const s = new YouTubeToolsService();
  s.fetchYtdlpTranscript = async () => { throw Object.assign(new Error('Request failed'), { stage: 'captions', response: { status: 429 } }); };
  const result = await s.getTranscript(ids[0]);
  assert.equal(result.stage, 'captions');
  assert.equal(result.upstreamStatus, 429);
  assert.equal(result.errorCode, 'YOUTUBE_ACCESS_BLOCKED');
});

test('extractor diagnostics distinguish deadline from external kill and redact stderr', () => {
  const { extractorDiagnostic } = require('../dist/youtube-transcript');
  assert.equal(extractorDiagnostic({ signalCode: 'SIGTERM' }, 90001, 90000).timedOut, true);
  const killed = extractorDiagnostic({ signalCode: 'SIGKILL', stderr: 'secret-cookie' }, 2000, 90000);
  assert.equal(killed.timedOut, false);
  assert.equal(killed.reason, 'EXTRACTOR_TERMINATED');
  assert.doesNotMatch(JSON.stringify(killed), /secret-cookie/);
  assert.equal(extractorDiagnostic({ stderr: 'HTTP Error 429' }, 1000, 90000).reason, 'YOUTUBE_ACCESS_BLOCKED');
});
