import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CALLBACK_PAGE_CSP, callbackPageLang, renderCallbackPage, type CallbackPageKind } from '../src/callbackPage.js';

const kinds: Array<[CallbackPageKind, number]> = [['ok', 200], ['expired', 400], ['denied', 400], ['exchange_failed', 400], ['save_failed', 500]];

describe('renderCallbackPage — 브라우저 인증 콜백 페이지', () => {
  it.each(kinds)('%s 는 %i 이고 ko·en 제목이 갈린다', (kind, status) => {
    const ko = renderCallbackPage({ kind, name: 'linear', lang: 'ko' });
    const en = renderCallbackPage({ kind, name: 'linear', lang: 'en' });
    expect(ko.status).toBe(status);
    expect(en.status).toBe(status);
    expect(ko.body).toContain('<html lang="ko">');
    expect(en.body).toContain('<html lang="en">');
    expect(ko.body).toContain(`data-kind="${kind}"`);
    expect(ko.body).toContain('이 탭은 닫아도 됩니다.');
    expect(en.body).toContain('You can close this tab.');
  });

  it('네 화면의 제목 — 성공·만료·거절/교환 실패·저장 실패', () => {
    const t = (kind: CallbackPageKind) => /<h1>(.*)<\/h1>/.exec(renderCallbackPage({ kind, name: 'x', lang: 'ko' }).body)![1];
    expect(t('ok')).toBe('연결됐습니다');
    expect(t('expired')).toBe('인증 시간이 지났습니다');
    expect(t('denied')).toBe('연결하지 못했습니다');
    expect(t('exchange_failed')).toBe('연결하지 못했습니다');
    expect(t('save_failed')).toBe('연결하지 못했습니다');
  });

  it('성공 화면은 서버 이름을 굵게 싣고 사유 코드 칸이 없다', () => {
    const p = renderCallbackPage({ kind: 'ok', name: 'linear', code: 'ignored', lang: 'ko' });
    expect(p.body).toContain('<b>linear</b> 인증을 마쳤습니다.');
    expect(p.body).not.toContain('class="code"');
  });

  it('거절·교환 실패만 사유 코드를 보인다', () => {
    expect(renderCallbackPage({ kind: 'denied', name: 'linear', code: 'access_denied', lang: 'en' }).body).toContain('<div class="code">access_denied</div>');
    expect(renderCallbackPage({ kind: 'exchange_failed', name: 'linear', code: 'invalid_grant', lang: 'en' }).body).toContain('<div class="code">invalid_grant</div>');
    expect(renderCallbackPage({ kind: 'expired', code: 'x', lang: 'en' }).body).not.toContain('class="code"');
    expect(renderCallbackPage({ kind: 'save_failed', code: 'x', lang: 'en' }).body).not.toContain('class="code"');
  });

  it('name·code 는 이스케이프한다 — 쿼리·인가 서버에서 온 값이다', () => {
    const evil = `"><script>alert(1)</script><img src=x onerror='a'>&`;
    const p = renderCallbackPage({ kind: 'denied', name: evil, code: evil, lang: 'ko' });
    expect(p.body).not.toContain('<script>alert');
    expect(p.body).not.toContain('<img');
    expect(p.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(p.body).toContain('&quot;&gt;');
    expect(p.body).toContain('&#39;a&#39;');
    // 스크립트 태그는 주소줄 정리 한 줄뿐이다.
    expect(p.body.match(/<script>/g)).toHaveLength(1);
  });

  it('긴 사유 코드는 자른다', () => {
    const p = renderCallbackPage({ kind: 'exchange_failed', code: 'e'.repeat(500), lang: 'en' });
    expect(/<div class="code">(e+)<\/div>/.exec(p.body)![1]).toHaveLength(120);
  });

  it('이름이 없으면 대신할 말을 쓴다', () => {
    expect(renderCallbackPage({ kind: 'denied', lang: 'ko' }).body).toContain('<b>서버</b>에서 접근을');
    expect(renderCallbackPage({ kind: 'denied', name: '  ', lang: 'en' }).body).toContain('<b>the server</b> didn');
  });

  it('헤더 — CSP·no-store·no-referrer·nosniff', () => {
    const { headers } = renderCallbackPage({ kind: 'ok', name: 'x', lang: 'en' });
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toBe(CALLBACK_PAGE_CSP);
    expect(CALLBACK_PAGE_CSP).toContain("default-src 'none'");
    expect(CALLBACK_PAGE_CSP).not.toContain('unsafe-inline');
  });

  it('CSP 해시가 실제 인라인 스타일·스크립트와 맞는다 — 어긋나면 화면이 맨 글자로 뜬다', () => {
    const { body } = renderCallbackPage({ kind: 'expired', lang: 'ko' });
    const h = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
    const style = /<style>([\s\S]*?)<\/style>/.exec(body)![1]!;
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)![1]!;
    expect(CALLBACK_PAGE_CSP).toContain(`style-src ${h(style)}`);
    expect(CALLBACK_PAGE_CSP).toContain(`script-src ${h(script)}`);
    // 주소줄의 code·state 를 지운다.
    expect(script).toContain('history.replaceState');
    // 해시로만 허용하므로 style="" 속성은 막힌다 — 템플릿에 쓰지 않는다.
    expect(body).not.toMatch(/\sstyle=/);
  });

  it('다크는 prefers-color-scheme 로 토큰만 바꾼다', () => {
    const { body } = renderCallbackPage({ kind: 'ok', lang: 'en' });
    expect(body).toContain('@media (prefers-color-scheme:dark)');
    expect(body).toContain('--s:#1c1b19');
  });
});

describe('callbackPageLang — Accept-Language', () => {
  it.each([
    ['ko-KR,ko;q=0.9,en;q=0.8', 'ko'],
    ['ko', 'ko'],
    ['en-US,ko;q=0.9', 'en'],
    ['kok', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ] as const)('%s → %s', (h, lang) => {
    expect(callbackPageLang(h)).toBe(lang);
  });
});
