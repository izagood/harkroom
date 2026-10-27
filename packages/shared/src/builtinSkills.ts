/**
 * 내장 스킬(2026-10-27, 앱 기본 규칙 전달 S의 P3) — 러너가 **코드와 같은 판**으로 싣는 앱 기본 스킬.
 *
 * ## 왜 스킬인가, 무엇을 담나
 *
 * 러너 시스템 프롬프트는 매 턴 통째로 실린다(앞에 붙이는 하네스는 재개할 때마다 사본이 쌓인다 — m0 실측). 그중
 * 「일이 생겨야 쓰는 절차」(머지 거절 코드표·기억 정리 6단계 등)는 열 때만 읽히면 된다. 그래서 그것만 스킬로 옮긴다.
 * **금지·안전선은 옮기지 않는다** — 스킬은 열지 않으면 없는 것과 같다. 「언제」는 기능 카탈로그가 턴별로 싣는다
 * (`featureCatalog.ts`). 사용자·워크스페이스 정책은 담지 않는다(설계 원칙 2).
 *
 * ## 싣는 법(소유자 결정 10-27)
 *
 * - 턴별로 고르지 않고 **늘 다 깐다**. 같은 작업 폴더의 동시 턴끼리 링크가 뒤집히지 않게 하려는 것이다.
 * - 이름은 `harkroom-` 로 시작하고, 워크스페이스 스킬은 이 접두를 쓸 수 없다(서버 `reserved_slug`). 그래도 겹치면 내장이
 *   이긴다 — 사용자 층은 앱 규칙을 좁히거나 덧붙일 뿐 뒤집지 못한다(설계 원칙 3).
 * - frontmatter 는 `name`·`description` 만 둔다 — API 키 연결 턴의 허용 목록(`laneSafeSkill`)을 지나고, opencode 는 `name`
 *   없는 SKILL.md 를 싣지 않는다.
 *
 * 문구는 에이전트가 읽는 지시라 한국어 한 벌이다(사람에게 보이는 화면 문구가 아니다).
 */
export const BUILTIN_SKILL_PREFIX = 'harkroom-';

export interface BuiltinSkill {
  slug: string;
  /** frontmatter 를 포함한 SKILL.md 전문. */
  body: string;
}

function skill(slug: string, description: string, lines: readonly string[]): BuiltinSkill {
  return { slug, body: [`---`, `name: ${slug}`, `description: ${JSON.stringify(description)}`, `---`, '', ...lines, ''].join('\n') };
}

/**
 * 지금은 길을 여는 예시 하나다. 머지·권한·기억·비밀 등의 절차는 P4~P6 이 프롬프트에서 옮겨 온다. 이 예시의 절차는 아직
 * 프롬프트에도 그대로 있다(옮기는 것은 P6) — 그래서 지금 이 스킬을 못 읽는 턴도 잃는 것이 없다.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  skill('harkroom-artifact', '사람이 눈으로 볼 HTML(시안·보고서 페이지)을 harkroom 미리보기 카드로 올리는 절차', [
    '# harkroom 미리보기(artifact.publish)',
    '',
    '- 사람이 **눈으로 볼 HTML**(디자인 안·시안·보고서 페이지)은 harkroom MCP 의 `artifact.publish`(channelId·threadRootId·title·body·html)로 올린다 — 그 글이 이 턴의 발화다.',
    '- claude.ai 아티팩트 링크로 주지 않는다(그 계정으로 로그인한 사람만 연다). 사람은 앱 안 카드를 눌러 바로 본다(폰 포함).',
    '- 한 파일에 다 담는다. 페이지는 외부로 fetch 할 수 없고, 스크립트·스타일·폰트는 cdnjs·jsdelivr·Google Fonts 에서만 불러온다.',
    '- 같은 안을 고칠 때는 앞서 받은 `artifactId` 를 함께 줘서 다음 버전으로 올린다.',
  ]),
];

export function isBuiltinSkillSlug(slug: string): boolean {
  return slug.startsWith(BUILTIN_SKILL_PREFIX);
}
