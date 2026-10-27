import { useEffect, useRef, useSyncExternalStore } from 'react';
import { fmtDuration, useNow } from './util';

// Pausentimer. Gespeichert wird der Endzeitpunkt, nicht ein Zähler: Nach Sperrbildschirm
// oder Neustart der App stimmt die Restzeit trotzdem.
interface Rest {
  endAt: number;
  total: number;
}

const KEY = 'restTimer';
const listeners = new Set<() => void>();
let rest: Rest | null = load();

function load(): Rest | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Rest | null;
    return r && r.endAt > Date.now() - 60000 ? r : null;
  } catch {
    return null;
  }
}

function setRest(next: Rest | null) {
  rest = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    // Ohne Speicher läuft der Timer trotzdem, nur nicht über einen Neustart.
  }
  listeners.forEach((l) => l());
}

export function startRest(seconds: number) {
  if (seconds <= 0) return;
  unlockAudio();
  setRest({ endAt: Date.now() + seconds * 1000, total: seconds });
}

function useRest() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => rest,
  );
}

let audio: AudioContext | null = null;
// iOS spielt Töne nur, wenn der Ton-Kontext bei einem Tippen gestartet wurde.
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

function beep() {
  if (!audio) return;
  const t0 = audio.currentTime;
  for (const [i, f] of [880, 880, 1320].entries()) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.25);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.25 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.2);
    o.connect(g).connect(audio.destination);
    o.start(t0 + i * 0.25);
    o.stop(t0 + i * 0.25 + 0.22);
  }
}

export function RestTimer() {
  const r = useRest();
  const now = useNow(250);
  const rang = useRef<number | null>(null);
  const left = r ? Math.ceil((r.endAt - now) / 1000) : 0;

  useEffect(() => {
    if (r && left <= 0 && rang.current !== r.endAt) {
      rang.current = r.endAt;
      if (document.visibilityState === 'visible') beep();
      navigator.vibrate?.([200, 100, 200]);
    }
    if (r && left < -30) setRest(null);
  }, [r, left]);

  if (!r) return null;
  const done = left <= 0;
  return (
    <div className={`timer${done ? ' ring' : ''}`} role="timer" aria-live="polite">
      <div>
        <span className="time">{done ? 'Los!' : fmtDuration(left)}</span>
        {!done && (
          <>
            <button aria-label="15 Sekunden weniger" onClick={() => setRest({ ...r, endAt: r.endAt - 15000 })}>
              −15
            </button>
            <button aria-label="15 Sekunden mehr" onClick={() => setRest({ ...r, endAt: r.endAt + 15000 })}>
              +15
            </button>
          </>
        )}
        <button aria-label="Pause beenden" onClick={() => setRest(null)}>
          ✕
        </button>
      </div>
    </div>
  );
}
