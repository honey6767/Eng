/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { youtubeProxyPlugin } from './server/vitePlugin.ts';
import { pagesHeadersFile, securityHeaders } from './server/securityHeaders.ts';

/** 빌드 결과물에 Cloudflare Pages용 `_headers`(보안 헤더) 파일을 만든다 */
function pagesHeadersPlugin(apiBaseUrl: string | undefined): Plugin {
  return {
    name: 'my-english-study:pages-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: pagesHeadersFile(apiBaseUrl) });
    },
  };
}

export default defineConfig(({ mode }) => {
  // 'VITE_' 접두사 값만 읽는다 (공개 가능한 값). 비밀정보(YOUTUBE_API_KEY)는 여기서 읽지 않는다.
  const apiBaseUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE_URL;
  return {
    plugins: [react(), tailwindcss(), youtubeProxyPlugin(), pagesHeadersPlugin(apiBaseUrl)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // 미리보기 서버도 배포와 같은 보안 헤더 → E2E 점검이 실제 정책 아래에서 실행됨 (개발 서버에는 적용하지 않음)
    preview: { headers: securityHeaders(apiBaseUrl) },
    test: {
      environment: 'node',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    },
  };
});
