import type { Plugin, Connect } from 'vite';
import { loadEnv } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handleYouTubeApi } from './youtube/handler.ts';
import { DEFAULT_LOCAL_CAP, QuotaTracker, type QuotaState, type QuotaStore } from './youtube/quota.ts';
import { mockFetch } from './youtube/mock.ts';

/** 사용량을 파일에 저장해 서버를 다시 켜도 오늘 사용량이 유지되게 한다 */
function fileQuotaStore(path: string): QuotaStore {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as QuotaState;
      } catch {
        return null;
      }
    },
    save: (state) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(state));
      } catch {
        /* 저장 실패는 무시 (메모리 값만 사용) */
      }
    },
  };
}

/**
 * 로컬 YouTube 프록시 — `npm run dev` / `npm run preview` 서버 안에서 /api/youtube/* 를 처리한다.
 * API 키는 .env.local 의 YOUTUBE_API_KEY (VITE_ 접두사 없음 → 브라우저 번들에 포함되지 않음).
 */
export function youtubeProxyPlugin(): Plugin {
  let middleware: Connect.NextHandleFunction | null = null;

  const create = (mode: string, root: string): Connect.NextHandleFunction => {
    const env = { ...loadEnv(mode, root, ''), ...process.env };
    const mock = env.YOUTUBE_API_MOCK === '1';
    const apiKey = mock ? 'mock-key' : env.YOUTUBE_API_KEY?.trim() || null;
    const cap = Number(env.YOUTUBE_DAILY_UNIT_CAP) || DEFAULT_LOCAL_CAP;
    const quotaFile = join(root, 'node_modules', '.cache', 'my-english-study', mock ? 'youtube-quota.mock.json' : 'youtube-quota.json');
    const quota = new QuotaTracker(fileQuotaStore(quotaFile), cap);
    const deps = { apiKey, quota, fetch: mock ? mockFetch : fetch, mock };

    return async (req, res, next) => {
      if (!req.url?.startsWith('/api/youtube/')) return next();
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const result = await handleYouTubeApi(new URL(req.url, 'http://localhost'), deps);
      if (!result) return next();
      res.statusCode = result.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(result.body));
    };
  };

  return {
    name: 'my-english-study:youtube-proxy',
    configResolved(config) {
      middleware = create(config.mode, config.root);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => middleware!(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => middleware!(req, res, next));
    },
  };
}
