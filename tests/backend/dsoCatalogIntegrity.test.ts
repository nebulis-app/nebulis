import { describe, it, expect } from 'vitest';
import { DSO_RECORDS, recordFor, normalizeCatalogNumber } from '../../server/lib/dsoCatalogData';
import { resolveCanonicalId } from '../../server/lib/catalogAliases';
import { getAlsoKnownAs, getCatalogEntry } from '../../server/data/catalog';

// The rules a hand edit to server/data/dso-catalog.json has to keep. The file is
// the single source for every object's names and catalog numbers, so these are
// what stops it drifting the way the five files it replaced did.

// https://en.wikipedia.org/wiki/List_of_Messier_objects (checked 2026-10-19).
// M40 (Winnecke 4) and M45 (Pleiades) have no NGC/IC number.
const MESSIER_NGC: Record<number, string> = {1:'NGC1952',2:'NGC7089',3:'NGC5272',4:'NGC6121',5:'NGC5904',6:'NGC6405',7:'NGC6475',8:'NGC6523',9:'NGC6333',10:'NGC6254',11:'NGC6705',12:'NGC6218',13:'NGC6205',14:'NGC6402',15:'NGC7078',16:'NGC6611',17:'NGC6618',18:'NGC6613',19:'NGC6273',20:'NGC6514',21:'NGC6531',22:'NGC6656',23:'NGC6494',24:'IC4715',25:'IC4725',26:'NGC6694',27:'NGC6853',28:'NGC6626',29:'NGC6913',30:'NGC7099',31:'NGC224',32:'NGC221',33:'NGC598',34:'NGC1039',35:'NGC2168',36:'NGC1960',37:'NGC2099',38:'NGC1912',39:'NGC7092',41:'NGC2287',42:'NGC1976',43:'NGC1982',44:'NGC2632',46:'NGC2437',47:'NGC2422',48:'NGC2548',49:'NGC4472',50:'NGC2323',51:'NGC5194',52:'NGC7654',53:'NGC5024',54:'NGC6715',55:'NGC6809',56:'NGC6779',57:'NGC6720',58:'NGC4579',59:'NGC4621',60:'NGC4649',61:'NGC4303',62:'NGC6266',63:'NGC5055',64:'NGC4826',65:'NGC3623',66:'NGC3627',67:'NGC2682',68:'NGC4590',69:'NGC6637',70:'NGC6681',71:'NGC6838',72:'NGC6981',73:'NGC6994',74:'NGC628',75:'NGC6864',76:'NGC650',77:'NGC1068',78:'NGC2068',79:'NGC1904',80:'NGC6093',81:'NGC3031',82:'NGC3034',83:'NGC5236',84:'NGC4374',85:'NGC4382',86:'NGC4406',87:'NGC4486',88:'NGC4501',89:'NGC4552',90:'NGC4569',91:'NGC4548',92:'NGC6341',93:'NGC2447',94:'NGC4736',95:'NGC3351',96:'NGC3368',97:'NGC3587',98:'NGC4192',99:'NGC4254',100:'NGC4321',101:'NGC5457',102:'NGC5866',103:'NGC581',104:'NGC4594',105:'NGC3379',106:'NGC4258',107:'NGC6171',108:'NGC3556',109:'NGC3992',110:'NGC205'};

