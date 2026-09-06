import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 앱 내부 업데이트의 **설정·워크플로 쪽 회귀선**.
 *
 * 화면 쪽 회귀선은 `src/components/settings/UpdatesSettings.test.tsx` 에 있다.
 * 여기서 재는 것은 "빌드와 릴리즈가 업데이트를 실제로 내보낼 수 있는 상태인가"다 —
 * 이것들은 화면을 아무리 잘 만들어도 빠지면 업데이트가 **한 번도 성공하지 못하는**
 * 자리이고, 빠졌다는 사실이 릴리즈가 나간 뒤에야 드러난다.
 */

// `import.meta.url` 은 jsdom 환경에서 file: 스킴이 아니라 못 쓴다. vitest 는 패키지
// 디렉터리를 cwd 로 돌리므로 거기서 짚는다(`vite.config.ts` 도 같은 파일을 읽는다).
const conf = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
) as {
  bundle: { targets: string[]; createUpdaterArtifacts?: boolean };
  plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
};

const workflow = readFileSync(
  resolve(process.cwd(), '../../.github/workflows/release.yml'),
  'utf8',
);

const ci = readFileSync(resolve(process.cwd(), '../../.github/workflows/ci.yml'), 'utf8');

describe('업데이터 설정(tauri.conf.json)', () => {
  /**
   * 공개키가 없으면 플러그인이 서명을 **검증할 수단이 없다**. tauri 는 이 값이 비면
   * 초기화에서 거절하므로 앱이 업데이트를 아예 못 하게 된다 — 조용한 실패가 아니라
   * 기능 부재다.
   */
  it('업데이터 공개키가 박혀 있다', () => {
    const pubkey = conf.plugins?.updater?.pubkey;
    expect(pubkey, '공개키가 없으면 서명 검증을 할 수 없다').toBeTruthy();
    // minisign 공개키는 base64 안에 "untrusted comment: minisign public key" 를 담는다.
    // 길이만 재면 아무 문자열이나 통과하므로 실제로 풀어서 형태를 본다.
    const decoded = Buffer.from(pubkey!, 'base64').toString('utf8');
    expect(decoded).toContain('minisign public key');
  });

  /**
   * endpoints 가 없으면 앱이 **어디에 물어볼지 모른다**. `latest.json` 은 릴리즈의
   * `latest/download` 경로에 올라가고, 그 경로는 `finalize` 가 `make_latest` 로
   * 못박는 릴리즈를 따라간다.
   */
  it('endpoints 가 릴리즈의 latest.json 을 가리킨다', () => {
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints[0]).toContain('latest.json');
  });

  /**
   * `createUpdaterArtifacts` 가 꺼져 있으면 `tauri build` 가 `.app.tar.gz` 를 만들지
   * 않는다. 워크플로가 그것을 **다시** 만들긴 하지만, 이 플래그는 tauri 가 updater
   * 타깃을 인식하는 스위치이기도 하다.
   */
  it('createUpdaterArtifacts 가 켜져 있다', () => {
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
  });

  /**
   * `#494` 가 `["app", "dmg"]` 로 좁혔던 자리다. 근거는 "updater 가 없다"였고 그 전제는
   * 바뀌었지만, **`targets` 는 그대로 둔다** — `"updater"` 는 여기에 넣을 수 있는 값이
   * 아니다(`tauri-utils` 의 `BundleType` 에 그런 변형이 없어 빌드가 죽는다). updater
   * 산출물의 스위치는 위의 `createUpdaterArtifacts` 하나뿐이다.
   *
   * 그래서 이 회귀선은 **넣지 말아야 할 것이 안 들어갔는지**를 잰다.
   */
  it('bundle.targets 는 app·dmg 뿐이다 — updater 는 타깃이 아니다', () => {
    expect(conf.bundle.targets).toContain('app');
    expect(conf.bundle.targets).toContain('dmg');
    // 넣으면 `tauri build` 가 설정 파싱 단계에서 죽는다. 켜는 스위치는
    // `createUpdaterArtifacts` 이지 이 목록이 아니다.
    expect(conf.bundle.targets).not.toContain('updater');
  });
});

