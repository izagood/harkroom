import { useState } from 'react';
import { ApiClient, ApiError } from '../lib/api';

export function ConnectScreen({ onConnected, initialError = null }: { onConnected: (baseUrl: string, token: string) => void; initialError?: string | null }) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:3400');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapMode, setBootstrapMode] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient(baseUrl);
      if (bootstrapMode) await api.bootstrap(handle, displayName || handle, password);
      const { token } = await api.login(handle, password);
      onConnected(api.baseUrl, token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded border border-zinc-300 px-3 py-2';
  return (
    <div className="flex h-screen items-center justify-center bg-zinc-100">
      <form
        className="w-80 space-y-3 rounded-lg bg-white p-6 shadow"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <h1 className="text-lg font-bold">murmur</h1>
        <label className="block text-xs font-medium">
          Server URL
          <input className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="block text-xs font-medium">
          Handle
          <input className={field} value={handle} onChange={(e) => setHandle(e.target.value)} />
        </label>
        {bootstrapMode && (
          <label className="block text-xs font-medium">
            Display name
            <input className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label className="block text-xs font-medium">
          Password
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-indigo-600 py-2 font-medium text-white disabled:opacity-50"
        >
          {bootstrapMode ? 'Create account' : 'Sign in'}
        </button>
        <button
          type="button"
          className="w-full text-xs text-zinc-500 underline"
          onClick={() => setBootstrapMode((v) => !v)}
        >
          {bootstrapMode ? 'Back to sign in' : 'First run? Create the admin account'}
        </button>
      </form>
    </div>
  );
}
