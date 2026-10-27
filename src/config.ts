// Öffentliche Werte: Adresse des Supabase-Projekts und der öffentliche Schlüssel.
// Der Schlüssel öffnet ohne Login nichts, weil jede Tabelle Zeilenrechte (RLS) hat.
// Der geheime Dienst-Schlüssel steht nie hier.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://syljfrpctitjghxenjbq.supabase.co';
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_KAayMHXc2ESoiB-0R9XJ0g_Cbabpcjt';

export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev';
export const DEFAULT_REST_SECONDS = 120;
