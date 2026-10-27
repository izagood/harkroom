import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * 초대 메일의 안내 링크가 여는 페이지(`GET /join#<토큰>`).
 *
 * **이 페이지는 가입하지 않는다.** 서버 주소와(조각 `#` 뒤의) 토큰을 보여 주고 복사하게 하며, 앱을 받는 곳을
 * 알려 줄 뿐이다. 그래서 메일 보안 스캐너가 링크를 미리 열어도 토큰이 쓰이지 않고, 토큰은 조각이라 이 요청에
 * 실려 오지도 않는다 — 서버·프록시 로그에 남지 않는다.
 *
 * 스크립트는 인라인 하나뿐이고 CSP 가 그 해시만 허락한다. 토큰은 `textContent` 로만 넣는다(마크업이 될 길 없음).
 * `Referrer-Policy: no-referrer` — 받기 링크를 눌러도 이 주소가 넘어가지 않는다(조각은 원래 안 넘어가지만 겹으로 막는다).
 */
const SCRIPT = `
(function () {
  var token = decodeURIComponent((location.hash || '').slice(1));
  var server = location.origin;
  document.getElementById('server').textContent = server;
  var t = document.getElementById('token');
  if (/^hrki_[A-Za-z0-9_-]+$/.test(token)) { t.textContent = token; }
  else { document.getElementById('tokenRow').hidden = true; document.getElementById('noToken').hidden = false; }
  document.querySelectorAll('button[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = document.getElementById(b.getAttribute('data-copy')).textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(function () { b.textContent = b.getAttribute('data-done'); });
    });
  });
})();
`;

const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Join Harkroom</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--sub:#666;--box:#fff;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--sub:#aaa;--box:#222;--line:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:48px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--sub);margin:0 0 16px}
.row{background:var(--box);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 12px}
.label{font-size:12px;color:var(--sub)}code{display:block;word-break:break-all;font-size:14px;margin:2px 0 6px}
button{font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
ol{padding-left:20px;color:var(--sub)}a{color:inherit}
</style></head><body><main>
<h1>Join Harkroom · Harkroom 가입</h1>
<p>You were invited to this workspace. · 이 워크스페이스에 초대받았습니다.</p>
<div class="row"><div class="label">Server address · 서버 주소</div><code id="server"></code>
<button type="button" data-copy="server" data-done="Copied · 복사함">Copy · 복사</button></div>
<div class="row" id="tokenRow"><div class="label">Invite token · 초대 토큰</div><code id="token"></code>
<button type="button" data-copy="token" data-done="Copied · 복사함">Copy · 복사</button></div>
<p id="noToken" hidden>No invite token in this link. Open the link from your invite email again. · 이 링크에 초대 토큰이 없습니다. 초대 메일의 링크를 다시 여세요.</p>
<ol>
<li>Install the app: <a href="https://github.com/izagood/harkroom/releases" rel="noopener noreferrer">Harkroom releases</a> · 앱 설치</li>
<li>Open it, enter the server address, and choose Sign up. · 앱을 열고 서버 주소를 넣은 뒤 「가입」을 고르세요.</li>
<li>Paste the invite token. It works once and expires. · 초대 토큰을 붙여 넣으세요. 한 번만 쓰이고 기한이 있습니다.</li>
</ol>
</main><script>${SCRIPT}</script></body></html>`;

export function registerJoinPage(app: FastifyInstance): void {
  app.get('/join', async (_req, reply) => {
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy',
        `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(HTML);
  });
}
