// harkroom.com 소개 페이지를 굽는다: `node build.mjs` → `dist/`.
//
// 정적 파일 한 벌이다(프레임워크·의존성 없음). 영어(`/`)와 한국어(`/ko/`) 두 쪽의 마크업이
// 같아야 하므로 틀 하나에 말만 바꿔 끼운다 — 손으로 두 벌을 두면 한쪽만 고쳐지는 날이 온다.
// 시안: designer v2(2026-09-30 jaebin 승인).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

const ORIGIN = 'https://harkroom.com';
const REPO = 'https://github.com/izagood/harkroom';
const LINKS = {
  repo: REPO,
  install: `${REPO}#getting-started`,
  mac: `${REPO}/releases/latest`,
  releases: `${REPO}/releases`,
  security: `${REPO}/security/policy`,
  // 호스팅 워크스페이스는 초대받은 사람만 만든다(homelab 자원이 적다). 초대 코드는 앱의
  // "워크스페이스 만들기"에 넣으므로, 이 링크는 앱을 받고 로그인하는 안내로 간다.
  invite: `${REPO}#2-install-the-app-and-sign-in`,
};
const INSTALL = ['git clone https://github.com/izagood/harkroom', 'cd harkroom', 'docker compose up -d'];

const LOGO = `<svg viewBox="0 0 128 128" aria-hidden="true"><g stroke-width="11" stroke-linecap="round" fill="none" stroke="currentColor"><path d="M20 52V76"/><path d="M35 42V86"/><path d="M50 31V97"/><path d="M65 18V110" stroke="var(--brand)"/><path d="M80 33V95"/><path d="M95 45V83"/><path d="M110 53V75"/></g></svg>`;
const GH = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>`;
const LAPTOP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`;
const SERVER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`;

const T = {
  en: {
    path: '/',
    title: 'Harkroom — Mention an agent. Watch it work.',
    desc: 'The team chat where people and AI agents share channels. Open source and self-hosted.',
    skip: 'Skip to content',
    nav: ['Features', 'Install', 'GitHub'], installBtn: 'Install',
    h1: '<span class="m">Mention</span><br>an agent.<br>Watch it work.',
    sub: 'The team chat where people and AI agents share channels.',
    cta1: 'Install from GitHub', cta2: 'Download for macOS',
    mnote: 'Get the Mac app from your desktop.',
    invite: 'Have an invite code?', inviteLink: 'Go to your workspace →',
    appLabel: 'The Harkroom app: a person mentions the agent forge in #design, forge posts progress and asks a question, and its live terminal runs alongside.',
    ch: ['general', 'design', 'infra'], agents: 'Agents',
    thread: 'Login screen contrast',
    m1: '<span class="mention">@forge</span> the login button label is hard to read in dark mode. Can you fix it?',
    kP: 'Progress', kQ: 'Ask · for you', kD: 'Done',
    p1: 'Found 3 low-contrast colors. Fixing them now.',
    q1: 'Change the button hover color too?', o1: 'Change it too', o2: 'Leave it',
    compose: 'Message #design',
    termT: 'terminal', live: 'live', take: 'Take the keyboard',
    tWait: 'Sent a question. Waiting for an answer',
    b1h: 'Mention it. It answers in the thread.', b1p: 'Mention an agent and it reads the thread, does the work, and replies right there. Mention a team and its lead splits the work.',
    teamL: 'Design team · lead forge',
    b2h: 'It calls you only to decide', b2p: 'Progress stays quiet. Questions for you turn orange. You can see what is waiting on you without reading the whole scroll.',
    d1: 'Opened PR #1024. Contrast 4.86:1',
    b3h: 'Your tools, your machines', b3p: 'Claude Code, Codex or opencode, on your laptop or an always-on box you register. Mention from your phone and it still answers.',
    m1h: 'My MacBook', m2h: 'Always-on server',
    insH: 'Run it today', insP: 'Start one server, and your team connects with the app.',
    guide: 'Read the setup guide', copy: 'Copy', copied: 'Copied',
    foot: 'Open source · Apache 2.0', fl: ['GitHub', 'Releases', 'Security'],
    other: { lang: 'ko', path: '/ko/', label: '한국어' },
  },
  ko: {
    path: '/ko/',
    title: 'Harkroom — @멘션하면, 에이전트가 일합니다',
    desc: '사람과 AI 에이전트가 같은 채널을 쓰는 팀 채팅입니다. 오픈소스이고 직접 띄워 씁니다.',
    skip: '본문으로 건너뛰기',
    nav: ['기능', '설치', 'GitHub'], installBtn: '설치하기',
    h1: '<span class="m">@멘션</span>하면,<br>에이전트가<br>일합니다',
    sub: '사람과 AI 에이전트가 같은 채널을 쓰는 팀 채팅입니다.',
    cta1: 'GitHub에서 설치하기', cta2: 'macOS 앱 받기',
    mnote: 'Mac 앱은 데스크톱에서 받을 수 있어요.',
    invite: '초대 코드가 있나요?', inviteLink: '초대받은 워크스페이스로 →',
    appLabel: 'Harkroom 앱 화면: #design 채널에서 사람이 에이전트 forge 를 멘션하고, forge 가 진행을 알리고 질문하며, 옆에서 실시간 터미널이 돈다.',
    ch: ['general', 'design', 'infra'], agents: '에이전트',
    thread: '로그인 화면 대비',
    m1: '<span class="mention">@forge</span> 로그인 버튼 글자가 다크 모드에서 잘 안 보여. 고쳐 줄래?',
    kP: '진행', kQ: '질문 · 나에게', kD: '완료',
    p1: '대비가 낮은 색 3개를 찾았어요. 고치는 중입니다.',
    q1: '버튼 hover 색도 같이 바꿀까요?', o1: '같이 바꾸기', o2: '이번엔 빼기',
    compose: '#design 에 메시지 보내기',
    termT: '터미널', live: '실시간', take: '키보드 넘겨받기',
    tWait: '질문을 보냈어요. 답을 기다리는 중',
    b1h: '부르면, 그 스레드에서 답합니다', b1p: '채널에서 @멘션하면 에이전트가 스레드를 읽고 일한 뒤 같은 자리에 답합니다. 팀을 부르면 리더가 나눠 맡깁니다.',
    teamL: '디자인 팀 · 리더 forge',
    b2h: '결정할 때만 당신을 부릅니다', b2p: '진행은 조용히, 질문은 주황으로. 무엇이 나를 기다리는지 스크롤을 다 읽지 않아도 보입니다.',
    d1: 'PR #1024를 열었어요. 대비 4.86:1',
    b3h: '쓰던 도구로, 내 머신에서', b3p: '노트북이든 늘 켜 둔 서버든, 등록한 머신에서 Claude Code · Codex · opencode가 돌아갑니다. 폰에서 불러도 답합니다.',
    m1h: '내 MacBook', m2h: '늘 켜 둔 서버',
    insH: '오늘 바로 띄워 보세요', insP: '서버 하나 띄우고 팀은 앱으로 접속하면 됩니다.',
    guide: '설치 안내 보기', copy: '복사', copied: '복사됨',
    foot: '오픈소스 · Apache 2.0', fl: ['GitHub', '릴리스', '보안'],
    other: { lang: 'en', path: '/', label: 'English' },
  },
};

/** 로고 막대를 크게 편 파형. 가운데 막대만 주황이다. */
function waveBars() {
  const n = 41, mid = 20;
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = (i - mid) / mid;
    const h = Math.max(10, Math.round(Math.cos((x * Math.PI) / 2) ** 1.4 * 100 * (0.78 + 0.22 * Math.cos(i * 1.7))));
    s += `<b${i === mid ? ' class="c"' : ''} style="height:${i === mid ? 100 : h}%;--i:${Math.abs(i - mid)}"></b>`;
  }
  return s;
}

const ext = (href, body, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${href}" rel="noopener">${body}</a>`;

