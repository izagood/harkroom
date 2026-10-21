/**
 * 브라우저 인증(OAuth) 이 localhost 콜백으로 돌아왔을 때 사람에게 보여 주는 페이지 — 템플릿 하나.
 *
 * 지금은 원격 MCP 인증(`mcpOAuth.ts`)만 쓴다. provider 로그인 콜백이 생기면 같은 함수를 쓴다.
 *
 * - 색은 데스크톱 `index.css` 의 Paper 토큰 값을 그대로 옮긴다. 다크는 브라우저의
 *   `prefers-color-scheme` 를 따른다(앱의 테마 설정은 브라우저가 모른다).
 * - 외부 폰트·스크립트·이미지는 없다. 스타일·스크립트는 고정 문자열이라 CSP 에 해시로만 허용한다.
 * - 스크립트는 한 줄 — 주소줄에서 `?code=…&state=…` 를 지운다. 캡처·화면 공유에 인증 코드가 찍히지 않게.
 * - `name`·`code` 는 쿼리·인가 서버에서 온 값일 수 있다 → 전부 HTML 이스케이프한다.
 * - 「Harkroom 열기」(딥링크)·자동 닫기는 넣지 않는다: 딥링크 스킴 등록이 없고, 원격 오퍼레이터면
 *   앱이 다른 기계에 있을 수 있다. OS 가 연 탭은 `window.close()` 가 막히기도 한다.
 */
import { createHash } from 'node:crypto';

export type CallbackPageKind =
  | 'ok'               // 토큰을 받아 저장했다
  | 'expired'          // state 불일치 — 만료·다른 시도·이미 끝난 흐름
  | 'denied'           // 인가 서버가 거절했다(error=)·code 가 없다
  | 'exchange_failed'  // 코드 → 토큰 교환이 실패했다
  | 'save_failed';     // 토큰은 받았지만 저장하지 못했다

export type CallbackPageLang = 'ko' | 'en';

export interface CallbackPageInput {
  kind: CallbackPageKind;
  /** 인증한 대상의 이름(MCP 서버 이름 등). 굵게 보인다. */
  name?: string;
  /** 실패 사유 코드(`access_denied` 등). 실패 화면에만 보인다. */
  code?: string;
  lang: CallbackPageLang;
}

