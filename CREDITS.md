# Credits

## Deep-sky artwork

The banner artwork in `src/assets/heroes/` comes from the
[NASA Image and Video Library](https://images.nasa.gov). NASA content is
generally not copyrighted and may be used without requesting permission; NASA
asks that the credit line be carried, which is what this file is for.

| File | Subject | Credit | NASA id |
|---|---|---|---|
| `bubble.webp` | The Bubble Nebula, NGC 7635 | NASA, ESA, STScI | `GSFC_20171208_Archive_e000382` |
| `cosmic-cliffs.webp` | The Cosmic Cliffs in the Carina Nebula | NASA, ESA, CSA, STScI | `carina_nebula` |
| `westerlund.webp` | The star cluster Westerlund 2 | NASA, ESA, STScI | `GSFC_20171208_Archive_e000742` |
| `mystic-mountain.webp` | Mystic Mountain, a pillar in the Carina Nebula | NASA, ESA, STScI | `GSFC_20171208_Archive_e002064` |
| `southern-ring.webp` | The Southern Ring Nebula | NASA, ESA, CSA, STScI | `southern_ring_nebula` |
| `horsehead.webp` | The Horsehead Nebula | NASA, ESA, STScI | `GSFC_20171208_Archive_e001518` |

Each file is a 1400x820 WebP re-encode of the NASA original, cropped and
compressed for use as a page background. The originals are available from
`https://images.nasa.gov/details/<NASA id>`.

**If you add one**, take it from images.nasa.gov rather than an ESA-hosted
mirror. ESA releases (esahubble.org, esawebb.org) are CC BY 4.0, which carries a
mandatory attribution obligation rather than the voluntary one above, and would
need a visible in-app credit.

The same table is kept in machine-readable form in `src/lib/heroImagery.ts`.

## Sky survey imagery

Catalog object images are cut from the Digitized Sky Survey (DSS2), fetched on
demand and cached locally. The DSS was produced at the Space Telescope Science
Institute under U.S. Government grant NAG W-2166.