// https://en.wikipedia.org/wiki/Caldwell_catalogue (checked 2026-10-19). The
// record each Caldwell number names; C9, C41 and C99 have no NGC/IC number.
const CALDWELL: Record<number, string> = {1:'NGC188',2:'NGC40',3:'NGC4236',4:'NGC7023',5:'IC342',6:'NGC6543',7:'NGC2403',8:'NGC559',9:'SH2-155',10:'NGC663',11:'NGC7635',12:'NGC6946',13:'NGC457',14:'NGC869',15:'NGC6826',16:'NGC7243',17:'NGC147',18:'NGC185',19:'IC5146',20:'NGC7000',21:'NGC4449',22:'NGC7662',23:'NGC891',24:'NGC1275',25:'NGC2419',26:'NGC4244',27:'NGC6888',28:'NGC752',29:'NGC5005',30:'NGC7331',31:'IC405',32:'NGC4631',33:'NGC6992',34:'NGC6960',35:'NGC4889',36:'NGC4559',37:'NGC6885',38:'NGC4565',39:'NGC2392',40:'NGC3626',41:'C41',42:'NGC7006',43:'NGC7814',44:'NGC7479',45:'NGC5248',46:'NGC2261',47:'NGC6934',48:'NGC2775',49:'NGC2237',50:'NGC2244',51:'IC1613',52:'NGC4697',53:'NGC3115',54:'NGC2506',55:'NGC7009',56:'NGC246',57:'NGC6822',58:'NGC2360',59:'NGC3242',60:'NGC4038',61:'NGC4039',62:'NGC247',63:'NGC7293',64:'NGC2362',65:'NGC253',66:'NGC5694',67:'NGC1097',68:'NGC6729',69:'NGC6302',70:'NGC300',71:'NGC2477',72:'NGC55',73:'NGC1851',74:'NGC3132',75:'NGC6124',76:'NGC6231',77:'NGC5128',78:'NGC6541',79:'NGC3201',80:'NGC5139',81:'NGC6352',82:'NGC6193',83:'NGC4945',84:'NGC5286',85:'IC2391',86:'NGC6397',87:'NGC1261',88:'NGC5823',89:'NGC6087',90:'NGC2867',91:'NGC3532',92:'NGC3372',93:'NGC6752',94:'NGC4755',95:'NGC6025',96:'NGC2516',97:'NGC3766',98:'NGC4609',99:'C99',100:'IC2944',101:'NGC6744',102:'IC2602',103:'NGC2070',104:'NGC362',105:'NGC4833',106:'NGC104',107:'NGC6101',108:'NGC4372',109:'NGC3195'};

