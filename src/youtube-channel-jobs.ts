import { randomUUID } from 'node:crypto';
import type { YouTubeToolsService } from './youtube-tools.service';

type ChannelResult = Awaited<ReturnType<YouTubeToolsService['getChannelVideos']>>;
interface ChannelJob {
  id: string;
  url: string;
  status: 'running' | 'completed' | 'failed';
  result?: ChannelResult;
  error?: string;
  finishedAt?: number;
  done: Promise<void>;
}
export class YouTubeChannelJobs {
  private jobs = new Map<string, ChannelJob>();
  constructor(private readonly run: (url: string) => Promise<ChannelResult>) {}
  private prune() {
    const completed = [...this.jobs.values()].filter(job => job.finishedAt).sort((a, b) => b.finishedAt! - a.finishedAt!);
    completed.forEach((job, index) => { if (index >= 10 || Date.now() - job.finishedAt! > 30 * 60_000) this.jobs.delete(job.id); });
  }
  create(input: unknown) {
    if (typeof input !== 'string') throw new Error('URL kênh không hợp lệ');
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname) || url.username || url.password) throw new Error('Hãy nhập URL YouTube hợp lệ');
    url.hash = '';
    this.prune();
    const running = [...this.jobs.values()].filter(job => job.status === 'running');
    const existing = running.find(job => job.url === url.toString());
    if (existing) return existing;
    if (running.length >= 2) throw new Error('Đang xử lý 2 kênh. Hãy chờ một tác vụ hoàn tất.');
    const job: ChannelJob = { id: randomUUID(), url: url.toString(), status: 'running', done: Promise.resolve() };
    this.jobs.set(job.id, job);
    job.done = Promise.resolve().then(() => this.run(job.url)).then(result => {
      job.result = result; job.status = 'completed';
    }, error => {
      job.error = error instanceof Error ? error.message : String(error); job.status = 'failed';
    }).finally(() => { job.finishedAt = Date.now(); this.prune(); });
    return job;
  }
  status(id: string) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) return null;
    return { jobId: job.id, status: job.status, result: job.result, error: job.error };
  }
}
