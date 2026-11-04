import { useEffect, useState } from 'react';
import { localDateKey } from '../lib/nightWindow';

/**
 * Today's YYYY-MM-DD in the viewer's own zone, re-rendering at local midnight.
 *
 * Never `new Date().toISOString().slice(0, 10)`: that is the UTC date, which
 * reads as tomorrow every evening west of Greenwich (after 19:00 in Iowa).
 * The timer re-arms for each midnight so a page left open overnight rolls over.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => localDateKey(new Date()));

  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    const id = setTimeout(() => setToday(localDateKey(new Date())), nextMidnight.getTime() - now.getTime());
    return () => clearTimeout(id);
  }, [today]);

  return today;
}
