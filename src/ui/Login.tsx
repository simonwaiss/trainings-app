import { useState } from 'react';
import { SUPABASE_KEY, SUPABASE_URL } from '../config';
import { supabase } from '../sync/manager';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') {
        // Legt beim allerersten Mal Simons Konto an. Die Datenbank lässt nur seine Adresse zu, und nur ein einziges Konto.
        const r = await fetch(`${SUPABASE_URL}/functions/v1/konto-einrichten`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
          body: JSON.stringify({ email, password }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Einrichten fehlgeschlagen (${r.status})`);
        }
      }
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) throw new Error(err.message === 'Invalid login credentials' ? 'Adresse oder Passwort falsch.' : err.message);
    } catch (err) {
      setError(err instanceof Error ? (err.message === 'Failed to fetch' ? 'Kein Netz. Zum ersten Anmelden braucht die App Internet.' : err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ paddingTop: 40 }}>
      <h1 style={{ fontSize: 26 }}>Training</h1>
      <p className="muted">{mode === 'login' ? 'Anmelden' : 'Konto einrichten (nur beim allerersten Mal)'}</p>
      <form onSubmit={submit}>
        <label className="field">
          <span>E-Mail</span>
          <input className="text" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Passwort{mode === 'setup' ? ' (mindestens 10 Zeichen)' : ''}</span>
          <input
            className="text"
            type="password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'setup' ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="banner">{error}</div>}
        <button className="btn primary block" disabled={busy} type="submit">
          {busy ? 'Einen Moment …' : mode === 'login' ? 'Anmelden' : 'Konto einrichten'}
        </button>
      </form>
      <button className="link" onClick={() => setMode(mode === 'login' ? 'setup' : 'login')} style={{ marginTop: 12 }}>
        {mode === 'login' ? 'Erstes Mal hier? Konto einrichten' : 'Ich habe schon ein Konto'}
      </button>
    </div>
  );
}
