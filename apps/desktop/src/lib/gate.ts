import { ApiError } from './api';

/**
 * **호스팅 워크스페이스를 만들어 주는 서비스**와 이야기하는 클라이언트.
 *
 * ## 왜 `ApiClient` 가 아니라 별도 클래스인가
 *
 * `ApiClient` 는 **워크스페이스 하나**를 가리킨다 — `baseUrl` 이 그 서버이고, 토큰을 싣고,
 * 채널·메시지 100여 개 표면을 낸다. 이쪽은 **아직 존재하지 않는 워크스페이스**를 만들어
 * 달라고 다른 주소에 부탁하는 일이라, 같은 객체에 얹으면 `baseUrl` 이 두 가지를 뜻하게
 * 된다(만들어 달라고 할 곳 / 만들어진 곳). 그 둘이 섞이면 클레임을 **엉뚱한 서버에**
 * 보내는 실수가 타입으로 막히지 않는다.
 *
 * 그래서 작게 따로 둔다. 표면이 둘뿐이고 토큰도 싣지 않는다.
 *
 * ## 주소를 코드가 정하지 않는다
 *
 * 어느 주소에 물어볼지는 **사용자가 적는다.** 이 저장소는 self-host 제품이고, 호스팅
 * 서비스의 주소는 그 배포 하나의 사정이라 제품 코드가 알 이유가 없다.
 */
export class GateClient {
  constructor(public baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `HTTP ${res.status}`, json);
    }
    return json as T;
  }

  /**
   * 워크스페이스를 만들어 달라고 한다.
   *
   * **`claimToken` 은 이 응답에만 실린다.** 서버는 해시만 보관하므로 다시 물어볼 수 없고,
   * 잃으면 그 워크스페이스는 아무도 가져갈 수 없다 — 화면이 그것을 곧바로 저장해야 하는
   * 이유이고(`pendingWorkspace`), 사용자에게 손으로 옮겨 적게 하지 않는 이유다.
   */
  create(input: { name: string; inviteCode: string; email: string }): Promise<CreateResult> {
    return this.req('POST', '/api/workspaces', input);
  }

  /** 만드는 중인 작업의 진행. 끝나기 전까지 `done` 이 false 다. */
  job(jobId: string): Promise<JobResult> {
    return this.req('GET', `/api/workspaces/${encodeURIComponent(jobId)}`);
  }
}

export interface CreateResult {
  jobId: string;
  name: string;
  /** 만들어질 워크스페이스의 주소. 클레임도 여기로 보낸다. */
  url: string;
  /** **한 번만 나온다.** 위 `create` 주석 참고. */
  claimToken: string;
}

export interface JobResult {
  status: string;
  /** 사람이 읽는 진행 설명. 화면은 이것을 **그대로** 보여 준다 — 아래 주석 참고. */
  message?: string;
  url?: string;
  done?: boolean;
}

/**
 * 만들다 만 워크스페이스. **닫아도 잃지 않으려고** 보관한다.
 *
 * 왜 필요한가: 만들어지기까지 사람이 한 번 손을 대야 하므로(아래 `gateProgressText`)
 * 기다림이 길다. 그 사이 앱을 닫으면 `claimToken` 이 사라지고 — 다시 볼 수 없으므로 —
 * 그 워크스페이스는 **만들어졌는데 아무도 가져갈 수 없는** 상태가 된다.
 */
export interface PendingWorkspace {
  gateUrl: string;
  jobId: string;
  claimToken: string;
  url: string;
  name: string;
}

/** `session.ts` 의 키 관례를 따른다(`harkroom.*`). 이 키는 새것이라 옛 이름이 없다. */
const PENDING_KEY = 'harkroom.pendingWorkspace';

export const pendingWorkspace = {
  read(): PendingWorkspace | null {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as PendingWorkspace;
      // 네 칸이 다 있어야 이어서 클레임할 수 있다. 하나라도 없으면 없는 것으로 친다 —
      // 반쯤 남은 것을 들고 화면을 세우면 클레임 버튼이 조용히 실패한다.
      return p.gateUrl && p.jobId && p.claimToken && p.url ? p : null;
    } catch { return null; }
  },
  write(p: PendingWorkspace): void {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* 저장 불가 환경 허용 */ }
  },
  clear(): void {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* noop */ }
  },
};

/**
 * 진행 상태를 사람의 문장으로.
 *
 * **서버가 준 `message` 를 우선한다.** 이 기다림의 대부분은 "아직 사람이 승인하지 않았다"
 * 이고, 그 사정은 서버만 안다 — 화면이 자기 말로 "준비 중" 이라고만 하면 몇 시간이 지나도
 * 무엇을 기다리는지 알 수 없고, 고장난 것처럼 읽힌다.
 */
export function gateProgressText(job: JobResult): string {
  if (job.message) return job.message;
  switch (job.status) {
    case 'queued': return 'Queued…';
    case 'committed': return 'Submitted — waiting for approval…';
    case 'waiting_ready': return 'Waiting for the workspace to come up…';
    case 'ready': return 'Ready.';
    case 'failed': return 'Provisioning failed.';
    default: return `Working… (${job.status})`;
  }
}

/**
 * gate 의 거절을 사람이 **할 수 있는 일**로 바꾼다.
 *
 * ⚠️ 초대 코드 거절은 **한 가지 문구다.** gate 는 "없는 코드 / 다 쓴 코드 / 만료된 코드"를
 * 일부러 구분해 주지 않는다 — 구분해 주면 유효한 코드를 찾는 탐색에 답이 되기 때문이다.
 * 화면에서 그것을 되살리면 서버가 감춘 것을 클라이언트가 흘리는 셈이 되므로, 여기서도
 * 나누지 않는다.
 */
export function gateErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not reach the workspace service';
  switch (err.code) {
    case 'invalid_invite':
      return 'That invite code cannot be used. Ask for a new one.';
    case 'name_taken':
      return 'That name is already taken. Try another.';
    case 'at_capacity':
      return 'The service is at capacity right now. Try again later.';
    default:
      // 이름 규칙 위반(`invalid_name` 등)은 서버 문구가 무엇이 틀렸는지 말해 준다.
      return err.message;
  }
}
