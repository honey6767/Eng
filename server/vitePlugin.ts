import type { Plugin, Connect } from 'vite';
import { loadEnv } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handleYouTubeApi } from './youtube/handler.ts';
import { DEFAULT_LOCAL_CAP, QuotaTracker, type QuotaState, type QuotaStore } from './youtube/quota.ts';
import { mockFetch } from './youtube/mock.ts';
import { AUTH_CHECK_PATH, memoryFailureLimiter, verifyAccess } from './accessAuth.ts';
import { AI_EXTRACT_PATH, AI_USAGE_PATH } from '../src/types/aiApi.ts';
import { handleAiExtract, parseCaps, readUsage } from './ai/extractHandler.ts';
import { memoryLedgerStore } from './ai/ledger.ts';
import { createGeminiClient } from './ai/gemini.ts';
import { createMockGemini } from './ai/mockGemini.ts';

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
 * 접근 코드: .env.local(또는 환경변수)에 ACCESS_CODE가 있을 때만 배포 Worker와 같은 방식으로 검사한다.
 * 없으면 내 컴퓨터에서 쓰는 로컬 모드로 보고 검사하지 않는다 (/api/youtube/auth → required: false).
 */
export function youtubeProxyPlugin(): Plugin {
  let middleware: Connect.NextHandleFunction | null = null;

  const create = (mode: string, root: string): Connect.NextHandleFunction => {
    const env = { ...loadEnv(mode, root, ''), ...process.env };
    const mock = env.YOUTUBE_API_MOCK === '1';
    const apiKey = mock ? 'mock-key' : env.YOUTUBE_API_KEY?.trim() || null;
    const cap = Number(env.YOUTUBE_DAILY_UNIT_CAP) || DEFAULT_LOCAL_CAP;
    // YOUTUBE_QUOTA_FILE: 테스트에서 사용량 기록을 따로 두기 위한 경로 (보통은 비워 둠)
    const quotaFile =
      env.YOUTUBE_QUOTA_FILE?.trim() || join(root, 'node_modules', '.cache', 'my-english-study', mock ? 'youtube-quota.mock.json' : 'youtube-quota.json');
    const quota = new QuotaTracker(fileQuotaStore(quotaFile), cap);
    const deps = { apiKey, quota, fetch: mock ? mockFetch : fetch, mock };
    const accessCode = env.ACCESS_CODE ?? null;
    const limiter = memoryFailureLimiter();
    // (B1-b) AI 추출 — 로컬에서는 장부를 메모리에 둔다 (서버를 끄면 사라짐, 앱의 IndexedDB 기록이 기준)
    // AI_GEMINI_MOCK=1이면 가짜 Gemini(테스트용), 아니면 .env.local의 GEMINI_API_KEY (없으면 '키 없음'으로 거절)
    const aiStore = memoryLedgerStore();
    const aiGemini =
      env.AI_GEMINI_MOCK === '1'
        ? createMockGemini()
        : createGeminiClient({ apiKey: env.GEMINI_API_KEY?.trim() || null, model: env.GEMINI_MODEL, fetch });
    // 가짜 Gemini(테스트)에서는 요청 간격 대기를 기본으로 끈다 (AI_MIN_GAP_SEC로 켤 수 있음). 상한은 운영과 같음
    const aiCaps = parseCaps(env.AI_GEMINI_MOCK === '1' && env.AI_MIN_GAP_SEC === undefined ? { ...env, AI_MIN_GAP_SEC: '0' } : env);
    const readBody = (req: Parameters<Connect.NextHandleFunction>[0]) =>
      new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (c: Buffer) => {
          data += c;
          if (data.length > 256 * 1024) req.destroy();
        });
        req.on('end', () => resolve(data));
        req.on('error', () => resolve(''));
      });
    const sendJson = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };

    return async (req, res, next) => {
      if (req.url?.split('?')[0] === AI_USAGE_PATH) {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (accessCode != null) {
          const access = await verifyAccess({ authorization: req.headers.authorization ?? null, secret: accessCode, clientKey: req.socket.remoteAddress ?? 'local', limiter });
          if (!access.ok) return sendJson(res, access.status, { ok: false, code: access.code, message: access.message });
        }
        return sendJson(res, 200, readUsage(aiStore, aiCaps));
      }
      if (req.url?.split('?')[0] === AI_EXTRACT_PATH) {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (accessCode != null) {
          const access = await verifyAccess({ authorization: req.headers.authorization ?? null, secret: accessCode, clientKey: req.socket.remoteAddress ?? 'local', limiter });
          if (!access.ok) return sendJson(res, access.status, { ok: false, state: 'failed', requestId: null, code: access.code, message: access.message, consumed: false });
        }
        let body: unknown = null;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          body = null;
        }
        const key = req.headers['idempotency-key'];
        const result = await handleAiExtract({ idempotencyKey: typeof key === 'string' ? key : null, body }, { store: aiStore, gemini: aiGemini, caps: aiCaps });
        return sendJson(res, result.status, result.body);
      }
      if (!req.url?.startsWith('/api/youtube/')) return next();
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (accessCode != null) {
        const access = await verifyAccess({
          authorization: req.headers.authorization ?? null,
          secret: accessCode,
          clientKey: req.socket.remoteAddress ?? 'local',
          limiter,
        });
        if (!access.ok) return sendJson(res, access.status, { ok: false, code: access.code, message: access.message });
      }
      if (url.pathname === AUTH_CHECK_PATH) return sendJson(res, 200, { ok: true, required: accessCode != null });
      const result = await handleYouTubeApi(url, deps);
      if (!result) return next();
      sendJson(res, result.status, result.body);
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
