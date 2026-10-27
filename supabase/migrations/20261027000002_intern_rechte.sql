-- Das Schema intern braucht die App-Rolle nicht: Auslöser laufen ohne diese Rechte.
-- Weniger Rechte, weniger Angriffsfläche (Prüfung 27.10.2026, Befund k6).
revoke usage on schema intern from authenticated;
revoke execute on function intern.set_updated_at() from authenticated;
