import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../i18n/i18n.dart';
import '../session/session_store.dart';
import '../state/app_scope.dart';
import 'community_screens.dart';

/// 아이디·비밀번호를 받는다. 서버 주소는 이미 정해진 뒤다(`ConnectScreen`).
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _loginId = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;

  /// 실패 사유. **문구가 아니라 키**를 들고 있는다 — 화면이 문장을 짓지 않는다.
  String? _errorKey;

  @override
  void dispose() {
    _loginId.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      await context.app.login(_loginId.text.trim(), _password.text);
    } on ApiError catch (e) {
      // **왜 틀렸는지는 말하지 않는다.** 아이디의 존재 여부를 알려 주면 계정 목록을
      // 훑을 수 있다. 서버가 401 로 거절한 것과 그 밖의 오류만 가른다.
      setState(() => _errorKey =
          e.isCredentialFailure ? 'loginErrorRejected' : 'loginErrorUnreachable');
    } on NetworkError {
      // 자격증명 문제와 **갈라서** 말한다 — 사람이 할 일이 다르다(주소를 고칠 것인가,
      // 비밀번호를 고칠 것인가).
      setState(() => _errorKey = 'loginErrorUnreachable');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _message(Strings t, String key) => switch (key) {
        'loginErrorRejected' => t.loginErrorRejected,
        _ => t.loginErrorUnreachable,
      };

  StoredCommunity? _otherLive(BuildContext context) {
    final app = context.app;
    for (final c in app.communities) {
      if (!c.isExpired && c.accountId != app.activeAccountId) return c;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final errorKey = _errorKey;

    return Scaffold(
      appBar: AppBar(title: Text(t.loginTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (context.app.baseUrl != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(
                    context.app.baseUrl!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              TextField(
                key: const Key('login-id'),
                controller: _loginId,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(labelText: t.loginIdLabel),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('login-password'),
                controller: _password,
                obscureText: true,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(labelText: t.loginPasswordLabel),
              ),
              if (errorKey != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _message(t, errorKey),
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ),
              const SizedBox(height: 20),
              FilledButton(
                key: const Key('login-submit'),
                // 누르는 동안 막는다 — 두 번 눌러 두 세션을 만들지 않게.
                onPressed: _busy ? null : _submit,
                child: Text(_busy ? t.commonLoading : t.loginSubmit),
              ),
              // 만료된 커뮤니티에 다시 로그인하는 자리다. 다른 커뮤니티가 살아 있으면 그리로 갈 길을
              // 둔다 — 이 화면에 갇히면 비밀번호를 모르는 사람은 앱 전체를 못 쓴다.
              if (_otherLive(context) case final other?)
                TextButton(
                  key: const Key('login-other-community'),
                  onPressed: _busy ? null : () => enterCommunity(context, other.accountId),
                  child: Text(t.loginOtherCommunity),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
