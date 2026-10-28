import express from 'express';
import cors from 'cors';
import { youtubeRouter } from './routes';

const app = express();

app.use(cors({ exposedHeaders: ['Content-Disposition', 'Content-Length'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Mount các endpoint YouTube
app.use('/api/v1/youtube', youtubeRouter);

const port = Number(process.env.PORT) || 8000;
app.listen(port, '0.0.0.0', () => {
  console.log(`[YouTube API Server] Running on http://0.0.0.0:${port}`);
});
