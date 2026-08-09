import { useEffect, useState } from 'react';
import type { Anatomy, Facts, Positioning } from './types';

/**
 * Fetch a published JSON file once, cache it in memory, and expose it as a hook.
 * Same-origin only ("/api/..."), so no third-party request. The data is the
 * archive's output; the app is a viewer over it.
 */
const cache = new Map<string, unknown>();

export function useJson<T>(path: string): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>((cache.get(path) as T) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache.has(path)) { setData(cache.get(path) as T); return; }
    let alive = true;
    fetch(path, { credentials: 'omit' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j) => { cache.set(path, j); if (alive) setData(j as T); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [path]);

  return { data, error };
}

export const usePositioning = () => useJson<Positioning>('/api/positioning.json');
export const useAnatomy = () => useJson<Anatomy>('/api/anatomy.json');
export const useFacts = () => useJson<Facts>('/api/facts.json');
