function timestampDate(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return /^\d{4}-/.test(iso) ? iso : null;
}

function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toISOString();
}

export function youtubeVideoDate(entry: { _type?: string; timestamp?: unknown; upload_date?: unknown; release_timestamp?: unknown; release_date?: unknown; modified_timestamp?: unknown; modified_date?: unknown; updated_at?: unknown }) {
  let updated = calendarDate(entry.modified_date) || timestampDate(entry.modified_timestamp);
  if (!updated && typeof entry.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(entry.updated_at)) {
    const date = new Date(entry.updated_at);
    if (Number.isFinite(date.getTime())) updated = date.toISOString();
  }
  const flat = ['url', 'url_transparent'].includes(entry._type || '');
  const uploaded = flat ? null : calendarDate(entry.upload_date) || timestampDate(entry.timestamp);
  return { created_at: uploaded, updated_at: updated, created_at_is_approximate: false };
}