describe('릴리즈 워크플로(release.yml)', () => {
  /**
   * 키를 안 넘기면 `tauri signer sign` 이 서명을 만들지 못한다. 서명 없는
   * `.app.tar.gz` 는 앱이 **거부한다**(공개키가 박혀 있으므로) — 올려 봐야 쓸모가 없다.
   */
  it('빌드에 업데이터 서명 키를 넘긴다', () => {
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  });

  /**
   * **이 회귀선이 이 파일의 핵심이다.**
   *
   * `finalize` 가 `.dmg` 만 보면, 업데이터 산출물이 통째로 빠져도 릴리즈가 공개된다.
   * 그러면 이미 깔린 앱은 `latest.json` 을 못 찾아 "확인 실패"만 반복하고, 사람은
   * 앱이 고장 났다고 생각한다 — 릴리즈에 파일이 빠졌다고는 생각하지 않는다.
   */
  it('finalize 가 업데이터 산출물을 검증한다', () => {
    // **`expected=(...)` 목록 자체를 떼어 본다.**
    //
    // 처음에는 `finalize` 잡 본문 전체에서 문자열을 찾았는데, 그것으로는 **되돌려도
    // 빨개지지 않았다**(실측 2026-09-07): 같은 잡이 `latest.json` 을 *만들기도* 해서
    // 검증 목록을 `.dmg` 하나로 좁혀도 `latest.json`·`tarball` 이라는 낱말이 생성
    // 코드 쪽에 그대로 남아 통과했다. 검증 목록이 재려는 것은 "**무엇을 필수로
    // 요구하는가**"이므로, 그 목록만 잘라서 봐야 한다.
    const finalize = workflow.slice(workflow.indexOf('\n  finalize:'));
    const start = finalize.indexOf('expected=(');
    expect(start, 'finalize 의 필수 자산 목록(expected=(...))이 없다').toBeGreaterThan(-1);
    const list = finalize.slice(start, finalize.indexOf('\n          )', start));

    expect(list).toContain('.dmg');
    // **tarball 은 `$tarball` 이라는 셸 변수로 적혀 있다** — 목록 안에 `app.tar.gz` 라는
    // 낱말 자체는 없다. 그래서 그 낱말을 찾으면 되돌리지 않아도 빨개진다(실측
    // 2026-09-07). 변수가 실제로 그 파일 이름을 담는지는 바로 아래에서 따로 잰다.
    expect(list).toContain('"$tarball"');
    // `.sig` 까지 봐야 한다 — tarball 만 있고 서명이 없으면 앱이 설치를 거부한다.
    expect(list).toContain('"$tarball.sig"');
    expect(list).toContain('latest.json');

    // 그 `$tarball` 이 정말 `.app.tar.gz` 를 가리키는지 본다. 이것이 없으면 위 두 줄은
    // "이름 모를 변수 두 개를 요구한다"밖에 재지 못한다.
    expect(finalize).toMatch(/tarball="[^"]*\.app\.tar\.gz"/);
  });

  /**
   * `.app.tar.gz` 는 **공증된 `.app`** 을 담아야 한다.
   *
   * `tauri build` 가 만든 것은 공증 **전**의 `.app` 스냅숏이다(tauri-bundler 의
   * `bundle_update_macos` 가 `.app` 디렉터리를 그대로 tar 한다). `.dmg` 가 `#500` 에서
   * 겪은 것과 같은 순서 문제라, 공증 뒤에 다시 만들어야 한다.
   */
  /**
   * ## 빌드 단계에도 서명 키가 필요하다 (실측 2026-09-06, `v0.1.1` 실패)
   *
   * `createUpdaterArtifacts: true` 라 `tauri build` 가 `.app.tar.gz` 를 만들고 **그 자리에서
   * 바로 서명한다.** 공개키만 있고 개인키가 없으면 번들링을 마친 직후
   * `A public key has been found, but no private key` 로 죽는다.
   *
   * 아래 tarball 재서명 단계에도 같은 키가 있지만 **그것으로는 늦다** — 빌드가 먼저
   * 실패한다. 첫 자동 릴리즈가 정확히 그렇게 죽었다.
   *
   * **되돌려 RED**: 빌드 단계의 `env:` 블록을 지우면 빨개진다.
   */
  it('빌드 단계에 업데이터 서명 키를 넘긴다', () => {
    // `- name:` 부터 **다음 `- name:`** 까지를 그 단계로 본다 — `run:` 까지만 자르면
    // 그 앞에 오는 `env:` 블록이 잘려 나가 정작 재려던 것을 못 본다.
    const build = workflow.match(/- name: 앱을 빌드한다[\s\S]*?(?=\n\s+(?:#|- name:))/)?.[0] ?? '';
    expect(build, '빌드 단계를 찾지 못했다').not.toBe('');
    expect(build, '빌드가 .app.tar.gz 를 서명하려는데 키가 없으면 그 자리에서 죽는다')
      .toContain('TAURI_SIGNING_PRIVATE_KEY');
  });

  /**
   * ## checkout 없는 잡에서 `gh` 는 저장소를 추론하지 못한다 (실측 2026-09-06, `v0.1.1`)
   *
   * `finalize` 에는 `actions/checkout` 이 없다 — 산출물을 열지 않고 API 만 쓰기 때문이다.
   * 그래서 git 저장소가 없고, `gh release ...` 는 리모트를 추론하다
   * `fatal: not a git repository` 로 죽는다.
   *
   * 그 잡의 `gh api` 들은 `$GITHUB_REPOSITORY` 를 명시해 이 함정을 피한다. 새로 추가되는
   * `gh` 호출도 같은 규칙을 따라야 하는데, `latest.json` 업로드 줄이 그것을 빠뜨려
   * 빌드·서명·공증을 다 통과한 릴리즈가 **마지막 단계에서** 죽었다.
   *
   * **되돌려 RED**: `--repo` 를 지우면 빨개진다.
   */
  it('finalize 의 gh 호출이 저장소를 명시한다', () => {
    const fin = workflow.match(/^  finalize:[\s\S]*$/m)?.[0] ?? '';
    expect(fin, 'finalize 잡을 찾지 못했다').not.toBe('');
    // `gh release` 호출을 하나씩 잘라 **각각** `--repo` 를 갖는지 본다.
    // 부정 전방탐색으로 한 번에 재려다 실패했다 — 여러 줄에 걸친 호출에서 경계가 흐려져
    // 멀쩡한 코드에도 걸린다. 세는 쪽이 무엇을 재는지 분명하다.
    // **주석 줄을 먼저 걷어낸다.** 이 워크플로는 근거를 길게 적어서 주석 안에도
    // `gh release` 가 등장한다 — 그것까지 세면 "설명한 것"이 "실행하는 것"으로 잡힌다.
    const code = fin.replace(/^\s*#.*$/gm, '');
    const calls = code.match(/gh release[\s\S]*?(?=\n\s*(?:[a-z_]+=|gh |echo |fi\b|if\b))/g) ?? [];
    for (const c of calls) {
      expect(c, `--repo 가 없다: ${c.slice(0, 60)}`).toContain('--repo');
    }
  });

  it('공증 뒤에 updater 산출물을 다시 만든다', () => {
    // **`- name:` 으로 짚는다.** 그냥 문구를 찾으면 이 파일 위쪽 설명 주석이 먼저
    // 걸려서, 실제 단계가 어디 있든 통과해 버린다(이 회귀선을 처음 쓸 때 실제로
    // 그렇게 헛통과했다 — 주석이 공증 단계보다 앞이라 순서 비교가 뒤집혔다).
    const rebuild = workflow.indexOf('- name: 공증된 앱으로 updater 산출물을 다시 만든다');
    const notarize = workflow.indexOf('- name: 앱을 공증한다');
    expect(rebuild, 'updater 산출물을 다시 만드는 단계가 없다').toBeGreaterThan(-1);
    expect(notarize).toBeGreaterThan(-1);
    // **순서가 요점이다.** 공증보다 앞에서 만들면 공증 안 된 앱이 담긴다.
    expect(rebuild).toBeGreaterThan(notarize);
    // 담기 전에 티켓이 실제로 박혀 있는지 보는 자리가 있어야 한다.
    const step = workflow.slice(rebuild, workflow.indexOf("- name: draft 릴리즈에 올린다", rebuild));
    expect(step).toContain('stapler validate');
  });
});

/**
 * ## PR 검증 빌드는 **서명 개인키 없이도** 통과해야 한다
 *
 * `ci.yml` 의 `macos-build` 는 "macOS 에서 앱이 실제로 빌드되는가"만 묻고 시크릿을
 * 받지 않는다. 그런데 `tauri.conf.json` 에 `createUpdaterArtifacts` 를 켜자 그 잡이
 * 죽었다(실측 2026-09-07):
 *
 *   `Error A public key has been found, but no private key.`
 *
 * `--bundles app` 으로 `.app` 만 만들라고 해도 그 플래그는 `.app.tar.gz` 를 만들고,
 * 만들고 나면 서명하려 들기 때문이다. **`--bundles` 와 `createUpdaterArtifacts` 는
 * 서로 다른 스위치다.**
 *
 * ## 왜 `actionlint` 로는 안 잡히는가
 *
 * 이것은 문법 오류가 아니라 **두 파일의 합의**다 — `tauri.conf.json` 이 켠 것을
 * `ci.yml` 이 꺼야 한다는 약속이고, 어느 쪽 파일도 혼자서는 틀리지 않았다.
 * `#500` 에서 같은 교훈이 있었고 그때도 워크플로 파일을 읽는 테스트로 내렸다.
 *
 * **개인키를 그 잡에 넘기는 것으로 고치지 않는다**: fork PR 에는 시크릿이 가지 않아
 * 외부 기여자마다 빨간 X 가 되고, 배포용 키가 닿는 표면만 넓어진다. 그래서 이
 * 회귀선은 "키를 넘겼는가"가 아니라 **"키가 필요 없는 상태를 유지하는가"** 를 잰다.
 */
describe('PR 검증 빌드(ci.yml)는 서명 키를 요구하지 않는다', () => {
  it('updater 산출물을 꺼서 빌드한다', () => {
    // `>` 블록으로 줄이 이어질 수 있으므로 명령 근처를 통째로 본다.
    const at = ci.indexOf('tauri build --bundles app');
    expect(at, 'macos-build 의 tauri build 호출을 찾지 못했다').toBeGreaterThan(-1);
    const command = ci.slice(at, at + 300);

    // `--config` 로 얹어서 끈다. `tauri.conf.json` 자체는 켠 채로 둬야 한다 —
    // 릴리즈는 그 파일을 그대로 읽어 진짜 키로 서명한다.
    expect(command).toMatch(/"createUpdaterArtifacts"\s*:\s*false/);
  });

  /**
   * **대조군.** 위 테스트만 있으면 "`ci.yml` 에서 서명 키를 넘기도록 고쳤다"로도
   * 통과할 여지가 생긴다(그러면 fork PR 이 깨진다). 그 잡에 개인키가 흘러들지
   * 않았는지 함께 잰다.
   */
  it('그 잡에 서명 개인키를 넘기지 않는다', () => {
    // **낱말이 아니라 `secrets.` 참조를 잰다.** 그냥 `TAURI_SIGNING_PRIVATE_KEY` 를
    // 찾으면 위 주석이 인용한 **오류 메시지 원문**에 걸려 빨개진다(실측 2026-09-07 —
    // 이 회귀선을 처음 쓸 때 실제로 그렇게 걸렸다). 키가 실제로 흘러드는 모양은
    // `${{ secrets.… }}` 이므로 그것을 본다. 주석이 오류를 인용하는 것은 오히려
    // 남겨야 할 근거다.
    const secretRefs = ci.match(/secrets\.[A-Z_]+/g) ?? [];
    expect(secretRefs.filter((r) => r.includes('SIGNING'))).toEqual([]);
    expect(ci).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{/);
  });

  /**
   * `#441`(사이드카 순서)·`#470`(심볼릭 링크 0개) 검증은 이 잡이 닫은 자리다.
   * updater 를 끄는 것과 무관하게 **계속 돌아야 한다** — 위 오류가 `.app` 번들링이
   * 끝난 뒤에 나던 것이라, 꺼도 이 검사들의 입력은 달라지지 않는다.
   */
  it('사이드카·심볼릭 링크 검증은 그대로 남아 있다', () => {
    // #441: 사이드카가 빌드보다 먼저다
    expect(ci).toContain('build:sidecar');
    expect(ci.indexOf('build:sidecar')).toBeLessThan(ci.indexOf('tauri build'));
    // #441: 번들 안에 사이드카 둘이 들어갔는지 본다
    expect(ci).toContain('Contents/MacOS/murmur-runner');
    expect(ci).toContain('Contents/MacOS/murmur-daemon');
    // #470: node-pty 는 Resources 에 있고, 번들에 링크를 만들지 않는다
    expect(ci).toContain('Contents/Resources/node_modules/node-pty');
  });
});
