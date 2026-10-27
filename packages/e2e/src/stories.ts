/**
 * 사용자 스토리보드 — 여러 사람·권한 차이·처음 쓰는 사람이 도는 여정을 **데이터 하나**로 둔다.
 *
 * 왜 데이터인가: owner 한 명으로만 쓰던 동안 안 보이던 사고(member 에게 [+ 에이전트] 가 안 보임,
 * 역할을 바꿔도 재시작 전엔 그대로)는 "누가 어느 기기에서 무엇을 하나"를 표로 세워야 빈칸이 보인다.
 * 그 표를 여기 한 곳에 두고, API 러너(server vitest)·브라우저 러너(Playwright, 대체 결과)·모바일
 * live_tour·손 시험이 **같은 파일을 읽는다**. 러너가 늘어도 여정의 뜻은 한 곳에서만 바뀐다.
 *
 * 이 파일은 형식과 어휘만 정한다. 실행은 러너 몫이다.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export const DEVICES = ['desktop', 'mobile', 'join-web'] as const;
export const COMMUNITY_STATES = ['new-tenant', 'existing', 'multi'] as const;

/**
 * 단계의 동사. 러너는 이 이름마다 구현을 하나씩 단다 — 모르는 동사가 YAML 에 들어오면
 * 형식 검사가 막는다(러너가 조용히 건너뛰면 "시험 있음"이 거짓이 된다).
 */
export const ACTIONS = [
  'tenant.claim', 'invite.create', 'invite.open', 'invite.accept', 'login', 'logout',
  'channel.open', 'channel.create', 'channel.invite', 'message.send', 'message.receive',
  'grant.give', 'grant.revoke', 'role.set', 'account.disable',
  'password.resetIssue', 'password.resetUse',
  'agent.create', 'operator.register', 'agent.invoke', 'agent.dm',
  'card.answer', 'community.add', 'community.switch',
  'ui.see', 'ui.notSee', 'api.allowed', 'api.denied',
] as const;

/** 시험이 도는 곳. `browser` 는 데스크톱 웹뷰를 브라우저로 띄운 **대체 결과**다 — 실물(Tauri 앱)이 아니다. */
export const RUNNERS = ['api', 'browser', 'mobile', 'harness', 'manual'] as const;
/** 지금 있는 시험의 종류(출처를 적는 칸). */
export const EXISTING_KINDS = ['server-vitest', 'desktop-vitest', 'browser-playwright', 'mobile-integration', 'testbed-harness'] as const;

export type Role = typeof ROLES[number];
export type Device = typeof DEVICES[number];
export type Action = typeof ACTIONS[number];
export type Runner = typeof RUNNERS[number];

export interface Persona {
  id: string;
  /** 시드 계정 handle. 공개 저장소라 `e2e-` 로 시작하는 가짜 이름만 쓴다. */
  handle: string;
  title: string;
  role: Role | 'none';
  grants?: string[];
  devices: Device[];
  community: typeof COMMUNITY_STATES[number];
  /** 여러 커뮤니티 페르소나(P7)의 커뮤니티별 역할. */
  roles?: Record<string, Role>;
}

export interface Step {
  as: string;
  act: Action;
  on?: Device | 'api';
  target?: string;
  with?: Record<string, unknown>;
  expect: string;
}

export interface Journey {
  id: string;
  title: string;
  personas: string[];
  steps: Step[];
  expect: string;
  failSigns: string[];
  /** 지금 이 여정을 (부분이라도) 보는 시험. `file` 은 저장소 기준 경로 — 형식 검사가 존재를 확인한다. */
  existing?: { kind: typeof EXISTING_KINDS[number]; file?: string; ref?: string; note: string }[];
  /** 이 여정을 돌릴(돌릴 예정인) 러너. 러너가 붙으면 그 러너의 PR 에서 이 칸을 고친다. */
  runners: Runner[];
  /** 아직 아무 시험도 못 보는 것. */
  gaps?: string[];
}

