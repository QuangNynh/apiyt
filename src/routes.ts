import { Router, Request, Response } from 'express';
import { youtubeToolsService } from './youtube-tools.service';
import { YouTubeChannelJobs } from './youtube-channel-jobs';

export const youtubeRouter = Router();
const channelJobs = new YouTubeChannelJobs(url => youtubeToolsService.getChannelVideos(url));

// 1. Lấy kịch bản / phụ đề video
youtubeRouter.post('/transcript', async (req: Request, res: Response) => {
  try {
    const videoId = req.body.videoId || req.body.url;
    if (typeof videoId !== 'string' || !videoId.trim()) {
      return res.status(400).json({ success: false, message: 'Missing videoId' });
    }
    const result = await youtubeToolsService.getTranscript(videoId, req.body.lang || 'en');
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 2. Lấy phụ đề hàng loạt
youtubeRouter.post('/transcripts', async (req: Request, res: Response) => {
  const { videoIds, lang = 'en' } = req.body;
  if (!Array.isArray(videoIds) || !videoIds.length || videoIds.some(id => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ success: false, message: 'videoIds phải là mảng Video ID' });
  }
  try {
    res.json(await youtubeToolsService.getTranscripts(videoIds, lang));
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 3. Lấy metadata chi tiết (title, view, like, description)
youtubeRouter.post('/info', async (req: Request, res: Response) => {
  try {
    const videoId = req.body.videoId || req.body.url;
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    res.json(await youtubeToolsService.getAll(videoId));
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 4. Quét danh sách video của kênh (view, title, date)
youtubeRouter.post('/urls', async (req: Request, res: Response) => {
  try {
    const job = channelJobs.create(req.body.url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, 10_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const state = channelJobs.status(job.id)!;
    if (state.status === 'completed') return res.json(state.result);
    if (state.status === 'failed') return res.status(400).json({ success: false, message: state.error });
    res.status(202).json({ jobId: job.id, status: 'running', statusUrl: `/api/v1/youtube/urls/jobs/${job.id}` });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

youtubeRouter.get('/urls/jobs/:id', (req: Request, res: Response) => {
  const state = channelJobs.status(String(req.params.id));
  res.setHeader('Cache-Control', 'no-store');
  if (!state) return res.status(404).json({ success: false, message: 'Tác vụ không tồn tại hoặc đã hết hạn.' });
  res.json(state);
});

// 5. Tải ảnh Thumbnail video (WebP tự chuyển sang JPG)
youtubeRouter.post('/download-image', async (req: Request, res: Response) => {
  if (typeof req.body.imageUrl !== 'string' || !req.body.imageUrl.trim()) {
    return res.status(400).json({ success: false, message: 'Missing imageUrl' });
  }
  try {
    await youtubeToolsService.downloadImage(req.body.imageUrl, res);
  } catch (error: any) {
    if (!res.headersSent) res.status(400).json({ success: false, message: error.message });
  }
});

// 6. Tải Audio gốc (hỗ trợ fallback yt-dlp)
youtubeRouter.post('/audio/youtubei', async (req: Request, res: Response) => {
  const { url, format = 'mp3' } = req.body;
  if (!url || !['mp3', 'm4a'].includes(format)) {
    return res.status(400).json({ success: false, message: 'URL hoặc định dạng không hợp lệ' });
  }
  try {
    await youtubeToolsService.downloadAudioYoutubei(url, res, format);
  } catch (error: any) {
    if (!res.headersSent) res.status(400).json({ success: false, message: error.message });
  }
});

youtubeRouter.post('/audio', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Missing url' });
    await youtubeToolsService.streamAudio(url, res);
  } catch (error: any) {
    if (!res.headersSent) res.status(400).json({ success: false, message: error.message });
  }
});

// 7. Tải Video YouTube
youtubeRouter.post('/video', async (req: Request, res: Response) => {
  try {
    const { url, quality = '1080p' } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'Missing url' });
    await youtubeToolsService.streamVideo(url, res, quality);
  } catch (error: any) {
    if (!res.headersSent) res.status(400).json({ success: false, message: error.message });
  }
});
