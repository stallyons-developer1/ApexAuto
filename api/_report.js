// Reads the text of a people-search / background report (an uploaded PDF, or the report page
// text the TruthFinder worker captures) and compares it with the verified identity. Helper, not an endpoint.
//   parseReport(text)            → { name, dob, age, states[], records[], noRecords, criminalSection }
//   checkReport(text, identity)  → { match: {name, dob, state}, matched, flags[], records[], readable }
// Two layouts are understood: labelled records ("Offense: … / Offense Level: …"), and free text where
// the criminal section is scanned for flag keywords. Flags never decline anyone on their own — a
// flagged or uncertain report goes to the team (TruthFinder data must not be the sole factor).
// Flag wording follows handoff/automation-1 (attorney to approve).

const FLAG_RULES = [
  ['Grand theft auto (vehicle theft)', /grand theft auto|motor vehicle theft|vehicle theft|auto theft|carjack/i],
  ['Theft / larceny', /\btheft\b|larceny|burglary|robbery|shoplift|stolen property/i],
  ['DUI / DWI', /\bDUI\b|\bDWI\b|\bOWI\b|driving under the influence|driving while intoxicated|impaired driving/i],
  ['Reckless driving', /reckless driving|careless driving|street racing/i],
  ['Drug possession', /drug|narcotic|controlled substance|cannabis|marijuana|cocaine|paraphernalia/i],
  ['Felony', /\bfelony\b|\bfel\.?\b/i],
  ['Violent crime (murder, assault, weapons…)', /murder|homicide|manslaughter|assault|battery|kidnap|carjack|armed|weapon|firearm|shooting|domestic violence|sex(ual)? (offense|assault|abuse)|rape/i],
  ['Suspended / revoked / expired license', /suspended|revoked|expired (driver'?s )?licen[cs]e|driving while (license )?suspended|DWLS/i],
  ['Outstanding warrant or vehicle-seizure risk', /warrant|impound|seiz|forfeit/i]
];

const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
  'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

function toIsoDate(s) {
  if (!s) return '';
  let m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); // US MM/DD/YYYY
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = String(s).match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); // "Feb 7, 1990" / "February 7 1990"
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  return '';
}
function ageOn(dobIso, now = new Date()) {
  const b = new Date(dobIso + 'T00:00:00');
  if (isNaN(b)) return null;
  return now.getFullYear() - b.getFullYear() - ((now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) ? 1 : 0);
}

// Parts of a report about OTHER people — never the subject's record (TruthFinder lists "individuals charged
// with sex crimes living in close proximity" with their offenses). Cut out before reading records.
const OTHER_PEOPLE = /(sex offenders?( nearby| in (the|your) area)?|individuals charged with sex crimes|neighborhood (watch|safety)|nearby offenders?)[\s\S]*?(?=\n\s*(social media|finances|assets|jobs (&|and) businesses|additional records|user comments|phone report|email report)\b|$)/gi;

// The subject's criminal / court part of a free-text report.
//  • TruthFinder: the "Criminal & Traffic Records" section, up to the next section heading
//  • otherwise: ~4000 characters after every criminal-ish heading (menus mention "Criminal Records" first)
function criminalSectionOf(t) {
  const tf = [...t.matchAll(/(^|\n)\s*criminal\s*(&|and)\s*traffic\s*records?\s*(\(\d+\))?\s*\n([\s\S]*?)(?=\n\s*(social media|finances|assets|jobs (&|and) businesses|additional records|user comments)\s*\n|$)/gi)]
    .map((m) => m[4]).filter((s) => s.trim().length > 20);
  if (tf.length) return tf.join('\n');
  const re = /(criminal|arrest|court|traffic|offen[cs]e)s?\s*(&|and)?\s*(traffic|court)?\s*(records?|history|offen[cs]es?)/gi;
  return [...t.matchAll(re)].map((m) => t.slice(m.index, m.index + 4000)).join('\n');
}
// Explicit "nothing found" wording — a report only comes back clear when it says so (or lists records, none flagged)
// (TruthFinder: "We completed the search but no criminal or traffic records were found" / "…but didn't find any matches")
const NO_RECORDS = /no (criminal|court|traffic|arrest)?\s*((&|and|or)\s*(traffic|criminal)\s*)?records?\s*(were\s*)?found|\b0\s+(criminal|court|arrest|traffic)\s*records\b|no records found|completed the search but no|(did not|didn['’]?t|could not|couldn['’]?t) find any (criminal|arrest|court|matches)|no (criminal|arrest) (history|records) (was |were )?(found|located|available)/i;