export interface CallbackPage {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** `Accept-Language` 의 첫 언어가 ko 면 한국어, 아니면 영어. */
export function callbackPageLang(acceptLanguage: string | string[] | undefined): CallbackPageLang {
  const first = (Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage)?.split(',')[0]?.trim().toLowerCase() ?? '';
  return first === 'ko' || first.startsWith('ko-') ? 'ko' : 'en';
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 사유 코드는 사람이 읽을 한 줄이면 된다 — 인가 서버가 긴 본문을 줘도 자른다. */
const CODE_MAX = 120;

interface Copy { title: string; desc: (name: string) => string }

const COPY: Record<CallbackPageLang, Record<CallbackPageKind, Copy> & { close: string; fallbackName: string }> = {
  ko: {
    ok: { title: '연결됐습니다', desc: (n) => `${n} 인증을 마쳤습니다.<br>Harkroom 앱으로 돌아가면 바로 쓸 수 있습니다.` },
    expired: { title: '인증 시간이 지났습니다', desc: () => '이 링크는 더 이상 쓸 수 없습니다.<br>Harkroom 앱에서 인증을 다시 시작하세요.' },
    denied: { title: '연결하지 못했습니다', desc: (n) => `${n}에서 접근을 허용하지 않았습니다.<br>Harkroom 앱의 설정 › MCP에서 다시 인증하세요.` },
    exchange_failed: { title: '연결하지 못했습니다', desc: (n) => `${n} 서버가 인증을 마무리하지 못했습니다.<br>앱에서 다시 시도하세요.` },
    save_failed: { title: '연결하지 못했습니다', desc: () => '인증은 받았지만 Harkroom이 저장하지 못했습니다.<br>앱에서 다시 시도하세요.' },
    close: '이 탭은 닫아도 됩니다.',
    fallbackName: '서버',
  },
  en: {
    ok: { title: 'Connected', desc: (n) => `Signed in to ${n}.<br>Head back to the Harkroom app — it's ready to use.` },
    expired: { title: 'This sign-in link has expired', desc: () => 'This link can no longer be used.<br>Start the sign-in again from the Harkroom app.' },
    denied: { title: "Couldn't connect", desc: (n) => `${n} didn't grant access.<br>Sign in again from Settings › MCP in the Harkroom app.` },
    exchange_failed: { title: "Couldn't connect", desc: (n) => `${n} couldn't finish the sign-in.<br>Try again from the app.` },
    save_failed: { title: "Couldn't connect", desc: () => 'Sign-in succeeded, but Harkroom couldn\'t save it.<br>Try again from the app.' },
    close: 'You can close this tab.',
    fallbackName: 'the server',
  },
};

const STATUS: Record<CallbackPageKind, number> = { ok: 200, expired: 400, denied: 400, exchange_failed: 400, save_failed: 500 };

// Paper 토큰(packages/desktop/src/index.css) — 라이트 / 다크.
const STYLE = [
  ':root{color-scheme:light dark;--s:#fbfaf8;--r:#fff;--b:#e6e2dc;--f:#1b1a19;--m:#6b665f;--u:#8e8880;--br:#e4572e;--ok:#1b7d45;--oks:#e6f6ec;--bad:#b42318;--bads:#fdecea}',
  '@media (prefers-color-scheme:dark){:root{--s:#1c1b19;--r:#262422;--b:#34312e;--f:#ebe7e2;--m:#9a938b;--u:#7a746c;--br:#ff7a4a;--ok:#5ccf86;--oks:#16301f;--bad:#ff8a80;--bads:#3a1d1b}}',
  '*{box-sizing:border-box}',
  'html,body{height:100%}',
  'body{margin:0;background:var(--s);color:var(--f);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Segoe UI",system-ui,sans-serif;display:grid;place-items:center;padding:32px 16px}',
  '.card{width:100%;max-width:380px;background:var(--r);border:1px solid var(--b);border-radius:14px;padding:28px 26px 22px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}',
  '.logo{display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px;letter-spacing:-.01em;margin-bottom:22px}',
  '.logo svg{width:22px;height:22px}.logo .c{stroke:var(--br)}',
  '.st{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px}',
  '.st.ok{background:var(--oks);color:var(--ok)}.st.bad{background:var(--bads);color:var(--bad)}',
  '.st svg{width:24px;height:24px}',
  'h1{font-size:18px;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}',
  '.d{color:var(--m);margin:0;font-size:14px;overflow-wrap:anywhere}',
  '.d b{color:var(--f);font-weight:600}',
  '.code{margin:14px auto 0;display:inline-block;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--u);border:1px solid var(--b);border-radius:6px;padding:2px 8px;max-width:100%;overflow-wrap:anywhere}',
  '.ft{margin-top:22px;padding-top:14px;border-top:1px solid var(--b);font-size:12.5px;color:var(--u)}',
].join('\n');

// 주소줄에서 쿼리(code·state)를 지운다. 경로는 그대로 둔다.
const SCRIPT = "history.replaceState(null,'',location.pathname);";

const hash = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** 스타일·스크립트는 고정 문자열이라 해시로만 허용한다 — 이스케이프가 새도 주입된 것은 돌지 않는다. */
export const CALLBACK_PAGE_CSP = [
  "default-src 'none'",
  `style-src ${hash(STYLE)}`,
  `script-src ${hash(SCRIPT)}`,
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const LOGO = '<svg viewBox="0 0 128 128" aria-hidden="true"><g stroke="currentColor" stroke-width="10" stroke-linecap="round"><path d="M20 52V76M35 42V86M50 31V97M80 33V95M95 45V83M110 53V75"/></g><path class="c" d="M65 18V110" stroke-width="10" stroke-linecap="round"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_BAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

export function renderCallbackPage(input: CallbackPageInput): CallbackPage {
  const copy = COPY[input.lang];
  const c = copy[input.kind];
  const name = `<b>${esc(input.name?.trim() || copy.fallbackName)}</b>`;
  const icon = input.kind === 'ok' ? ICON_OK : input.kind === 'expired' ? ICON_CLOCK : ICON_BAD;
  const showCode = (input.kind === 'denied' || input.kind === 'exchange_failed') && input.code;
  const code = showCode ? `<div class="code">${esc(input.code!.slice(0, CODE_MAX))}</div>` : '';
  const body = `<!doctype html>
<html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(c.title)} · Harkroom</title>
<style>${STYLE}</style></head>
<body><main class="card" data-kind="${input.kind}">
<div class="logo">${LOGO}Harkroom</div>
<div class="st ${input.kind === 'ok' ? 'ok' : 'bad'}">${icon}</div>
<h1>${esc(c.title)}</h1>
<p class="d">${c.desc(name)}</p>
${code}<div class="ft">${esc(copy.close)}</div>
</main><script>${SCRIPT}</script></body></html>
`;
  return {
    status: STATUS[input.kind],
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CALLBACK_PAGE_CSP,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
    body,
  };
}
