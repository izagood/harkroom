import type { Pool } from 'pg';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AutomationGithubTrigger, AutomationIngressIssued, AutomationTrigger } from '@harkroom/shared';
import type { SecretBox } from './secretBox.js';

/**
 * 자동화 외부 수신(065). 기본 꺼짐 — 켜면 키를 발급하고, 끄면 지운다.
 */

export const INGRESS_KEY_PREFIX = 'hkhook_';

export function hashIngressKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * 수신을 켜거나 키를 **다시** 받는다. 다시 받으면 옛 키는 그 자리에서 무효가 된다(같은 행을
 * 덮으므로). GitHub 트리거인데 `secretBox` 가 없으면(`HARKROOM_SECRET_KEY` 미설정) 켜지 않는다 —
 * 켜 놓고 서명을 검증할 수 없으면 그 입구는 아무나 두드리는 문이 된다.
 */
export async function issueIngress(
  pool: Pool, id: string, ownerId: string, trigger: AutomationTrigger, box: SecretBox | null,
): Promise<AutomationIngressIssued | 'needs_secret_key' | 'not_found' | 'schedule_has_no_ingress'> {
  if (trigger.kind === 'schedule') return 'schedule_has_no_ingress';
  if (trigger.kind === 'github' && !box) return 'needs_secret_key';
  const key = INGRESS_KEY_PREFIX + randomBytes(24).toString('base64url');
  const res = await pool.query(
    `update automation set ingress_enabled_at = now(), ingress_token_hash = $3, ingress_secret_enc = $4, updated_at = now()
     where id = $1 and owner_id = $2 and deleted_at is null returning id`,
    [id, ownerId, hashIngressKey(key), box ? box.seal(key) : null],
  );
  if (!res.rowCount) return 'not_found';
  return {
    key,
    githubPath: trigger.kind === 'github' ? `/hooks/github/${id}` : null,
    genericPath: `/hooks/generic/${id}`,
  };
}

