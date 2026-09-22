import 'package:flutter/material.dart';

import 'connect/connect_screen.dart';
import 'i18n/i18n.dart';
import 'theme.dart';

void main() => runApp(const HarkroomApp());

/// 앱 루트.
///
/// **오퍼레이터가 아니라 대화 클라이언트다**(계획서 §1) — 이 앱은 에이전트를 돌리지
/// 않고 부른다. 터미널·러너 제어·Claude 계정은 여기 들어오지 않는다.
class HarkroomApp extends StatefulWidget {
  const HarkroomApp({super.key});

  @override
  State<HarkroomApp> createState() => _HarkroomAppState();
}

class _HarkroomAppState extends State<HarkroomApp> {
  /// 사람이 앱 안에서 고른 언어. `null` 이면 **기기 언어를 따른다**(§7-2 — 폰 언어를
  /// 바꾸는 것이 유일한 수단이면 그것은 설정이 아니다. 고르는 화면은 P0 이후).
  final Locale? _override = null;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (context) => context.t.appName,
      locale: _override,
      supportedLocales: supportedLocales,
      // `supportedLocales` 의 첫 번째(영어)가 폴백이다 — 모르는 기기 언어는 영어로 떨어진다.
      localeResolutionCallback: (deviceLocale, supported) {
        final wanted = _override ?? deviceLocale;
        return supported.firstWhere(
          (l) => l.languageCode == wanted?.languageCode,
          orElse: () => supported.first,
        );
      },
      theme: harkroomTheme(Brightness.light),
      darkTheme: harkroomTheme(Brightness.dark),
      builder: (context, child) => I18n(
        strings: stringsFor(Localizations.localeOf(context).languageCode),
        child: child ?? const SizedBox.shrink(),
      ),
      home: const ConnectScreen(),
    );
  }
}