describe('dso-catalog.json structure', () => {
  it('gives every record a unique id, listed first among its designations', () => {
    const ids = DSO_RECORDS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DSO_RECORDS.filter(r => r.designations[0] !== r.id).map(r => r.id)).toEqual([]);
  });

  it('puts each designation on exactly one record, in normalised spelling', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    const misspelt: string[] = [];
    for (const r of DSO_RECORDS) {
      for (const d of r.designations) {
        if (d !== r.id && normalizeCatalogNumber(d) !== d) misspelt.push(`${r.id}: ${d}`);
        const prev = owner.get(d);
        if (prev && prev !== r.id) clashes.push(`${d}: ${prev} and ${r.id}`);
        owner.set(d, r.id);
      }
    }
    expect(clashes).toEqual([]);
    expect(misspelt).toEqual([]);
  });

  it('resolves every designation back to the record that carries it', () => {
    const wrong: string[] = [];
    for (const r of DSO_RECORDS) {
      for (const d of r.designations) {
        const got = resolveCanonicalId(d);
        if (got !== r.id) wrong.push(`${d} -> ${got}, expected ${r.id}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps names clean: no raw abbreviations, articles, repeats of the display name or catalog numbers', () => {
    const bad: string[] = [];
    const bayer = /^(alf|bet|gam|del|eps|zet|eta|tet|iot|kap|lam|omi|rho|sig|tau|ups|phi|chi|psi|ome)\s+[A-Z][a-z]{2}\b/;
    for (const r of DSO_RECORDS) {
      for (const n of [r.name, ...r.names]) {
        if (bayer.test(n)) bad.push(`${r.id}: Bayer abbreviation "${n}"`);
        if (/^the\s/i.test(n)) bad.push(`${r.id}: leading article "${n}"`);
      }
      for (const n of r.names) {
        if (n.toLowerCase() === r.name.toLowerCase()) bad.push(`${r.id}: repeats display name "${n}"`);
        if (normalizeCatalogNumber(n)) bad.push(`${r.id}: catalog number among names "${n}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('records a source for every hand-corrected name and Caldwell or Sharpless link', () => {
    for (const id of ['IC63', 'IC2602', 'IC2944', 'NGC3576', 'NGC2070']) expect(recordFor(id)!.sources.name).toBeTruthy();
    for (const [id, key] of [['IC2602', 'C102'], ['NGC2070', 'C103'], ['IC1805', 'SH2-190'], ['NGC2237', 'SH2-275']]) {
      expect(recordFor(id)!.sources[key]).toBeTruthy();
    }
  });
});

describe('crosswalks against the published catalogs', () => {
  it('matches every Messier number to its NGC/IC object (Wikipedia)', () => {
    const wrong: string[] = [];
    for (let m = 1; m <= 110; m++) {
      const record = recordFor(`M${m}`);
      if (!record) { wrong.push(`M${m}: no record`); continue; }
      const ngc = MESSIER_NGC[m];
      if (ngc && !record.designations.includes(ngc)) wrong.push(`M${m}: record ${record.id} lacks ${ngc}`);
    }
    expect(wrong).toEqual([]);
  });

  it('matches every Caldwell number to its object (Wikipedia)', () => {
    const wrong: string[] = [];
    for (let c = 1; c <= 109; c++) {
      const got = recordFor(`C${c}`)?.id;
      if (got !== CALDWELL[c]) wrong.push(`C${c}: ${got} (expected ${CALDWELL[c]})`);
    }
    expect(wrong).toEqual([]);
  });

  it('knows all 313 Sharpless objects', () => {
    const missing = Array.from({ length: 313 }, (_, i) => `SH2-${i + 1}`).filter(id => !recordFor(id));
    expect(missing).toEqual([]);
  });

  it('folds Sharpless numbers onto the NGC/IC object they are (verified pairs)', () => {
    const pairs: Array<[string, string]> = [['Sh2-131', 'IC1396'], ['Sh2-190', 'IC1805'], ['Sh2-199', 'IC1848'], ['Sh2-220', 'NGC1499'],
      ['Sh2-229', 'IC405'], ['Sh2-234', 'IC417'], ['Sh2-236', 'IC410'], ['Sh2-252', 'NGC2174'], ['Sh2-273', 'NGC2264'],
      ['Sh2-275', 'NGC2237'], ['Sh2-277', 'NGC2024'], ['Sh2-292', 'IC2177'], ['Sh2-298', 'NGC2359']];
    expect(pairs.filter(([sh, ngc]) => resolveCanonicalId(sh) !== ngc)).toEqual([]);
  });

  it('folds OpenNGC duplicate numbers onto the object they duplicate', () => {
    expect(resolveCanonicalId('IC1577')).toBe('IC48');
    expect(resolveCanonicalId('NGC2239')).toBe('NGC2244');
    expect(resolveCanonicalId('NGC1909')).toBe('IC2118');
  });
});

describe('what the app shows', () => {
  it('never lists the asked-for id or the display name as "also known as"', () => {
    const bad: string[] = [];
    for (const r of DSO_RECORDS.filter(x => x.listed || x.curated)) {
      const aka = getAlsoKnownAs(r.id).map(a => a.toLowerCase());
      if (aka.includes(r.id.toLowerCase().replace(/^sh2-/, 'sh2-'))) bad.push(`${r.id}: lists itself`);
      if (aka.includes(r.name.toLowerCase())) bad.push(`${r.id}: lists its display name`);
      if (aka.some(a => /^(ngc|ic)0\d/.test(a))) bad.push(`${r.id}: zero-padded number`);
    }
    expect(bad).toEqual([]);
  });

  it('resolves a faint NGC number that is not browsed to a real object', () => {
    const entry = getCatalogEntry('NGC5');
    expect(entry?.type).toBe('Galaxy');
    expect(entry?.ra).toBeTruthy();
  });

  it('shows the verified names', () => {
    expect(getCatalogEntry('IC63')?.name).toBe('Ghost of Cassiopeia');
    expect(getCatalogEntry('IC2602')?.name).toBe('Southern Pleiades');
    expect(getCatalogEntry('C103')?.name).toBe('Tarantula Nebula');
    expect(getCatalogEntry('NGC6445')?.name).toBe('Box Nebula');
  });
});