function page(lang) {
  const t = T[lang];
  const langSwitch = lang === 'ko' ? '<b>한</b> / EN' : '한 / <b>EN</b>';
  const invite = `<p class="invite">${t.invite} ${ext(LINKS.invite, t.inviteLink)}</p>`;
  const askCard = `<div class="card q"><div class="kind">${t.kQ}</div>${t.q1}<div class="opts"><span class="opt pri">${t.o1}</span><span class="opt">${t.o2}</span></div></div>`;
  const progCard = `<div class="card p"><div class="kind">${t.kP}</div>${t.p1}</div>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<meta name="description" content="${t.desc}">
<link rel="canonical" href="${ORIGIN}${t.path}">
<link rel="alternate" hreflang="en" href="${ORIGIN}/">
<link rel="alternate" hreflang="ko" href="${ORIGIN}/ko/">
<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Harkroom">
<meta property="og:title" content="${t.title}">
<meta property="og:description" content="${t.desc}">
<meta property="og:url" content="${ORIGIN}${t.path}">
<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#18181b" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<script src="/site.js"></script>
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header class="wrap"><nav class="nav">
  <a class="logo" href="${t.path}">${LOGO}Harkroom</a>
  <div class="nav-links"><a href="#features">${t.nav[0]}</a><a href="#install">${t.nav[1]}</a>${ext(LINKS.repo, t.nav[2])}</div>
  <div class="nav-end"><a class="lang" href="${t.other.path}" data-lang="${t.other.lang}" hreflang="${t.other.lang}" aria-label="${t.other.label}">${langSwitch}</a><a class="btn btn-sm btn-primary" href="#install">${t.installBtn}</a></div>
</nav></header>

<main id="main">
<section class="hero"><div class="wrap">
  <div class="hero-top">
    <h1 class="h1">${t.h1}</h1>
    <div class="hero-side">
      <p>${t.sub}</p>
      <div class="ctas">
        ${ext(LINKS.install, `${GH}${t.cta1}`, 'btn btn-primary')}
        ${ext(LINKS.mac, t.cta2, 'btn btn-ghost only-d')}
      </div>
      <p class="invite only-m">${t.mnote}</p>
      ${invite}
    </div>
  </div>
  <div class="stagebox">
    <div class="wave" aria-hidden="true">${waveBars()}</div>
    <div class="app" role="img" aria-label="${t.appLabel}">
      <div class="app-bar"><i></i><i></i><i></i></div>
      <div class="app-body">
        <div class="side">
          <div class="ws">acme</div>
          <div class="grp">${t.ch.map((c) => `<div class="row${c === 'design' ? ' on' : ''}"># ${c}${c === 'design' ? '<span class="n">1</span>' : ''}</div>`).join('')}</div>
          <div class="grp"><div class="lbl">${t.agents}</div>
            <div class="row"><span class="dot run"></span>forge</div>
            <div class="row"><span class="dot done"></span>scout</div>
            <div class="row"><span class="dot"></span>review</div>
          </div>
        </div>
        <div class="main">
          <div class="main-h"><b># design</b><span>${t.thread}</span></div>
          <div class="msgs">
            <div class="msg"><div class="av">S</div><div><div class="who">sora <span>10:02</span></div><div>${t.m1}</div></div></div>
            <div class="msg"><div class="av a">F</div><div>
              <div class="who">forge <span>10:03</span></div>
              ${progCard}
              ${askCard}
            </div></div>
          </div>
          <div class="composer">${t.compose}</div>
        </div>
        <div class="term">
          <div class="term-h"><b>forge</b> ${t.termT}<span class="live">${t.live}</span></div>
          <pre><span class="d">$</span> claude
<span class="d">›</span> read src/index.css
<span class="d">›</span> grep "fg-on-strong"
<span class="g">✓</span> 3 matches · 2 files
<span class="d">›</span> contrast 3.38 → <span class="h">4.86</span>
<span class="d">›</span> edit src/index.css  <span class="g">+3</span> <span class="h">−3</span>
<span class="d">…</span> ${t.tWait}
<span class="caret"></span></pre>
          <span class="term-take">${t.take}</span>
        </div>
      </div>
    </div>
  </div>
</div></section>

<div class="wrap"><div class="blocks" id="features">
  <section class="blk">
    <div class="blk-t"><h2 class="h2">${t.b1h}</h2><p>${t.b1p}</p></div>
    <div class="pic" aria-hidden="true"><div class="mentionbox">
      <div class="pop">
        <div class="it on"><div class="av a">F</div>forge<small>claude</small></div>
        <div class="it"><div class="av a">S</div>scout<small>codex</small></div>
        <div class="it"><div class="av a">R</div>review<small>opencode</small></div>
        <div class="it"><div class="av t">D</div>${t.teamL}</div>
      </div>
      <div class="inbox"><span class="mention">@</span><span class="caret"></span></div>
    </div></div>
  </section>

  <section class="blk flip">
    <div class="blk-t"><h2 class="h2">${t.b2h}</h2><p>${t.b2p}</p></div>
    <div class="pic" aria-hidden="true"><div class="stack">
      ${progCard}
      ${askCard}
      <div class="card d"><div class="kind">${t.kD}</div>${t.d1}</div>
    </div></div>
  </section>

  <section class="blk">
    <div class="blk-t"><h2 class="h2">${t.b3h}</h2><p>${t.b3p}</p></div>
    <div class="pic" aria-hidden="true"><div class="machines">
      <div class="mach">${LAPTOP}<h3>${t.m1h}</h3><div class="chips">
        <div class="chip"><span class="dot run"></span>forge<small>claude</small></div>
        <div class="chip"><span class="dot"></span>review<small>opencode</small></div></div></div>
      <div class="mach">${SERVER}<h3>${t.m2h}</h3><div class="chips">
        <div class="chip"><span class="dot done"></span>scout<small>codex</small></div>
        <div class="chip"><span class="dot run"></span>ops<small>claude</small></div></div></div>
    </div></div>
  </section>
</div></div>

<section class="install" id="install"><div class="wrap"><div class="install-in">
  <div class="install-t">
    <h2 class="h2">${t.insH}</h2><p>${t.insP}</p>
    <div class="ctas">${ext(LINKS.install, `${GH}${t.guide}`, 'btn btn-primary')}${ext(LINKS.mac, t.cta2, 'btn btn-ghost only-d')}</div>
    ${invite}
  </div>
  <div class="code"><button class="copy" type="button" data-copy data-copied="${t.copied}">${t.copy}</button><code>${INSTALL.map((l) => `<span class="d">$ </span>${l}`).join('\n')}</code></div>
</div></div></section>
</main>

<footer class="foot"><div class="wrap">
  <a class="logo" href="${t.path}">${LOGO}Harkroom</a><span>${t.foot}</span>
  <span class="r">${ext(LINKS.repo, t.fl[0])}${ext(LINKS.releases, t.fl[1])}${ext(LINKS.security, t.fl[2])}<a href="${t.other.path}" data-lang="${t.other.lang}" hreflang="${t.other.lang}">${t.other.label}</a></span>
</div></footer>
</body>
</html>
`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'ko'), { recursive: true });
writeFileSync(join(out, 'index.html'), page('en'));
writeFileSync(join(out, 'ko', 'index.html'), page('ko'));
for (const f of ['site.css', 'site.js', 'favicon.svg', 'robots.txt']) cpSync(join(here, 'src', f), join(out, f));
console.log(`built ${out}`);
