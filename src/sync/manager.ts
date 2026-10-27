import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { SUPABASE_KEY, SUPABASE_URL } from '../config';
import { getMeta, pendingCount, setChangeListener, setMeta } from '../db/local';
import { seedPlanIfEmpty } from '../data/ops';
import { supabaseRemote } from './remote-supabase';
import { syncOnce } from './sync';

export interface SyncState {
  online: boolean;
  running: boolean;
  pending: number;
  lastSync: string | null;
  error: string | null;
  session: Session | null;
  authReady: boolean;
  signedOut: boolean; // nur nach ausdrücklichem Abmelden oder ungültiger Anmeldung, nicht bei fehlendem Netz
  held: number; // vom Server abgelehnte, zurückgehaltene Zeilen
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  running: false,
  pending: 0,
  lastSync: null,
  error: null,
  session: null,
  authReady: false,
  signedOut: false,
  held: 0,
};
const listeners = new Set<() => void>();

function set(next: Partial<SyncState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useSync(): SyncState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// Jede Anfrage bricht nach 20 s ab: Bei schwachem Netz hängt der Abgleich sonst, bis iOS aufgibt.
const TIMEOUT_MS = 20000;
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init?.signal && 'any' in AbortSignal ? AbortSignal.any([init.signal, timeout]) : (init?.signal ?? timeout);
  return fetch(input, { ...init, signal });
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  global: { fetch: fetchWithTimeout },
});

async function counts() {
  return { pending: await pendingCount(1), held: await pendingCount(2) };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 2000;
let again = false;

export function scheduleSync(delay = 800) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runSync(), delay);
}

export async function runSync() {
  if (state.running) {
    again = true;
    return;
  }
  let session = state.session;
  // Ohne gültige Anmeldung, aber mit Netz: die gespeicherte Anmeldung jetzt erneuern (etwa nach einem Funkloch).
  if (!session && navigator.onLine && !state.signedOut) {
    session = (await supabase.auth.getSession().catch(() => null))?.data.session ?? null;
    if (session) set({ session });
  }
  if (!session || !navigator.onLine) {
    set(await counts());
    return;
  }
  set({ running: true });
  try {
    await syncOnce(supabaseRemote(supabase), session.user.id);
    // Nach dem ersten erfolgreichen Abgleich: Trainingsplan anlegen, falls beim Server noch nichts liegt.
    if (!(await getMeta('seedChecked'))) {
      if (await seedPlanIfEmpty()) again = true;
      await setMeta('seedChecked', true);
    }
    retryMs = 2000;
    set({ error: null, lastSync: (await getMeta<string>('lastSync')) ?? null });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
    // Später erneut versuchen, mit wachsendem Abstand bis höchstens 1 Minute.
    retryMs = Math.min(retryMs * 2, 60000);
    scheduleSync(retryMs);
  } finally {
    set({ running: false, ...(await counts()) });
    if (again) {
      again = false;
      scheduleSync(100);
    }
  }
}

export async function startSync() {
  // Zuerst die Ereignisse anmelden: Das Erneuern der Anmeldung kann ohne Netz lange dauern,
  // und ein „wieder online“ in dieser Zeit darf nicht verloren gehen.
  window.addEventListener('online', () => {
    set({ online: true });
    scheduleSync(50);
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(50);
  });
  setInterval(() => {
    if (navigator.onLine !== state.online) set({ online: navigator.onLine });
    if (document.visibilityState === 'visible') scheduleSync(0);
  }, 30000);
  setChangeListener(() => {
    void counts().then((c) => set(c));
    scheduleSync();
  });
  set({ ...(await counts()), lastSync: (await getMeta<string>('lastSync')) ?? null });

  // Ohne Netz kann das Erneuern einer abgelaufenen Anmeldung lange dauern; die App wartet darauf nicht
  // (siehe App.tsx), sie zeigt die lokale Kopie sofort.
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') set({ session: null, signedOut: true });
    else if (session) set({ session, signedOut: false });
    if (session) scheduleSync(50);
  });
  const { data } = await supabase.auth.getSession();
  set({ session: data.session ?? state.session, authReady: true, online: navigator.onLine });
  scheduleSync(50);
}