function parseReport(text) {
  const t = String(text || '').replace(OTHER_PEOPLE, '\n'); // drop sections about other people (nearby offenders)
  const line = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
  // TruthFinder report header: "Caleb Carl Flynn 40 years old" — the subject's own name and age
  const header = t.match(/(?:^|\n)[ \t]*([A-Z][A-Za-z'.-]+(?:[ \t]+[A-Z][A-Za-z'.-]*){1,4})[ \t]+(\d{2,3})[ \t]+years?[ \t]+old\b/);
  const name = line(/(?:Full Name|Subject|Name)\s*:\s*([^\n]+)/i) || (header ? header[1].trim() : '');
  const dob = toIsoDate(line(/(?:Date of Birth|DOB|Born)\s*:?\s*([^\n]{6,30})/i));
  // the subject's age: TruthFinder's header "Claire B Stone 23 years old" comes first; a bare "Age 49" further
  // down can belong to a relative / associate card, so it is only the fallback
  const ageTxt = (header && header[2]) || line(/\b(\d{2,3})\s+years?\s+old\b/i) || line(/\bAge\s*:?\s*(\d{2,3})\b/i);
  // "Born Dec 2002" (month + year only)
  const bornM = t.match(/\bBorn\s*:?\s*([A-Za-z]{3})[a-z]*\.?\s+((?:19|20)\d{2})\b/i);
  const bornYM = bornM && MONTHS[bornM[1].toLowerCase()] ? { year: Number(bornM[2]), month: MONTHS[bornM[1].toLowerCase()] } : null;
  const states = [...new Set([...t.matchAll(/,\s*([A-Z]{2})(?:\s+\d{5})?\b/g)].map((m) => m[1]).filter((s) => STATES.has(s)))];

  // Labelled records: each starts with "Offense:" (or "Charge:")
  const records = [];
  const blocks = t.split(/\n(?=\s*(?:\d+\.\s*)?(?:Offense|Charge)\s*:)/i).slice(1);
  for (const b of blocks) {
    const get = (re) => { const m = b.match(re); return m ? m[1].trim() : ''; };
    records.push({
      offense: get(/(?:Offense|Charge)\s*:\s*([^\n]+)/i),
      level: get(/(?:Offense Level|Level|Class)\s*:\s*([^\n]+)/i),
      date: get(/(?:Offense Date|Date)\s*:\s*([^\n]+)/i),
      county: get(/(?:County|Court|Jurisdiction)\s*:\s*([^\n]+)/i),
      disposition: get(/(?:Disposition|Status)\s*:\s*([^\n]+)/i)
    });
  }
  const criminalSection = criminalSectionOf(t);
  // Free text: lines in the criminal section that mention a flagged offence
  if (!records.length && criminalSection) {
    const seen = new Set(); // the same line can sit in several overlapping sections / captured tabs
    for (const l of criminalSection.split('\n')) {
      const s = l.trim();
      if (s.length > 3 && s.length < 300 && !seen.has(s) && FLAG_RULES.some(([, re]) => re.test(s))) {
        seen.add(s);
        records.push({ offense: s, level: '', date: '', county: '', disposition: '' });
      }
    }
  }
  const noRecords = !records.length && NO_RECORDS.test(t);
  return { name, dob, bornYM, age: ageTxt ? Number(ageTxt) : (dob ? ageOn(dob) : null), states, records, noRecords, criminalSection: !!criminalSection };
}

// Middle name check on a name like "KaShawn N Roper" / "KaShawn Nicola Roper": when both the ID and the
// name show a middle name, its first letter must agree. A name without a middle part never fails on it.
function middleOk(nameWords, first, last, middle) {
  const m = norm(middle).split(' ')[0];
  if (!m) return true;
  const fi = nameWords.indexOf(first), li = nameWords.lastIndexOf(last);
  if (fi < 0 || li < 0 || li - fi < 2) return true; // no middle part shown
  return nameWords.slice(fi + 1, li).some((w) => w[0] === m[0]);
}

function checkReport(text, identity) {
  const r = parseReport(text);
  const id = identity || {};
  const first = norm(id.first_name).split(' ')[0];
  const last = norm(id.last_name).split(' ').pop();
  // Name from a "Name:" line, or (free-text pages) near the top of the report
  const nameWords = norm(r.name || String(text || '').slice(0, 1500)).split(' ');
  const idDob = toIsoDate(id.date_of_birth);
  const idState = String(id.issuing_state || '').toUpperCase();

  // US phone numbers anywhere in the report (Contact section), as 10 digits
  const phones = [...new Set([...String(text || '').matchAll(/(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)].map((m) => m[1] + m[2] + m[3]))];
  const idPhone = String(id.phone || '').replace(/\D/g, '').slice(-10);

  const match = {
    name: !!(first && last && nameWords.includes(first) && nameWords.includes(last) && middleOk(nameWords, first, last, id.middle_name)),
    // exact DOB when the report has one; otherwise age within a year
    // exact DOB → else born month + year ("Born Dec 2002") → else age within a year
    dob: !idDob ? null // no date of birth given → not checked
      : r.dob ? r.dob === idDob
      : r.bornYM ? r.bornYM.year === Number(idDob.slice(0, 4)) && r.bornYM.month === Number(idDob.slice(5, 7))
      : (r.age != null && Math.abs(r.age - ageOn(idDob)) <= 1),
    state: !!(idState && r.states.includes(idState)),
    // only checked when step 1 gave a phone: the report must list that number
    phone: idPhone.length === 10 ? phones.includes(idPhone) : null
  };
  const flags = [];
  for (const rec of r.records) {
    const hay = [rec.offense, rec.level, rec.disposition].join(' ');
    for (const [label, re] of FLAG_RULES) if (re.test(hay) && !flags.includes(label)) flags.push(label);
  }
  return {
    report: { name: r.name || (match.name ? `${id.first_name} ${id.last_name}` : ''), dob: r.dob, age: r.age, states: r.states, phones: phones.length,
      noAge: r.age == null && !r.dob && !r.bornYM }, // TruthFinder has no age / DOB for this person
    match, matched: match.name && match.dob !== false && match.state && match.phone !== false,
    records: r.records, flags, noRecords: r.noRecords,
    // the report positively shows a clean record: says "no records", or lists records none of which is flagged
    confirmedClean: !flags.length && (r.noRecords || r.records.length > 0),
    // looks like a report we can read: a person, plus either records, a "none found", or a criminal section
    readable: !!((r.name || match.name) && (r.records.length || r.noRecords || r.criminalSection)),
    // the report says whose it is (a "Name:" line or the "<name> NN years old" header) — without it a
    // mismatch can't be told apart from a page that didn't load, so it must never count as "someone else"
    identified: !!r.name || match.name
  };
}

module.exports = { parseReport, checkReport, middleOk, FLAG_RULES, toIsoDate, ageOn, STATES };
