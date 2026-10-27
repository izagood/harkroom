import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATOR_CLI_PATH, operatorRegisterCommand } from './operatorRegisterCommand';

describe('operatorRegisterCommand — 화면의 등록 명령', () => {
  it('앱의 실제 실행 파일 경로를 앞에 쓴다 — PATH 에 기대지 않는다', () => {
    expect(operatorRegisterCommand('/Applications/Harkroom.app/Contents/MacOS/harkroom-operator', 'https://example.test', 'hkreg_abc'))
      .toBe('/Applications/Harkroom.app/Contents/MacOS/harkroom-operator register https://example.test hkreg_abc');
  });

  it('공백이 든 경로는 작은따옴표로 감싼다', () => {
    expect(operatorRegisterCommand('/Users/alice/My Apps/Harkroom.app/Contents/MacOS/harkroom-operator', 'https://example.test', 'hkreg_abc'))
      .toBe("'/Users/alice/My Apps/Harkroom.app/Contents/MacOS/harkroom-operator' register https://example.test hkreg_abc");
  });

  it('작은따옴표가 든 경로도 셸에서 한 낱말로 남는다', () => {
    expect(operatorRegisterCommand("/Users/alice/o'neil apps/Harkroom.app/Contents/MacOS/harkroom-operator", 'https://example.test', 'c'))
      .toBe("'/Users/alice/o'\\''neil apps/Harkroom.app/Contents/MacOS/harkroom-operator' register https://example.test c");
  });

  it('경로를 모르면(웹·임시 경로) 맥 기본 설치 경로로 물러선다', () => {
    expect(operatorRegisterCommand(null, 'https://example.test', 'hkreg_abc'))
      .toBe(`${DEFAULT_OPERATOR_CLI_PATH} register https://example.test hkreg_abc`);
    expect(operatorRegisterCommand(null, 'https://example.test', 'hkreg_abc').startsWith('harkroom-operator')).toBe(false);
  });
});
