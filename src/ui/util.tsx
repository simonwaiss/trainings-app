import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DEFAULT_REST_SECONDS } from '../config';

// ---------- Navigation über den Teil nach # (funktioniert auf GitHub Pages ohne Server) ----------

function currentRoute() {
  return location.hash.replace(/^#/, '') || '/';
}

export function useRoute(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
    currentRoute,
  );
}

export function go(path: string) {
  location.hash = path;
}

// ---------- Anzeige ----------

const dateFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));
export const fmtShort = (iso: string) => shortFmt.format(new Date(iso));
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

export function fmtKg(n: number | null | undefined) {
  if (n == null) return '';
  return Number.isInteger(n) ? String(n) : n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

export function fmtDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function parseNum(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// Zahlenfeld: hält den getippten Text selbst, damit „7,“ beim Tippen nicht zu „7“ springt.
export function NumInput(props: {
  value: number | null;
  placeholder?: string;
  decimal?: boolean;
  label: string;
  onCommit: (n: number | null) => void;
}) {
  const [text, setText] = useState(fmtKg(props.value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmtKg(props.value));
  }, [props.value]);
  return (
    <input
      className="num"
      aria-label={props.label}
      inputMode={props.decimal ? 'decimal' : 'numeric'}
      enterKeyHint="next"
      autoComplete="off"
      value={text}
      placeholder={props.placeholder}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(fmtKg(props.value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNum(e.target.value);
        if (e.target.value.trim() === '' || n != null) props.onCommit(props.decimal || n == null ? n : Math.round(n));
      }}
    />
  );
}

// ---------- Einstellungen je Gerät ----------

function readSetting<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`setting:${key}`);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export const settings = {
  get restSeconds() {
    return readSetting('restSeconds', DEFAULT_REST_SECONDS);
  },
  set restSeconds(v: number) {
    localStorage.setItem('setting:restSeconds', JSON.stringify(v));
  },
};
