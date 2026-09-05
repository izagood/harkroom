// daemon 이 앱에게서 받는 인자. **파싱만 한다** — 소켓을 열거나 pid 파일을 쓰는 것은
// 2단계-b 의 일이다(#431). 지금 이 파일이 존재하는 이유는 사이드카 빌드 경로가 실제로
// 실행 가능한 산출물을 내는지 **실물로 확인할 수 있게** 하기 위해서다.
//
// ## 이름의 근거 — orca 실측 (2026-09-05)
//
// 인자 이름은 지어내지 않고 같은 시각 로컬에서 돌고 있는 orca daemon(pid 1096)의
// 실제 명령줄을 그대로 읽어 맞췄다:
//
// ```text
// …/daemon-entry.js
//   --socket        …/orca/daemon/daemon-v36.sock
//   --token         …/orca/daemon/daemon-v36.token
//   --pid-record    …/orca/daemon/daemon-v36.pid
//   --launch-nonce  0d918a6a-53b5-47d2-9aff-6a00b495ab89
//   --entry-path    …/out/main/daemon-entry.js
//   --app-version   1.4.197
// ```
//
// 각 값이 무엇을 위한 것인지는 이슈 `#431` 의 D3(소켓 버전 + pid 파일)·D6(토큰 인증)에
// 적혀 있다. 여기서는 **그 형태만** 받아 둔다.

/** 앱이 daemon 에게 넘기는 값들. 전부 선택적이다 — 골격 단계에서는 무엇이 빠졌는지
 * 판정하지 않는다. 필수 항목의 강제는 실제로 그것을 쓰는 2단계-b 가 정한다. */
export interface DaemonArgs {
  /** unix 소켓 경로. 버전이 이름에 박힌다(D3: `daemon-v1.sock`). */
  socket?: string;
  /** 토큰 파일 경로. 같은 머신의 다른 프로세스가 붙지 못하게 막는다(D6). */
  token?: string;
  /** pid 기록 파일 경로. "어느 앱 빌드가 띄운 daemon 인가"를 파일 하나로 판정한다(D3). */
  pidRecord?: string;
  /** 이번 기동을 식별하는 난스. 앱이 자기가 방금 띄운 daemon 인지 가린다. */
  launchNonce?: string;
  /** daemon 실행 파일 자신의 경로. pid 기록에 함께 남긴다(D3). */
  entryPath?: string;
  /** 이 daemon 을 띄운 앱의 버전. 버전 공존 판정의 근거다(D3·D4). */
  appVersion?: string;
  /** 위 어느 것에도 해당하지 않은 인자. **버리지 않고 남긴다** — 앱과 daemon 의 버전이
   * 갈리면 앱이 daemon 이 모르는 인자를 넘길 수 있고, 그때 조용히 사라지면 사람이
   * "왜 안 먹히나"를 추적할 수 없다(`#368` 의 원칙과 같은 성격이다). */
  unknown: string[];
}

/** `--이름 값` 쌍만 다룬다. orca 실측이 전부 그 형태고, 골격 단계에 그 이상은 필요 없다. */
const FLAGS: Record<string, keyof Omit<DaemonArgs, 'unknown'>> = {
  '--socket': 'socket',
  '--token': 'token',
  '--pid-record': 'pidRecord',
  '--launch-nonce': 'launchNonce',
  '--entry-path': 'entryPath',
  '--app-version': 'appVersion',
};

/**
 * 인자를 판다. 알려진 플래그는 다음 인자를 값으로 가져가고, 나머지는 `unknown` 에 쌓인다.
 *
 * 값이 없는 채로 끝난 플래그(`--socket` 이 마지막)는 **던진다** — 조용히 `undefined` 로
 * 두면 앱이 경로를 넘겼다고 믿는데 daemon 은 못 받은 상태가 되고, 그 어긋남은 소켓이
 * 엉뚱한 자리에 생기는 형태로 늦게 드러난다.
 */
export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  const out: DaemonArgs = { unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const key = FLAGS[arg];
    if (!key) {
      out.unknown.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${arg} 에 값이 없다`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

/** 기동 로그 한 줄. 사람이 `ps` 대신 로그로도 "무엇을 받았나"를 볼 수 있어야 한다. */
export function describeArgs(args: DaemonArgs): string {
  const parts = Object.entries(FLAGS)
    .map(([flag, key]) => (args[key] === undefined ? null : `${flag}=${args[key]}`))
    .filter((p): p is string => p !== null);
  if (args.unknown.length > 0) parts.push(`unknown=[${args.unknown.join(' ')}]`);
  return parts.length > 0 ? parts.join(' ') : '(인자 없음)';
}