export interface Storyboard {
  personas: Persona[];
  journeys: Journey[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const STORIES_DIR = join(here, '..', 'stories');

/** `stories/` 를 읽는다. 검사는 하지 않는다 — `validate()` 가 한다. */
export function loadStoryboard(dir = STORIES_DIR): Storyboard {
  const personas = parse(readFileSync(join(dir, 'personas.yaml'), 'utf8')).personas as Persona[];
  const journeys = readdirSync(dir)
    .filter((f) => /^J\d+-.+\.yaml$/.test(f))
    .sort((a, b) => Number(a.slice(1, a.indexOf('-'))) - Number(b.slice(1, b.indexOf('-'))))
    .map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Journey);
  return { personas, journeys };
}

/** 형식 오류를 모아 돌려준다. 빈 배열이면 통과. `exists` 는 저장소 경로가 있는지 묻는다. */
export function validate(sb: Storyboard, exists: (repoPath: string) => boolean): string[] {
  const errors: string[] = [];
  const personaIds = new Set<string>();
  for (const p of sb.personas) {
    if (!/^P\d+$/.test(p.id)) errors.push(`${p.id}: persona id 는 P<번호>`);
    if (personaIds.has(p.id)) errors.push(`${p.id}: persona id 중복`);
    personaIds.add(p.id);
    if (!/^e2e-[a-z0-9-]+$/.test(p.handle)) errors.push(`${p.id}: handle 은 e2e-* 만(공개 저장소)`);
    if (p.role !== 'none' && !ROLES.includes(p.role)) errors.push(`${p.id}: 모르는 역할 ${p.role}`);
    for (const d of p.devices ?? []) if (!DEVICES.includes(d)) errors.push(`${p.id}: 모르는 기기 ${d}`);
    if (!COMMUNITY_STATES.includes(p.community)) errors.push(`${p.id}: 모르는 커뮤니티 상태 ${p.community}`);
  }
  const journeyIds = new Set<string>();
  for (const j of sb.journeys) {
    const at = j.id ?? '(id 없음)';
    if (!/^J\d+$/.test(j.id)) errors.push(`${at}: journey id 는 J<번호>`);
    if (journeyIds.has(j.id)) errors.push(`${at}: journey id 중복`);
    journeyIds.add(j.id);
    if (!j.title) errors.push(`${at}: title 없음`);
    if (!j.expect) errors.push(`${at}: expect 없음`);
    if (!j.failSigns?.length) errors.push(`${at}: failSigns 없음 — 실패하면 무엇이 보이는지 적는다`);
    if (!j.steps?.length) errors.push(`${at}: steps 없음`);
    for (const p of j.personas ?? []) if (!personaIds.has(p)) errors.push(`${at}: 모르는 persona ${p}`);
    (j.steps ?? []).forEach((s, i) => {
      if (!j.personas?.includes(s.as)) errors.push(`${at}.steps[${i}]: as=${s.as} 가 personas 에 없음`);
      if (!ACTIONS.includes(s.act)) errors.push(`${at}.steps[${i}]: 모르는 동작 ${s.act}`);
      if (s.on && s.on !== 'api' && !DEVICES.includes(s.on)) errors.push(`${at}.steps[${i}]: 모르는 기기 ${s.on}`);
      if (!s.expect) errors.push(`${at}.steps[${i}]: expect 없음`);
      // 거절 단계는 상태 코드만으로는 어느 문에서 막혔는지 모른다(step-up 창이 닫혀서 난 403 도 통과한다).
      // 서버 오류 코드(`error.code`)까지 적게 한다.
      if (s.act === 'api.denied' && typeof s.with?.code !== 'string') errors.push(`${at}.steps[${i}]: api.denied 는 with.code(서버 거절 사유 코드)가 있어야 함`);
    });
    if (!j.runners?.length) errors.push(`${at}: runners 없음`);
    for (const r of j.runners ?? []) if (!RUNNERS.includes(r)) errors.push(`${at}: 모르는 러너 ${r}`);
    for (const e of j.existing ?? []) {
      if (!EXISTING_KINDS.includes(e.kind)) errors.push(`${at}: 모르는 시험 종류 ${e.kind}`);
      if (e.file && !exists(e.file)) errors.push(`${at}: 없는 시험 파일 ${e.file}`);
      if (!e.file && !e.ref) errors.push(`${at}: existing 에 file 이나 ref 가 있어야 함`);
    }
  }
  return errors;
}