export async function revokeIngress(pool: Pool, id: string, ownerId: string): Promise<boolean> {
  const res = await pool.query(
    `update automation set ingress_enabled_at = null, ingress_token_hash = null, ingress_secret_enc = null, updated_at = now()
     where id = $1 and owner_id = $2 and deleted_at is null returning id`,
    [id, ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface IngressTarget {
  id: string; trigger: AutomationTrigger; enabled: boolean;
  tokenHash: string | null; secretEnc: string | null;
}

/** 수신이 **켜진** 자동화만 돌려준다. 꺼졌거나 없거나 지워졌으면 null — 라우트는 모두 404 로 답한다. */
export async function loadIngressTarget(pool: Pool, id: string): Promise<IngressTarget | null> {
  const res = await pool.query(
    `select id, trigger, enabled, ingress_token_hash as "tokenHash", ingress_secret_enc as "secretEnc"
     from automation where id = $1 and deleted_at is null and ingress_enabled_at is not null`,
    [id],
  );
  return res.rows[0] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyBearer(target: IngressTarget, header: string | undefined): boolean {
  if (!target.tokenHash || !header?.startsWith('Bearer ')) return false;
  return safeEqual(hashIngressKey(header.slice(7).trim()), target.tokenHash);
}

/** `X-Hub-Signature-256: sha256=<hex>` 를 **원문 바이트**로 검증한다(파싱한 JSON 을 다시 직렬화하면 바이트가 달라진다). */
export function verifyGithubSignature(target: IngressTarget, box: SecretBox | null, raw: Buffer, header: string | undefined): boolean {
  if (!box || !target.secretEnc || !header?.startsWith('sha256=')) return false;
  const key = box.open(target.secretEnc);
  if (!key) return false;
  const want = 'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
  return safeEqual(want, header);
}

// ── 필터 ─────────────────────────────────────────────────────────────────

/** 작은 glob: `**` 는 `/` 를 넘고, `*` 는 한 칸 안, `?` 는 한 글자. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * 외부에서 온 글자를 **부르지 못하게** 만든다. PR 제목이나 커밋 메시지는 남이 쓴 글이라
 * 거기 `@forge` 가 있으면 그대로 멘션이 되어 턴이 뜬다 — 자동화의 본문을 쓴 사람이 의도하지
 * 않은 호출이다. `@` 뒤에 폭 없는 공백을 끼워 멘션 스캔을 끊는다(읽는 사람에겐 같아 보인다).
 * 줄바꿈은 한 칸으로 접는다 — 한 줄짜리 변수가 본문 구조를 바꾸지 못하게.
 */
export function neutralize(v: unknown, max = 300): string {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/@/g, '@​').replace(/<@/g, '<​@');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type Json = Record<string, any>;

interface FileChange { path: string; change: 'added' | 'modified' | 'removed' }

function pushChanges(payload: Json): FileChange[] {
  const out: FileChange[] = [];
  for (const c of (Array.isArray(payload.commits) ? payload.commits : []) as Json[]) {
    for (const k of ['added', 'modified', 'removed'] as const) {
      for (const p of (Array.isArray(c[k]) ? c[k] : []) as string[]) out.push({ path: p, change: k });
    }
  }
  return out;
}

export type GithubMatch =
  | { match: true; eventKeyHint: string | null; vars: Record<string, string> }
  | { match: false; reason: string };

/**
 * GitHub 이벤트가 이 트리거에 맞는가. 맞으면 본문 변수를 함께 준다(모두 `neutralize` 를 지난다).
 * `event` 는 `X-GitHub-Event` 헤더, `payload` 는 본문 JSON.
 */
export function matchGithub(trigger: AutomationGithubTrigger, event: string, payload: Json): GithubMatch {
  const repo = String(payload.repository?.full_name ?? '');
  if (repo.toLowerCase() !== trigger.repo.toLowerCase()) return { match: false, reason: 'repo' };

  const vars: Record<string, string> = { repo: neutralize(repo), event: neutralize(trigger.event) };
  let branch: string | null = null;
  let files: FileChange[] = [];

  if (trigger.event === 'push') {
    if (event !== 'push') return { match: false, reason: 'event' };
    const ref = String(payload.ref ?? '');
    if (!ref.startsWith('refs/heads/')) return { match: false, reason: 'not_a_branch' };
    branch = ref.slice('refs/heads/'.length);
    files = pushChanges(payload);
    vars.sha = neutralize(payload.after, 40);
    vars.author = neutralize(payload.pusher?.name ?? payload.sender?.login);
    vars.compare = neutralize(payload.compare, 500);
    vars['commit.message'] = neutralize(payload.head_commit?.message);
  } else if (trigger.event === 'pull_request.merged') {
    if (event !== 'pull_request' || payload.action !== 'closed' || payload.pull_request?.merged !== true) {
      return { match: false, reason: 'event' };
    }
    const pr = payload.pull_request as Json;
    branch = String(pr.base?.ref ?? '');
    vars['pr.number'] = neutralize(pr.number, 20);
    vars['pr.title'] = neutralize(pr.title);
    vars['pr.url'] = neutralize(pr.html_url, 500);
    vars.sha = neutralize(pr.merge_commit_sha, 40);
    vars.author = neutralize(pr.user?.login);
  } else if (trigger.event === 'release.published') {
    if (event !== 'release' || payload.action !== 'published') return { match: false, reason: 'event' };
    vars['release.tag'] = neutralize(payload.release?.tag_name);
    vars['release.url'] = neutralize(payload.release?.html_url, 500);
    vars.author = neutralize(payload.release?.author?.login);
  } else {
    if (event !== 'workflow_run' || payload.action !== 'completed') return { match: false, reason: 'event' };
    const run = payload.workflow_run as Json;
    branch = String(run?.head_branch ?? '');
    vars['workflow.name'] = neutralize(run?.name);
    vars['workflow.conclusion'] = neutralize(run?.conclusion);
    vars['workflow.url'] = neutralize(run?.html_url, 500);
    vars.sha = neutralize(run?.head_sha, 40);
  }

  if (trigger.branch && branch !== trigger.branch) return { match: false, reason: 'branch' };
  if (branch !== null) vars.branch = neutralize(branch);

  // 경로·변경 필터는 파일 목록이 있는 push 에서만 뜻이 있다. PR 은 webhook 에 파일 목록이 없다
  // (따로 API 를 불러야 한다) — 그래서 PR 트리거에 paths 를 걸면 **맞지 않는 것으로** 본다.
  // 조용히 무시하면 "adapters 가 바뀐 PR 만"이라고 적은 사람에게 모든 PR 이 간다.
  if (trigger.paths?.length || (trigger.change && trigger.change !== 'any')) {
    if (trigger.event !== 'push') return { match: false, reason: 'paths_need_push' };
    const res = (trigger.paths?.length ? trigger.paths : ['**']).map(globToRegExp);
    const hit = files.filter((f) => res.some((r) => r.test(f.path))
      && (!trigger.change || trigger.change === 'any' || f.change === trigger.change));
    if (!hit.length) return { match: false, reason: 'paths' };
    const uniq = [...new Set(hit.map((f) => f.path))];
    vars.files = uniq.slice(0, 50).map((p) => neutralize(p)).join('\n');
    for (const k of ['added', 'modified', 'removed'] as const) {
      vars[`files.${k}`] = [...new Set(hit.filter((f) => f.change === k).map((f) => f.path))]
        .slice(0, 50).map((p) => neutralize(p)).join('\n');
    }
  } else if (files.length) {
    vars.files = [...new Set(files.map((f) => f.path))].slice(0, 50).map((p) => neutralize(p)).join('\n');
  }
  return { match: true, eventKeyHint: null, vars };
}

/** 범용 hook 본문의 **맨 윗단 원시값**만 변수로 준다(`payload.<키>`). 깊은 구조는 받지 않는다. */
export function genericVars(body: unknown): Record<string, string> {
  const vars: Record<string, string> = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Json).slice(0, 50)) {
      if (/^[\w.-]{1,64}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        vars[`payload.${k}`] = neutralize(v, 1000);
      }
    }
  }
  return vars;
}
