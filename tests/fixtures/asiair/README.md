# Real ZWO ASIAIR headers

FITS headers written by an ASIAIR (firmware of 2026), copied card for card from frames of a real rig:

- Askar 91F at 609–611 mm with its reducer
- ZWO ASI585MC Air, cooled to −8 °C or −10 °C, offset 15
- ZWO EFW holding a dual-band filter in the slot named `H`, another in `SII`, a `None` slot for broadband, and a blank slot named `Dark`
- ZWO CAA rotator (`ROTATOR`, also the `_Ndeg` token in file names)
- ZWO AM3N harmonic mount (written as `TELESCOP`)
- ZWO ASI220MM Air guide camera (`GUIDECAM`)

Each `.hdr` file is one header, one 80-column card per line, ending with `END`. The file name is the original frame's name. `tests/backend/helpers/asiairFixtures.ts` turns a header into a small valid FITS file (8 × 8 pixels; only `NAXIS1`/`NAXIS2` change) for the tests that read files.

The site's coordinates (`SITELAT`, `SITELONG` and similar) were left out on purpose. Everything else is as the ASIAIR wrote it. `Light_SH2-131_…_0091.hdr` holds only the cards relevant to import; its name is the older form with neither gain nor temperature in it.

What these headers show:

- `ROTATOR` changes between nights (3°, 4°, 6°), and within one night after a meridian flip: the same night's frames are named `184deg` before the flip and `3deg` after it.
- `TELESCOP` names the mount. The optics only show through `FOCALLEN`.
- `OFFSET` and `SET-TEMP` are always written.
- `DATE-OBS` is UTC. The time in the file name is local.
- Lights carry a full plate solution (`CTYPE`, `CRVAL`, `CD`, SIP), RA/DEC in decimal degrees and no `OBJCTRA`/`OBJCTDEC`.
- Darks and bias are shot with the filter wheel on its blank slot, so `FILTER = 'Dark'`.
