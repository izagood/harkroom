import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'connect/connect_screen.dart';
import 'i18n/i18n.dart';
import 'push/push_coordinator.dart';
import 'push/push_gate.dart';
import 'push/push_platform.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'session/session_store.dart';
import 'state/app_scope.dart';
import 'state/app_state.dart';
import 'theme.dart';
import 'ui/states.dart';

void main() {
  final state = AppState(sessions: SessionStore.keychain());
  runApp(HarkroomApp(state: state, push: PushCoordinator(state, MethodChannelPush())));
}

/// 앱 루트.
///
/// **오퍼레이터가 아니라 대화 클라이언트다**(계획서 §1) — 이 앱은 에이전트를 돌리지
/// 않고 부른다. 터미널·러너 제어·Claude 계정은 여기 들어오지 않는다.
class HarkroomApp extends StatefulWidget {
  const HarkroomApp({super.key, required this.state, this.push});

  /// 시험이 바꿔 끼운다(메모리 보관소 + 가짜 소켓).
  final AppState state;

  /// 푸시(`lib/push/`). 없으면(시험) 푸시 없이 돈다.
  final PushCoordinator? push;

  @override
  State<HarkroomApp> createState() => _HarkroomAppState();
}

class _HarkroomAppState extends State<HarkroomApp> {
  /// 사람이 앱 안에서 고른 언어. `null` 이면 **기기 언어를 따른다**(§7-2 — 폰 언어를
  /// 바꾸는 것이 유일한 수단이면 그것은 설정이 아니다. 고르는 화면은 P1 이후).
  final Locale? _override = null;

  /// 토스트를 화면 옮길 때 내리려고 쥔다([ToastDismisser]).
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  late final _toastDismisser = ToastDismisser(_messenger);

  @override
  void initState() {
    super.initState();
    // 보관된 세션을 읽는다. 키체인 접근은 느릴 수 있어서 그동안 `booting` 이 선다 —
    // 화면이 "연결 중"이라고 **지어내지 않게** 단계를 값으로 둔다.
    widget.state.boot();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: _messenger,
      navigatorObservers: [_toastDismisser],
      // **`context.t` 를 쓰지 않는다.** 이 콜백은 아래 `builder` 보다 **위**에서 불리므로
      // 거기서 세우는 `I18n` 이 아직 없다 — `context.t` 를 쓰면 앱이 첫 프레임에 죽는다
      // (시험이 잡았다). `Localizations` 는 MaterialApp 이 이 위에 둔다.
      onGenerateTitle: (context) =>
          stringsFor(Localizations.localeOf(context).languageCode).appName,
      locale: _override,
      supportedLocales: supportedLocales,
      // **이 셋이 없으면 한국어 기기에서 앱이 첫 프레임에 빨간 오류가 된다.**
      //
      // `supportedLocales` 는 "이 언어를 받아들인다"는 선언일 뿐이고, 그 언어의
      // **Material 문구**(툴팁·달력·"뒤로" 같은 것)를 주는 것은 delegate 다. Flutter 가
      // 기본으로 끼워 주는 `DefaultMaterialLocalizations` 는 **영어 한 벌뿐**이라,
      // 기기 언어가 ko 로 풀리는 순간 `AppBar` 가
      // *"No MaterialLocalizations found"* 로 터진다.
      //
      // **위젯 시험이 이것을 못 잡았다** — 시험 바인딩의 기본 로케일이 영어라 기본
      // 제공분으로 덮였다. 실제 시뮬레이터(ko-KR)에 처음 띄웠을 때 드러났고,
      // `test/locale_test.dart` 가 그 자리를 지킨다.
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
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
        child: AppScope(state: widget.state, child: child ?? const SizedBox.shrink()),
      ),
      home: _Root(push: widget.push),
    );
  }
}

/// 어느 화면을 세울지는 **상태 하나가 정한다.**
///
/// 각 화면이 스스로 다음 화면으로 `Navigator.push` 하게 두면, 부팅으로 들어온 경로와
/// 로그인으로 들어온 경로가 갈라지고 둘 중 하나에만 있는 버그가 생긴다.
class _Root extends StatelessWidget {
  const _Root({this.push});

  final PushCoordinator? push;

  @override
  Widget build(BuildContext context) => switch (context.app.phase) {
        AppPhase.booting => const _Booting(),
        AppPhase.needsServer => const ConnectScreen(),
        AppPhase.needsLogin => const LoginScreen(),
        AppPhase.ready => PushGate(push: push, child: const HomeScreen()),
        AppPhase.unreachable => const _Unreachable(),
      };
}

class _Booting extends StatelessWidget {
  const _Booting();

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(context.t.commonLoading),
            ],
          ),
        ),
      );
}

/// 보관된 세션은 있는데 서버에 닿지 못했다. **로그인으로 돌리지 않는다** — 자격증명은 멀쩡하고,
/// 다시 로그인하라고 하면 비밀번호를 다시 치게 할 뿐이다. 다시 시도하거나, 다른 계정으로
/// 들어가려면 로그아웃한다.
class _Unreachable extends StatelessWidget {
  const _Unreachable();

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    return Scaffold(
      key: const Key('boot-unreachable'),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: FailedState(
                title: t.bootUnreachableTitle,
                // 어느 서버인지 보인다 — 주소를 잘못 넣었으면 그것이 원인이다.
                detail: app.baseUrl,
                onRetry: app.retryBoot,
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: TextButton(onPressed: app.signOut, child: Text(t.signOut)),
            ),
          ],
        ),
      ),
    );
  }
}
