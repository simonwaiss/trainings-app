export function newId(): string {
  return crypto.randomUUID();
}

// Feste id aus einem Text (UUID-Form, Version 5 nach RFC 9562 mit SHA-1).
// Gleicher Text ergibt gleiche id: Vorbelegung und Import legen so nie etwas doppelt an.
export async function stableId(namespace: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${namespace}\u0000${text}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
