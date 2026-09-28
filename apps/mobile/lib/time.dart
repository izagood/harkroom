/// 시간을 **글자로 바꾸는 한 곳**.
///
/// 데스크탑 `packages/desktop/src/lib/time.ts` 와 같은 자리이고 같은 판단을 옮겼다.
/// 흩어 두면 같은 시각이 화면마다 다르게 읽힌다 — 한 곳에서는 "4분", 다른 곳에서는
/// "4분 12초" 가 되고, 사람은 둘이 같은 것인지 확신할 수 없다.
///
/// **서버는 ISO 시각만 싣는다.** "15:20 에 다시 봅니다" 처럼 미리 구운 문자열은 서버의
/// 시간대에 고정되어 다른 시간대에서 읽는 사람에게 거짓이 된다. 읽는 쪽이 자기 시간대로
/// 읽는 것이 그 결정의 나머지 절반이고, 이 파일이 그 절반이다.
library;

import 'i18n/i18n.dart';

/// 길이를 **성기게** 적는다(`4분` · `2시간 5분`).
///
/// 초를 적지 않는 이유: 이 글자가 서는 자리(진행 줄·대기 줄)는 **곁눈으로 읽는** 곳이라,
/// 매 초 글자가 바뀌면 옆의 이름과 사유를 읽기 어렵다.
String durationLabel(Duration d, Strings t) {
  final ms = d.inMilliseconds;
  if (ms < 60000) return t.timeUnderMinute;
  final minutes = d.inMinutes;
  if (minutes < 60) return t.timeMinutes.replaceFirst('{n}', '$minutes');
  final hours = d.inHours;
  final rest = minutes - hours * 60;
  if (hours < 24) {
    final head = t.timeHours.replaceFirst('{n}', '$hours');
    return rest == 0 ? head : '$head ${t.timeMinutes.replaceFirst('{n}', '$rest')}';
  }
  return t.timeDays.replaceFirst('{n}', '${d.inDays}');
}

/// **아직 도는 중**(`4분째`).
String runningLabel(Duration d, Strings t) =>
    t.timeRunning.replaceFirst('{duration}', durationLabel(d, t));

/// **끝났다**(`4분 걸림`).
String tookLabel(Duration d, Strings t) =>
    t.timeTook.replaceFirst('{duration}', durationLabel(d, t));

/// **지난 일**(`4분 전`). 1분 미만은 숫자를 쓰지 않는다 — 그 정밀도는 쓸모가 없다.
String agoLabel(DateTime from, DateTime now, Strings t) {
  final d = now.difference(from);
  if (d.isNegative || d.inMilliseconds < 60000) return t.timeJustNow;
  return t.timeAgo.replaceFirst('{duration}', durationLabel(d, t));
}

/// **아직 오지 않은 것**(`4분 뒤`).
///
/// 시각이 이미 지났으면 숫자를 쓰지 않는다: 깨움 sweep 은 주기적으로 돌므로 `0분 뒤` 는
/// **틀린 말이 아니라 쓸모없는 말**이고, 사람이 알고 싶은 것은 "곧"이다.
String inLabel(DateTime at, DateTime now, Strings t) {
  final d = at.difference(now);
  if (d.isNegative || d.inMilliseconds < 60000) return t.timeSoon;
  return t.timeIn.replaceFirst('{duration}', durationLabel(d, t));
}
