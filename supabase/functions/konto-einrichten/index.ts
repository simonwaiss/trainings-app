// Legt beim allerersten Mal Simons Konto an, ohne Bestätigungs-Mail (die kostenlose Mail von Supabase
// geht nur an Mitglieder der Organisation). Danach ist die Funktion wirkungslos:
// Sie lehnt ab, sobald es ein Konto gibt, und die Datenbank lässt ohnehin nur Simons Adresse und nur ein Konto zu
// (Auslöser intern.nur_erlaubte_konten).
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = ['https://simonwaiss.github.io', 'http://localhost:5199', 'http://localhost:5198'];

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function secretKey(): string {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) return JSON.parse(keys)['default'];
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Nur POST' }), { status: 405, headers });

  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password || password.length < 10) {
    return new Response(JSON.stringify({ error: 'E-Mail und Passwort (mindestens 10 Zeichen) nötig.' }), { status: 400, headers });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), { auth: { persistSession: false } });
  const { data: existing, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (listError) return new Response(JSON.stringify({ error: 'Server nicht bereit.' }), { status: 500, headers });
  if (existing.users.length > 0) {
    return new Response(JSON.stringify({ error: 'Es gibt schon ein Konto. Bitte anmelden.' }), { status: 403, headers });
  }

  const { error } = await admin.auth.admin.createUser({ email: email.trim().toLowerCase(), password, email_confirm: true });
  if (error) {
    return new Response(JSON.stringify({ error: 'Diese Adresse ist nicht freigeschaltet.' }), { status: 403, headers });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});
