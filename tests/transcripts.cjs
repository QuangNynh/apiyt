const { test } = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeToolsService } = require('../dist/youtube-tools.service');
const ids = ['Q5VD0Ha-D_U', '5K34NH3cTZc', 'qgxUwQQvrFM', '3cSwIMyD-30'];
function service() {
  const s = new YouTubeToolsService();
  s.ready = async () => {};
  s.youtube = { getInfo: async () => ({ basic_info: { title: 'Example' } }) };
  return s;
}
test('metadata alone never reports transcript success and retains upstream error', async () => {
  const s = service();
  s.fetchTranscriptWithFallback = async () => { throw new Error('Primary blocked'); };
  s.fetchInnertubeTranscript = async () => { throw new Error('Fallback blocked'); };
  const results = await s.getTranscripts(ids);
  assert.deepEqual(results.map(r => r.videoId), ids);
  for (const r of results) {
    assert.equal(r.success, false);
    assert.equal(r.transcript, null);
    assert.equal(r.text, null);
    assert.equal(r.metadata.title, 'Example');
    assert.match(r.error, /Primary blocked.*Fallback blocked/);
    assert.equal(r.attempts, 1);
  }
});
test('primary transcript produces plain text and succeeds', async () => {
  const s = service();
  s.fetchTranscriptWithFallback = async () => ({ transcript: [{ text: 'Hello', lang: 'vi' }, { text: 'world', lang: 'vi' }], usedLang: 'vi' });
  const r = await s.getTranscript(ids[0]);
  assert.equal(r.success, true);
  assert.equal(r.text, 'Hello world');
  assert.equal(r.transcriptLanguage, 'vi');
  assert.equal(r.error, null);
});
test('Innertube fallback normalizes segments and skips section headers', async () => {
  const s = service();
  s.fetchTranscriptWithFallback = async () => { throw new Error('Primary failed'); };
  s.youtube.getInfo = async () => ({ basic_info: {}, getTranscript: async () => ({ selectedLanguage: 'Vietnamese', transcript: { content: { body: { initial_segments: [
    { type: 'TranscriptSectionHeader' },
    { type: 'TranscriptSegment', snippet: 'Xin chào', start_ms: '1000', end_ms: '2500' },
  ] } } } }) });
  const r = await s.getTranscript(ids[0]);
  assert.equal(r.success, true);
  assert.equal(r.text, 'Xin chào');
  assert.equal(r.transcript[0].offset, 1);
  assert.equal(r.transcript[0].duration, 1.5);
});
test('invalid IDs fail individually in batch', async () => {
  const s = service();
  const [r] = await s.getTranscripts(['invalid']);
  assert.equal(r.success, false);
  assert.equal(r.text, null);
  assert.ok(r.error);
});
