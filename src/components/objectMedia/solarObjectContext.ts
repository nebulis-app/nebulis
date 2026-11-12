import { createContext, useContext } from 'react';

/** True inside the object media view of the Sun. Its captures are made by day, so labels that say "night" read "day". */
export const SolarObjectContext = createContext(false);

/** Options for `t()`: i18next looks up `key_sun` first and falls back to `key`, so a language without the variant
 *  still reads. Spread it into the options of any string that says "night". */
export function useSunWording(): { context?: 'sun' } {
  return useContext(SolarObjectContext) ? { context: 'sun' } : {};
}
