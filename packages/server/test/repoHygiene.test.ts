import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

function getRoot(): string {
  return ROOT;
}

describe('repo hygiene', () => {
  describe('LICENSE', () => {
    it('exists at root', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      expect(existsSync(licensePath), 'LICENSE file should exist at repository root').toBe(true);
    });

    it('contains Apache License 2.0', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      const content = readFileSync(licensePath, 'utf-8');
      expect(content, 'LICENSE should contain "Apache License"').toContain('Apache License');
      expect(content, 'LICENSE should contain "Version 2.0"').toContain('Version 2.0');
    });

    it('contains copyright notice', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      const content = readFileSync(licensePath, 'utf-8');
      expect(content, 'LICENSE should contain copyright notice').toContain('Copyright 2026 izagood');
    });
  });

  describe('HANDOFF file removal', () => {
    it('HANDOFF-issue-fixes.md does not exist', () => {
      const handoffPath = join(getRoot(), 'HANDOFF-issue-fixes.md');
      expect(existsSync(handoffPath), 'HANDOFF-issue-fixes.md should be deleted').toBe(false);
    });
  });

  describe('README', () => {
    it('headings contain no Korean', () => {
      const readmePath = join(getRoot(), 'README.md');
      const content = readFileSync(readmePath, 'utf-8');
      // /g \ub97c \ubd99\uc774\uba74 test() \uac00 lastIndex \ub97c \ub4e4\uace0 \ub2e4\ub140 \ub450 \ubc88\uc9f8 \ud55c\uae00 \uc81c\ubaa9\uc744 \ub193\uce5c\ub2e4 \u2014 \ubd99\uc774\uc9c0 \ub9c8\ub77c.
      const koreanRegex = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
      const lines = content.split('\n');
      const headingLines = lines.filter(line => /^#{1,6}\s/.test(line));
      const koreanInHeadings = headingLines.filter(line => koreanRegex.test(line));
      expect(
        koreanInHeadings.length,
        `README headings should not contain Korean. Found in: ${koreanInHeadings.join(', ')}`
      ).toBe(0);
    });
  });

  /**
   * **실제 사람의 계정·인프라 정보가 저장소에 남지 않는다** (2026-09-08).
   *
   * 무엇이 있었나: 계정 풀 기능을 만들면서 실측 결과를 설계 문서에 적었고, 그 안에 개발
   * 머신의 **실제 이메일과 조직 이름**이 들어갔다(`docs/specs/2026-09-08-...` 두 줄).
   * PR 본문에도 같은 값이 실렸다. 사용자가 그것을 발견해 지적했다.
   *
   * 왜 회귀선이 필요한가: 그 실수는 **악의 없이, 정확히 좋은 의도에서** 났다 — "실측을
   * 적어라"는 이 저장소의 규율이 값을 그대로 붙이게 만든다. 규율은 유지하고, 값만 못
   * 들어오게 막는 자리가 여기다.
   *
   * 판정은 **도메인**으로 한다. 이름·핸들은 저장소 전체에 정당하게 등장하고(작성자, 브랜치,
   * 커밋, 픽스처의 `handle`) 그것을 금지하면 이 테스트가 자기 근거 때문에 빨개진다. 반면
   * 이메일 도메인과 호스트는 코드·문서에 실제 값으로 있을 이유가 없다.
   *
   * **금지가 아니라 허용으로 센다** (2026-09-08, 두 번째). 사내 주소 한 줄이 설계 문서에
   * 남아 초록으로 통과했다. 첫 수습은 그 호스트를 금지 목록에 적는 것이었는데, 그러자
   * **이 파일이 유출본이 됐다** — 공개 저장소에서 "감출 값 목록"만큼 잘 읽히는 자리가
   * 없다. 사용자가 그것을 지적했다.
   *
   * 그래서 방향을 뒤집었다: 문서·소스에 나오는 **모든** URL 호스트와 이메일 도메인을 모아
   * **예약·예시 도메인과 공개 문서 링크만 통과**시킨다. 이 방향이면 (1) 감출 값을 여기
   * 적지 않아도 되고, (2) 아직 새지 않은 주소까지 걸린다 — 금지 목록은 이미 샌 것만 막는다.
   *
   * 되돌려 RED: 아무 문서에 실제 이메일 한 줄이나 사내 주소 한 줄을 넣으면 빨개진다.
   */
  describe('실제 계정·인프라 정보가 없다', () => {
    /**
     * 통과시키는 도메인. 여기 없는 호스트·이메일 도메인이 나오면 빨개진다.
     * 새 공개 도메인은 **여기 한 줄 추가**로만 들어온다(리뷰에 그대로 드러난다).
     */
    const 허용도메인 = [
      /^localhost$/i,
      /\.localhost$/i,
      /^example\.(?:com|net|org)$/i,
      /\.example\.(?:com|net|org)$/i,
      /\.example$/i, // RFC 2606 예약
      /\.invalid$/i,
      /\.internal$/i, // ICANN 이 사설용으로 예약한 TLD
      /\.[a-z0-9-]*test$/i, // `.test` 와 `avcs.status-test` 처럼 회귀선이 만든 도메인
      // URL 파서·멘션 회귀선이 쓰는 짧은 픽스처 도메인(사람의 것이 아니다).
      /^(?:fizz|[a-z])\.(?:com|io)$/i,
      // 공개 문서·표준 링크.
      /^(?:www\.)?(?:github|nodejs|npmjs|claude|w3)\.(?:com|org)$/i,
      /^schema\.tauri\.app$/i,
      /^developers\.openai\.com$/i,
      /^engineering\.block\.xyz$/i,
    ];

    /** 도메인이 아닌 것들. IP 리터럴은 SSRF 회귀선이 10진·16진 표기까지 쓴다. */
    const 도메인아님 = [
      /^\d{1,3}(?:\.\d{1,3}){3}$/,
      /^\d+$/,
      /^0x[0-9a-f]+$/i,
      /^\[[0-9a-f:.]+\]$/i,
      /[<>{}$]/, // `<host>`·`${base}`·`{{host}}` 자리표시자
      // 호스트 자리가 비었거나 줄인 것: 문서의 `http://...`, 정규식 리터럴 `https?:\/\/\S+`.
      /^\.*$/,
      // 한글이 섞인 호스트는 문서가 뜻으로 쓴 자리표시자다(`http://되돌아간-그-avcs-서버`).
      /[^\x00-\x7f]/,
      // 짧은 단일 레이블(`x`·`app`·`user`)은 픽스처다. 하이픈이 붙은 긴 단일 레이블은
      // 사내 머신 이름의 모양이라 여기서 통과시키지 않는다.
      /^[a-z0-9]{1,5}$/i,
    ];

    // 대괄호 IPv6(`http://[::1]/`)를 먼저 잡는다 — `]` 를 빼고 세면 `[::` 에서 잘린다.
    const URL호스트 = /\bhttps?:\/\/(\[[^\]\s]*\](?::\d*)?|[^\s/?#'"`)\]},\\]*)/gi;
    const 이메일 = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
    /**
     * 조직 이름은 도메인이 아니어서 허용 목록으로 셀 수 없다. 대신 **실측값의 모양**만
     * 본다: `org=Foo-Bar` 처럼 대문자 합성어가 값 자리에 오면 걸린다(첫 사고가 그 모양이다).
     * 픽스처는 `orgName: 'Corp'` 처럼 한 단어를 쓰므로 통과한다.
     */
    const 조직이름실측 = /\borg(?:Name)?['"]?\s*[=:]\s*['"]?[A-Z][a-z]+-[A-Z][a-z]+/;

    /** `icons/128x128@2x.png` 같은 파일 이름이 이메일 모양으로 잡힌다. */
    const 파일이름 = /\.(?:png|jpe?g|svg|webp|gif|ico|css|html|json|md|tsx?)$/i;

    /** `user:pass@host:3400` 에서 호스트만 남긴다. */
    function 호스트만(raw: string): string {
      const 인증뒤 = raw.slice(raw.lastIndexOf('@') + 1);
      return 인증뒤.replace(/:\d*$/, '').replace(/\.$/, '');
    }

    function 통과(도메인: string): boolean {
      return 도메인아님.some((re) => re.test(도메인)) || 허용도메인.some((re) => re.test(도메인));
    }

    function 걸리는주소(text: string): string[] {
      const out: string[] = [];
      for (const m of text.matchAll(URL호스트)) {
        const host = 호스트만(m[1] ?? '');
        if (!통과(host)) out.push(host);
      }
      for (const m of text.matchAll(이메일)) {
        if (파일이름.test(m[0])) continue;
        if (!통과(m[1] ?? '')) out.push(m[0]);
      }
      const org = 조직이름실측.exec(text);
      if (org) out.push(org[0]);
      return out;
    }

    /**
     * **이 파일 자신은 제외한다.** 위 허용 목록과 아래 자기 검사가 여기 살아 있어야 하고,
     * 그러지 않으면 이 회귀선이 자기 근거 때문에 빨개진다.
     *
     * 이제 이 면제가 감추는 것은 **합성된 예시 주소**뿐이다(`acme-corp.net`). 실제 사내
     * 주소를 여기 적을 이유가 사라졌다 — 그것이 허용 방향으로 뒤집은 이유다.
     */
    const 자기자신 = join(getRoot(), 'packages/server/test/repoHygiene.test.ts');

    function 소스와문서(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (['node_modules', 'dist', 'target', '.git'].includes(e.name)) continue;
            walk(full);
          } else if (/\.(ts|tsx|rs|md|json)$/.test(e.name)) {
            out.push(full);
          }
        }
      };
      walk(join(getRoot(), 'packages'));
      walk(join(getRoot(), 'docs'));
      out.push(join(getRoot(), 'README.md'));
      return out;
    }

    it('소스·문서의 호스트·이메일 도메인이 모두 허용 목록 안에 있다', () => {
      const 걸린것: string[] = [];
      for (const file of 소스와문서()) {
        if (file === 자기자신) continue;
        const rel = file.slice(getRoot().length + 1);
        for (const 주소 of 걸리는주소(readFileSync(file, 'utf-8'))) {
          걸린것.push(`${rel}: ${주소}`);
        }
      }
      expect(
        걸린것,
        '허용하지 않은 주소가 저장소에 있다. 공개 도메인이면 `허용도메인` 에 한 줄 더하고,' +
          ' 사내 주소·개인 계정이면 `<host>`·`example.com` 으로 바꾼다:\n' +
          걸린것.join('\n')
      ).toEqual([]);
    });

    it('이 회귀선이 실제로 잡는다 — 예시·자리표시자는 통과하고 실제 모양은 걸린다', () => {
      // 예약·예시 도메인과 자리표시자.
      expect(통과('example.com')).toBe(true);
      expect(통과('app.example')).toBe(true);
      expect(통과('localhost')).toBe(true);
      expect(통과('127.0.0.1')).toBe(true);
      expect(통과('<host>')).toBe(true);
      expect(통과('personal.example')).toBe(true);
      // 사내 주소의 **모양** — 값은 여기 적지 않는다. `acme-corp` 는 합성한 이름이다.
      expect(통과('build-box.vm.dc.acme-corp.net')).toBe(false);
      expect(통과('gateway.acme-corp.net')).toBe(false);
      expect(통과('acme-corp.net')).toBe(false);
      // 사람의 계정 도메인.
      expect(통과('mail-provider.net')).toBe(false);

      // 문서 한 줄에서 실제로 뽑아낸다(포트·자리표시자·파일 이름을 가른다).
      expect(걸리는주소('실측: `http://build-box.vm.dc.acme-corp.net:3400` 의 Projection'))
        .toEqual(['build-box.vm.dc.acme-corp.net']);
      expect(걸리는주소('예시: `http://<host>:3400`, `http://localhost:3400`')).toEqual([]);
      expect(걸리는주소('연락은 me@fizz.com, you@example.com 으로')).toEqual([]);
      expect(걸리는주소('작성자 someone@mail-provider.net')).toEqual(['someone@mail-provider.net']);
      expect(걸리는주소('"icons/128x128@2x.png"')).toEqual([]);
      // 조직 이름은 모양으로 본다 — 픽스처의 한 단어는 통과하고 합성어 실측값은 걸린다.
      expect(걸리는주소("orgName: 'Corp'")).toEqual([]);
      expect(걸리는주소('실측: `org=Acme-Lychee` 로 확인했다')).toEqual(['org=Acme-Lychee']);
    });
  });

  describe('README environment variables table', () => {
    const configDir = join(getRoot(), 'packages');

    // 툴체인이 주는 변수는 README 의 murmur 설정 표에 적을 것이 아니다.
    //
    // `USER` 가 여기 있는 이유(2026-09-08): daemon 이 macOS Keychain 항목을 찾을 때
    // 계정명으로 쓴다(`claude` 가 그 이름으로 저장한다 — 실측). `HOME`·`SHELL` 과 같은
    // 부류로 **OS 가 주는 값이고 murmur 가 설정하는 값이 아니다** — 표에 적으면 사람이
    // 그것을 우리가 읽는 설정 손잡이로 읽는다.
    const TOOLCHAIN_VARS = new Set(['NODE_ENV', 'CI', 'PATH', 'HOME', 'TERM', 'SHELL', 'USER']);

    function collectSourceFiles(dir: string, out: string[]): void {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          collectSourceFiles(full, out);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          out.push(full);
        }
      }
    }

    // `config.ts` 만 보면 `packages/agent/src/version.ts` 의 `AGENT_VERSION` 처럼
    // 다른 파일에서 읽는 변수가 표에서 빠져도 초록으로 지나간다. 그래서 각 패키지의
    // src 와 scripts 디렉터리 전체를 훑는다(test 디렉터리는 제외).
    function extractEnvVars(dir: string): string[] {
      const envVars = new Set<string>();
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        collectSourceFiles(join(dir, entry.name, 'src'), files);
        collectSourceFiles(join(dir, entry.name, 'scripts'), files);
      }
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        for (const match of content.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) {
          if (match[1] && !TOOLCHAIN_VARS.has(match[1])) envVars.add(match[1]);
        }
      }
      return Array.from(envVars).sort();
    }

    it('covers every env var read anywhere under packages/*/src and packages/*/scripts', () => {
      const readmePath = join(getRoot(), 'README.md');
      const readmeContent = readFileSync(readmePath, 'utf-8');

      const configEnvVars = extractEnvVars(configDir);
      // 추출기 자체가 비면 이 회귀선은 아무것도 지키지 못한다 — 최소 개수를 못 박는다.
      expect(configEnvVars.length).toBeGreaterThan(5);

      const missing = [];
      for (const envVar of configEnvVars) {
        const pattern = new RegExp(`\`${envVar}\``);
        if (!pattern.test(readmeContent)) {
          missing.push(envVar);
        }
      }

      expect(
        missing.length,
        `README should document all env vars read from process.env. Missing: ${missing.join(', ')}`
      ).toBe(0);
    });
  });
});