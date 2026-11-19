import { describe, expect, it } from 'vitest';
import { apiOrigin, contentSecurityPolicy, pagesHeadersFile, securityHeaders } from './securityHeaders.ts';

describe('보안 헤더', () => {
  it('Worker 주소는 Origin만 connect-src에 넣고, 잘못된 값·비밀정보 형식은 무시한다', () => {
    expect(apiOrigin('https://proxy.example.workers.dev/some/path?x=1')).toBe('https://proxy.example.workers.dev');
    expect(apiOrigin('')).toBeNull();
    expect(apiOrigin('not a url')).toBeNull();
    expect(apiOrigin('javascript:alert(1)')).toBeNull();
    expect(contentSecurityPolicy('https://proxy.example.workers.dev/')).toContain("connect-src 'self' https://proxy.example.workers.dev;");
    expect(contentSecurityPolicy()).toContain("connect-src 'self';");
  });
  it('스크립트는 같은 주소만 — unsafe-inline·unsafe-eval·와일드카드 없음', () => {
    const csp = contentSecurityPolicy('https://proxy.example.workers.dev');
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com;');
    expect(csp).toContain("img-src 'self' data: https://i.ytimg.com;");
  });
  it('기본 보안 헤더 + Pages _headers 파일 형식', () => {
    const h = securityHeaders();
    expect(h).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000',
    });
    expect(h).not.toHaveProperty('Cross-Origin-Embedder-Policy');
    const file = pagesHeadersFile();
    expect(file.split('\n')[1]).toBe('/*');
    for (const [k, v] of Object.entries(h)) expect(file).toContain(`  ${k}: ${v}`);
  });
});
