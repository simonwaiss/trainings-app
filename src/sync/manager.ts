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
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  running: false,
  pending: 0,
  lastSync: null,
  error: null,
  session: null,
  authReady: false,
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

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

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
  const session = state.session;
  if (!session || !navigator.onLine) {
    set({ pending: await pendingCount() });
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
    set({ running: false, pending: await pendingCount() });
    if (again) {
      again = false;
      scheduleSync(100);
    }
  }
}

export async function startSync() {
  setChangeListener(() => {
    void pendingCount().then((pending) => set({ pending }));
    scheduleSync();
  });
  set({ pending: await pendingCount(), lastSync: (await getMeta<string>('lastSync')) ?? null });

  const { data } = await supabase.auth.getSession();
  set({ session: data.session, authReady: true });
  supabase.auth.onAuthStateChange((_event, session) => {
    set({ session });
    if (session) scheduleSync(50);
  });

  window.addEventListener('online', () => {
    set({ online: true });
    scheduleSync(50);
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(50);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') scheduleSync(0);
  }, 30000);
  scheduleSync(50);
}
