import { describe, expect, it } from 'vitest';
import { describeArgs, parseDaemonArgs } from '../src/args.js';

describe('parseDaemonArgs — 앱이 넘기는 인자 (#431 2단계-a)', () => {
  /**
   * orca daemon(pid 1096)의 **실제 명령줄**을 그대로 넣는다(2026-09-05 실측). 이름을
   * 지어내지 않았다는 것이 이 회귀선의 요점이다 — 값을 하나씩 리터럴로 확인한다.
   */
  it('orca 실측 형태의 인자를 전부 판다', () => {
    const args = parseDaemonArgs([
      '--socket', '/tmp/murmur/daemon/daemon-v1.sock',
      '--token', '/tmp/murmur/daemon/daemon-v1.token',
      '--pid-record', '/tmp/murmur/daemon/daemon-v1.pid',
      '--launch-nonce', '0d918a6a-53b5-47d2-9aff-6a00b495ab89',
      '--entry-path', '/Applications/murmur.app/Contents/MacOS/murmur-daemon',
      '--app-version', '0.1.0',
    ]);
    expect(args.socket).toBe('/tmp/murmur/daemon/daemon-v1.sock');
    expect(args.token).toBe('/tmp/murmur/daemon/daemon-v1.token');
    expect(args.pidRecord).toBe('/tmp/murmur/daemon/daemon-v1.pid');
    expect(args.launchNonce).toBe('0d918a6a-53b5-47d2-9aff-6a00b495ab89');
    expect(args.entryPath).toBe('/Applications/murmur.app/Contents/MacOS/murmur-daemon');
    expect(args.appVersion).toBe('0.1.0');
    expect(args.unknown).toEqual([]);
  });

  /**
   * 인자가 아예 없어도 **뜬다.** 골격 단계에서 무엇을 필수로 볼지는 아직 정하지 않았고,
   * 여기서 임의로 강제하면 2단계-b 가 그 판정을 바꿀 때 두 번 손대게 된다.
   */
  it('인자가 없어도 파싱은 성공한다', () => {
    expect(parseDaemonArgs([])).toEqual({ unknown: [] });
  });

  /**
   * 모르는 인자는 **버리지 않고 남긴다.** 앱과 daemon 의 버전이 갈리면(D3 이 그 상태를
   * 정상으로 본다) 앱이 이 daemon 이 모르는 인자를 넘길 수 있다. 조용히 사라지면 사람이
   * "왜 안 먹히나"를 추적할 방법이 없다.
   */
  it('모르는 인자는 unknown 에 남는다', () => {
    const args = parseDaemonArgs(['--log-file', '/tmp/x.log', '--socket', '/tmp/s.sock']);
    expect(args.socket).toBe('/tmp/s.sock');
    expect(args.unknown).toEqual(['--log-file', '/tmp/x.log']);
  });

  /**
   * 값 없이 끝난 플래그는 **던진다.** 조용히 `undefined` 로 두면 앱은 소켓 경로를 줬다고
   * 믿는데 daemon 은 못 받은 상태가 되고, 그 어긋남은 소켓이 엉뚱한 자리에 생기는
   * 형태로 늦게 드러난다.
   */
  it('값이 빠진 플래그는 기동을 실패시킨다', () => {
    expect(() => parseDaemonArgs(['--socket'])).toThrow('--socket 에 값이 없다');
  });
});

describe('describeArgs — 받은 것을 사람이 볼 수 있게 적는다', () => {
  it('받은 값만 적는다', () => {
    const line = describeArgs(parseDaemonArgs(['--socket', '/tmp/s.sock', '--app-version', '0.1.0']));
    expect(line).toBe('--socket=/tmp/s.sock --app-version=0.1.0');
  });

  it('아무것도 못 받았으면 그 사실을 적는다', () => {
    expect(describeArgs(parseDaemonArgs([]))).toBe('(인자 없음)');
  });
});
