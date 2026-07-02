/**
 * Herschel 400 observing program — the complete list of 400 NGC objects
 * selected by the Ancient City Astronomy Club c. 1980 from William Herschel's
 * original catalog of discoveries.
 *
 * Source: Astronomical League Herschel 400 Observing Program, cross-referenced
 * with the Wikipedia Herschel 400 Catalogue article and openngc.json.
 *
 * All IDs are normalized: uppercase, no whitespace (e.g. "NGC891").
 * Objects in this list may overlap with Messier, Caldwell, or the popular/
 * extended image-pack tiers — that is intentional. This is the complete
 * observing-program list, independent of image-pack tier membership.
 *
 * Breakdown: ~231 galaxies, ~130 clusters (open + globular), ~39 nebulae/PN
 */

export const HERSCHEL400_IDS: readonly string[] = [
  // ── Autumn / winter objects (low NGC numbers) ─────────────────────────────
  'NGC40',    // planetary nebula — Cepheus (C2)
  'NGC129',   // open cluster — Cassiopeia
  'NGC136',   // open cluster — Cassiopeia
  'NGC157',   // galaxy — Cetus
  'NGC185',   // dwarf galaxy — Cassiopeia (C18)
  'NGC205',   // dwarf galaxy — Andromeda (M110)
  'NGC225',   // open cluster — Cassiopeia
  'NGC246',   // planetary nebula — Cetus (C56)
  'NGC247',   // galaxy — Cetus (C62)
  'NGC253',   // galaxy — Sculptor (C65)
  'NGC278',   // galaxy — Cassiopeia
  'NGC288',   // globular cluster — Sculptor
  'NGC381',   // open cluster — Cassiopeia
  'NGC404',   // galaxy — Andromeda
  'NGC436',   // open cluster — Cassiopeia
  'NGC457',   // open cluster — Cassiopeia (C13)
  'NGC488',   // galaxy — Pisces
  'NGC524',   // galaxy — Pisces
  'NGC559',   // open cluster — Cassiopeia (C8)
  'NGC584',   // galaxy — Cetus
  'NGC596',   // galaxy — Cetus
  'NGC598',   // galaxy — Triangulum (M33)
  'NGC613',   // galaxy — Sculptor
  'NGC615',   // galaxy — Cetus
  'NGC637',   // open cluster — Cassiopeia
  'NGC650',   // planetary nebula — Perseus (M76 Little Dumbbell)
  'NGC654',   // open cluster — Cassiopeia
  'NGC659',   // open cluster — Cassiopeia
  'NGC663',   // open cluster — Cassiopeia (C10)
  'NGC720',   // galaxy — Cetus
  'NGC752',   // open cluster — Andromeda (C28)
  'NGC772',   // galaxy — Aries
  'NGC779',   // galaxy — Cetus
  'NGC869',   // open cluster — Perseus (C14, h Persei)
  'NGC884',   // open cluster — Perseus (C14, chi Persei)
  'NGC891',   // galaxy — Andromeda (C23)
  'NGC908',   // galaxy — Cetus
  'NGC936',   // galaxy — Cetus
  'NGC1022',  // galaxy — Cetus
  'NGC1023',  // galaxy — Perseus
  'NGC1027',  // open cluster — Cassiopeia
  'NGC1052',  // galaxy — Cetus
  'NGC1055',  // galaxy — Cetus
  'NGC1084',  // galaxy — Eridanus
  'NGC1245',  // open cluster — Perseus
  'NGC1342',  // open cluster — Perseus
  'NGC1407',  // galaxy — Eridanus
  'NGC1444',  // open cluster — Perseus
  'NGC1501',  // planetary nebula — Camelopardalis
  'NGC1502',  // open cluster — Camelopardalis
  'NGC1513',  // open cluster — Perseus
  'NGC1528',  // open cluster — Perseus
  'NGC1535',  // planetary nebula — Eridanus
  'NGC1545',  // open cluster — Perseus
  'NGC1647',  // open cluster — Taurus
  'NGC1664',  // open cluster — Auriga
  'NGC1788',  // reflection nebula — Orion
  'NGC1817',  // open cluster — Taurus
  'NGC1857',  // open cluster — Auriga
  'NGC1907',  // open cluster — Auriga
  'NGC1931',  // cluster + nebula — Auriga
  'NGC1961',  // galaxy — Camelopardalis
  'NGC1964',  // galaxy — Lepus
  'NGC1980',  // open cluster — Orion (Lower Sword)
  'NGC1999',  // reflection nebula — Orion
  'NGC2022',  // planetary nebula — Orion
  'NGC2024',  // emission nebula — Orion (Flame Nebula)
  'NGC2126',  // open cluster — Auriga
  'NGC2129',  // open cluster — Gemini
  'NGC2158',  // open cluster — Gemini
  'NGC2169',  // open cluster — Orion (37 Cluster)
  'NGC2185',  // reflection nebula — Orion
  'NGC2186',  // open cluster — Orion
  'NGC2194',  // open cluster — Orion
  'NGC2204',  // open cluster — Canis Major
  'NGC2215',  // open cluster — Monoceros
  'NGC2232',  // open cluster — Monoceros
  'NGC2244',  // open cluster — Monoceros (C50, Rosette cluster)
  'NGC2251',  // open cluster — Monoceros
  'NGC2264',  // cluster + nebula — Monoceros (Christmas Tree)
  'NGC2266',  // open cluster — Gemini
  'NGC2281',  // open cluster — Auriga
  'NGC2286',  // open cluster — Monoceros
  'NGC2301',  // open cluster — Monoceros (Great Bird Cluster)
  'NGC2304',  // open cluster — Gemini
  'NGC2311',  // open cluster — Monoceros
  'NGC2324',  // open cluster — Monoceros
  'NGC2335',  // open cluster — Monoceros
  'NGC2343',  // open cluster — Monoceros
  'NGC2353',  // open cluster — Monoceros
  'NGC2354',  // open cluster — Canis Major
  'NGC2355',  // open cluster — Gemini
  'NGC2360',  // open cluster — Canis Major (C58)
  'NGC2362',  // open cluster — Canis Major (C64)
  'NGC2371',  // planetary nebula — Gemini (Twin Jet / Peanut Nebula)
  'NGC2392',  // planetary nebula — Gemini (C39, Eskimo)
  'NGC2395',  // open cluster — Gemini
  'NGC2403',  // galaxy — Camelopardalis (C7)
  'NGC2419',  // globular cluster — Lynx (C25, Intergalactic Wanderer)
  'NGC2420',  // open cluster — Gemini
  'NGC2421',  // open cluster — Puppis
  'NGC2422',  // open cluster — Puppis (M47)
  'NGC2423',  // open cluster — Puppis
  'NGC2438',  // planetary nebula — Puppis (in M46 field)
  'NGC2440',  // planetary nebula — Puppis
  'NGC2479',  // open cluster — Puppis
  'NGC2482',  // open cluster — Puppis
  'NGC2489',  // open cluster — Puppis
  'NGC2506',  // open cluster — Monoceros (C54)
  'NGC2509',  // open cluster — Puppis
  'NGC2527',  // open cluster — Puppis
  'NGC2539',  // open cluster — Puppis
  'NGC2548',  // open cluster — Hydra (M48)
  'NGC2567',  // open cluster — Puppis
  'NGC2571',  // open cluster — Puppis
  'NGC2613',  // galaxy — Pyxis
  'NGC2627',  // open cluster — Pyxis
  'NGC2655',  // galaxy — Camelopardalis
  'NGC2681',  // galaxy — Ursa Major
  'NGC2683',  // galaxy — Lynx (UFO Galaxy)
  'NGC2742',  // galaxy — Ursa Major
  'NGC2768',  // galaxy — Ursa Major
  'NGC2775',  // galaxy — Cancer (C48)
  'NGC2782',  // galaxy — Lynx
  'NGC2787',  // galaxy — Ursa Major
  'NGC2811',  // galaxy — Hydra
  'NGC2841',  // galaxy — Ursa Major
  'NGC2859',  // galaxy — Leo Minor
  'NGC2903',  // galaxy — Leo
  'NGC2950',  // galaxy — Ursa Major
  'NGC2964',  // galaxy — Leo
  'NGC2974',  // galaxy — Sextans
  'NGC2976',  // galaxy — Ursa Major
  'NGC2985',  // galaxy — Ursa Major

  // ── Spring objects ────────────────────────────────────────────────────────
  'NGC3034',  // galaxy — Ursa Major (M82, Cigar Galaxy)
  'NGC3077',  // galaxy — Ursa Major
  'NGC3079',  // galaxy — Ursa Major
  'NGC3115',  // galaxy — Sextans (C53, Spindle Galaxy)
  'NGC3147',  // galaxy — Draco
  'NGC3166',  // galaxy — Sextans
  'NGC3169',  // galaxy — Sextans
  'NGC3184',  // galaxy — Ursa Major
  'NGC3190',  // galaxy — Leo
  'NGC3193',  // galaxy — Leo
  'NGC3198',  // galaxy — Ursa Major
  'NGC3226',  // galaxy — Leo
  'NGC3227',  // galaxy — Leo
  'NGC3242',  // planetary nebula — Hydra (C59, Ghost of Jupiter)
  'NGC3245',  // galaxy — Leo Minor
  'NGC3277',  // galaxy — Leo Minor
  'NGC3294',  // galaxy — Leo Minor
  'NGC3310',  // galaxy — Ursa Major
  'NGC3344',  // galaxy — Leo Minor
  'NGC3377',  // galaxy — Leo
  'NGC3379',  // galaxy — Leo (M105)
  'NGC3384',  // galaxy — Leo
  'NGC3395',  // galaxy — Leo Minor
  'NGC3412',  // galaxy — Leo
  'NGC3414',  // galaxy — Leo Minor
  'NGC3432',  // galaxy — Leo Minor
  'NGC3486',  // galaxy — Leo Minor
  'NGC3489',  // galaxy — Leo
  'NGC3504',  // galaxy — Leo Minor
  'NGC3521',  // galaxy — Leo
  'NGC3556',  // galaxy — Ursa Major (M108)
  'NGC3593',  // galaxy — Leo
  'NGC3607',  // galaxy — Leo
  'NGC3608',  // galaxy — Leo
  'NGC3610',  // galaxy — Ursa Major
  'NGC3613',  // galaxy — Ursa Major
  'NGC3619',  // galaxy — Ursa Major
  'NGC3621',  // galaxy — Hydra
  'NGC3626',  // galaxy — Leo (C40)
  'NGC3628',  // galaxy — Leo (Hamburger Galaxy)
  'NGC3631',  // galaxy — Ursa Major
  'NGC3640',  // galaxy — Leo
  'NGC3655',  // galaxy — Leo
  'NGC3665',  // galaxy — Ursa Major
  'NGC3675',  // galaxy — Ursa Major
  'NGC3686',  // galaxy — Leo
  'NGC3726',  // galaxy — Ursa Major
  'NGC3729',  // galaxy — Ursa Major
  'NGC3810',  // galaxy — Leo
  'NGC3813',  // galaxy — Ursa Major
  'NGC3877',  // galaxy — Ursa Major
  'NGC3893',  // galaxy — Ursa Major
  'NGC3898',  // galaxy — Ursa Major
  'NGC3900',  // galaxy — Leo
  'NGC3912',  // galaxy — Leo
  'NGC3938',  // galaxy — Ursa Major
  'NGC3941',  // galaxy — Ursa Major
  'NGC3945',  // galaxy — Ursa Major
  'NGC3949',  // galaxy — Ursa Major
  'NGC3953',  // galaxy — Ursa Major
  'NGC3962',  // galaxy — Crater
  'NGC3982',  // galaxy — Ursa Major
  'NGC3992',  // galaxy — Ursa Major (M109)
  'NGC3998',  // galaxy — Ursa Major
  'NGC4026',  // galaxy — Ursa Major
  'NGC4027',  // galaxy — Corvus
  'NGC4030',  // galaxy — Virgo
  'NGC4036',  // galaxy — Ursa Major
  'NGC4038',  // galaxy — Corvus (C60, Antennae)
  'NGC4039',  // galaxy — Corvus (C61, Antennae)
  'NGC4041',  // galaxy — Ursa Major
  'NGC4051',  // galaxy — Ursa Major
  'NGC4085',  // galaxy — Ursa Major
  'NGC4088',  // galaxy — Ursa Major
  'NGC4102',  // galaxy — Ursa Major
  'NGC4111',  // galaxy — Canes Venatici
  'NGC4143',  // galaxy — Canes Venatici
  'NGC4147',  // globular cluster — Coma Berenices
  'NGC4150',  // galaxy — Coma Berenices
  'NGC4151',  // galaxy — Canes Venatici
  'NGC4179',  // galaxy — Virgo
  'NGC4203',  // galaxy — Coma Berenices
  'NGC4214',  // galaxy — Canes Venatici
  'NGC4216',  // galaxy — Virgo
  'NGC4245',  // galaxy — Coma Berenices
  'NGC4251',  // galaxy — Coma Berenices
  'NGC4258',  // galaxy — Canes Venatici (M106)
  'NGC4261',  // galaxy — Virgo
  'NGC4273',  // galaxy — Virgo
  'NGC4274',  // galaxy — Coma Berenices
  'NGC4278',  // galaxy — Coma Berenices
  'NGC4281',  // galaxy — Virgo
  'NGC4293',  // galaxy — Coma Berenices
  'NGC4303',  // galaxy — Virgo (M61)
  'NGC4314',  // galaxy — Coma Berenices
  'NGC4346',  // galaxy — Canes Venatici
  'NGC4350',  // galaxy — Coma Berenices
  'NGC4361',  // planetary nebula — Corvus
  'NGC4365',  // galaxy — Virgo
  'NGC4371',  // galaxy — Virgo
  'NGC4394',  // galaxy — Coma Berenices
  'NGC4414',  // galaxy — Coma Berenices
  'NGC4419',  // galaxy — Coma Berenices
  'NGC4429',  // galaxy — Virgo
  'NGC4435',  // galaxy — Virgo (The Eyes)
  'NGC4438',  // galaxy — Virgo (The Eyes)
  'NGC4442',  // galaxy — Virgo
  'NGC4448',  // galaxy — Coma Berenices
  'NGC4449',  // galaxy — Canes Venatici (C21)
  'NGC4450',  // galaxy — Coma Berenices
  'NGC4459',  // galaxy — Coma Berenices
  'NGC4473',  // galaxy — Coma Berenices
  'NGC4477',  // galaxy — Coma Berenices
  'NGC4478',  // galaxy — Virgo
  'NGC4494',  // galaxy — Coma Berenices
  'NGC4526',  // galaxy — Virgo
  'NGC4527',  // galaxy — Virgo
  'NGC4535',  // galaxy — Virgo
  'NGC4536',  // galaxy — Virgo
  'NGC4546',  // galaxy — Virgo
  'NGC4559',  // galaxy — Coma Berenices (C36)
  'NGC4564',  // galaxy — Virgo
  'NGC4565',  // galaxy — Coma Berenices (C38, Needle Galaxy)
  'NGC4570',  // galaxy — Virgo
  'NGC4596',  // galaxy — Virgo
  'NGC4618',  // galaxy — Canes Venatici
  'NGC4631',  // galaxy — Canes Venatici (C32, Whale Galaxy)
  'NGC4636',  // galaxy — Virgo
  'NGC4643',  // galaxy — Virgo
  'NGC4654',  // galaxy — Virgo
  'NGC4656',  // galaxy — Canes Venatici (Hockey Stick)
  'NGC4660',  // galaxy — Virgo
  'NGC4666',  // galaxy — Virgo
  'NGC4689',  // galaxy — Coma Berenices
  'NGC4697',  // galaxy — Virgo (C52)
  'NGC4698',  // galaxy — Virgo
  'NGC4699',  // galaxy — Virgo
  'NGC4753',  // galaxy — Virgo
  'NGC4754',  // galaxy — Virgo
  'NGC4762',  // galaxy — Virgo
  'NGC4772',  // galaxy — Virgo
  'NGC4781',  // galaxy — Virgo
  'NGC4845',  // galaxy — Virgo
  'NGC4866',  // galaxy — Virgo
  'NGC4900',  // galaxy — Virgo
  'NGC4958',  // galaxy — Virgo
  'NGC4995',  // galaxy — Virgo
  'NGC5005',  // galaxy — Canes Venatici (C29)
  'NGC5033',  // galaxy — Canes Venatici
  'NGC5054',  // galaxy — Virgo
  'NGC5077',  // galaxy — Virgo
  'NGC5084',  // galaxy — Virgo
  'NGC5102',  // galaxy — Centaurus
  'NGC5128',  // galaxy — Centaurus (C77, Centaurus A)
  'NGC5195',  // galaxy — Canes Venatici (M51b)
  'NGC5248',  // galaxy — Boötes (C45)
  'NGC5273',  // galaxy — Canes Venatici
  'NGC5322',  // galaxy — Ursa Major
  'NGC5363',  // galaxy — Virgo
  'NGC5377',  // galaxy — Canes Venatici
  'NGC5466',  // globular cluster — Boötes
  'NGC5473',  // galaxy — Ursa Major
  'NGC5557',  // galaxy — Boötes
  'NGC5566',  // galaxy — Virgo
  'NGC5576',  // galaxy — Virgo
  'NGC5634',  // globular cluster — Virgo
  'NGC5638',  // galaxy — Virgo
  'NGC5643',  // galaxy — Lupus
  'NGC5676',  // galaxy — Boötes
  'NGC5694',  // globular cluster — Hydra (C66)
  'NGC5813',  // galaxy — Virgo
  'NGC5831',  // galaxy — Virgo
  'NGC5838',  // galaxy — Virgo
  'NGC5846',  // galaxy — Virgo
  'NGC5866',  // galaxy — Draco
  'NGC5897',  // globular cluster — Libra

  // ── Summer objects ────────────────────────────────────────────────────────
  'NGC5982',  // galaxy — Draco
  'NGC6118',  // galaxy — Serpens Caput
  'NGC6144',  // globular cluster — Scorpius
  'NGC6207',  // galaxy — Hercules
  'NGC6210',  // planetary nebula — Hercules
  'NGC6217',  // galaxy — Ursa Minor
  'NGC6229',  // globular cluster — Hercules
  'NGC6235',  // globular cluster — Ophiuchus
  'NGC6284',  // globular cluster — Ophiuchus
  'NGC6287',  // globular cluster — Ophiuchus
  'NGC6293',  // globular cluster — Ophiuchus
  'NGC6304',  // globular cluster — Ophiuchus
  'NGC6316',  // globular cluster — Ophiuchus
  'NGC6342',  // globular cluster — Ophiuchus
  'NGC6355',  // globular cluster — Ophiuchus
  'NGC6356',  // globular cluster — Ophiuchus
  'NGC6369',  // planetary nebula — Ophiuchus (Little Ghost Nebula)
  'NGC6401',  // globular cluster — Ophiuchus
  'NGC6426',  // globular cluster — Ophiuchus
  'NGC6440',  // globular cluster — Sagittarius
  'NGC6451',  // open cluster — Scorpius
  'NGC6517',  // globular cluster — Ophiuchus
  'NGC6520',  // open cluster — Sagittarius
  'NGC6522',  // globular cluster — Sagittarius
  'NGC6528',  // globular cluster — Sagittarius
  'NGC6540',  // globular cluster — Sagittarius
  'NGC6543',  // planetary nebula — Draco (C6, Cat's Eye Nebula)
  'NGC6544',  // globular cluster — Sagittarius
  'NGC6553',  // globular cluster — Sagittarius
  'NGC6568',  // open cluster — Sagittarius
  'NGC6569',  // globular cluster — Sagittarius
  'NGC6572',  // planetary nebula — Ophiuchus
  'NGC6583',  // open cluster — Sagittarius
  'NGC6584',  // globular cluster — Telescopium
  'NGC6604',  // open cluster — Serpens Cauda
  'NGC6624',  // globular cluster — Sagittarius
  'NGC6629',  // planetary nebula — Sagittarius
  'NGC6638',  // globular cluster — Sagittarius
  'NGC6642',  // globular cluster — Sagittarius
  'NGC6645',  // open cluster — Sagittarius
  'NGC6664',  // open cluster — Scutum
  'NGC6712',  // globular cluster — Scutum
  'NGC6717',  // globular cluster — Sagittarius
  'NGC6723',  // globular cluster — Sagittarius
  'NGC6741',  // planetary nebula — Aquila (Phantom Streak Nebula)
  'NGC6745',  // interacting galaxies — Lyra
  'NGC6755',  // open cluster — Aquila
  'NGC6756',  // open cluster — Aquila
  'NGC6760',  // globular cluster — Aquila
  'NGC6790',  // planetary nebula — Aquila
  'NGC6802',  // open cluster — Vulpecula
  'NGC6823',  // open cluster — Vulpecula
  'NGC6826',  // planetary nebula — Cygnus (C15, Blinking Planetary)
  'NGC6830',  // open cluster — Vulpecula
  'NGC6834',  // open cluster — Cygnus
  'NGC6866',  // open cluster — Cygnus
  'NGC6885',  // open cluster — Vulpecula (C37)
  'NGC6910',  // open cluster — Cygnus
  'NGC6934',  // globular cluster — Delphinus (C47)
  'NGC6939',  // open cluster — Cepheus
  'NGC6940',  // open cluster — Vulpecula
  'NGC6946',  // galaxy — Cepheus (C12, Fireworks Galaxy)

  // ── Autumn objects (high NGC numbers) ────────────────────────────────────
  'NGC7006',  // globular cluster — Delphinus (C42)
  'NGC7008',  // planetary nebula — Cygnus
  'NGC7009',  // planetary nebula — Aquarius (C55, Saturn Nebula)
  'NGC7026',  // planetary nebula — Cygnus
  'NGC7044',  // open cluster — Cygnus
  'NGC7062',  // open cluster — Cygnus
  'NGC7086',  // open cluster — Cygnus
  'NGC7128',  // open cluster — Cygnus
  'NGC7142',  // open cluster — Cepheus
  'NGC7160',  // open cluster — Cepheus
  'NGC7209',  // open cluster — Lacerta
  'NGC7217',  // galaxy — Pegasus
  'NGC7243',  // open cluster — Lacerta (C16)
  'NGC7261',  // open cluster — Cepheus
  'NGC7331',  // galaxy — Pegasus (C30)
  'NGC7448',  // galaxy — Pegasus
  'NGC7479',  // galaxy — Pegasus (C44)
  'NGC7510',  // open cluster — Cepheus
  'NGC7606',  // galaxy — Aquarius
  'NGC7619',  // galaxy — Pegasus
  'NGC7626',  // galaxy — Pegasus
  'NGC7662',  // planetary nebula — Andromeda (C22, Blue Snowball)
  'NGC7686',  // open cluster — Andromeda
  'NGC7723',  // galaxy — Aquarius
  'NGC7727',  // galaxy — Aquarius
  'NGC7789',  // open cluster — Cassiopeia (Caroline's Rose)
  'NGC7790',  // open cluster — Cassiopeia
  'NGC7814',  // galaxy — Pegasus (C43)
];
