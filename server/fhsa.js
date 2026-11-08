// FHSA excess-amount tax (CRA form RC728): 1% per month on the highest excess
// in each month. Pure functions; tested in tests/fhsa.test.js.
//
// Room follows the CRA Notice of Assessment: each year's participation room is
// $8,000 plus last year's (room - contributions), where a positive leftover is
// capped at $8,000 and a negative one (last year's excess) eats into the new
// room. The excess at any moment is this year's contributions so far, minus
// designated withdrawals so far, minus this year's room (if positive).
// Years with a CRA-stated room use that figure instead of the derived one.

const ANNUAL = 8000;
const r2 = n => Math.round(n * 100) / 100;

export function nextRoom(room, contributed, annual = ANNUAL) {
  const left = room - contributed;
  return annual + (left > 0 ? Math.min(left, annual) : left);
}

/**
 * events: [{ date, amount, kind: 'contribution' | 'designated', dated? }]
 * roomByYear: { [year]: room } from NOAs; the first year must be present.
 * through: last month to report, 'YYYY-MM' (default: last event's month).
 * Returns { years: [{ year, room, roomSource, contributed, tax, approximate }], months: [...], total }.
 */
export function excessByMonth({ events, roomByYear, through, annual = ANNUAL }) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const firstYear = Math.min(...Object.keys(roomByYear).map(Number));
  const last = through || sorted.at(-1).date.slice(0, 7);
  const lastYear = Number(last.slice(0, 4));
  const years = [];
  const months = [];
  let room = roomByYear[firstYear];
  for (let y = firstYear; y <= lastYear; y++) {
    const stated = roomByYear[y];
    if (y > firstYear) room = stated ?? nextRoom(room, years.at(-1).contributed, annual);
    else room = stated;
    const inYear = sorted.filter(e => e.date.startsWith(`${y}-`));
    let net = 0; // contributions minus designated withdrawals so far this year
    let tax = 0;
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > last) break;
      let highest = Math.max(0, net - room);
      for (const e of inYear.filter(e => e.date.startsWith(key))) {
        net += e.kind === 'designated' ? -e.amount : e.amount;
        highest = Math.max(highest, net - room);
      }
      const t = r2(0.01 * highest);
      tax = r2(tax + t);
      months.push({ month: key, highest: r2(highest), tax: t });
    }
    const contributed = inYear.filter(e => e.kind === 'contribution').reduce((s, e) => s + e.amount, 0);
    years.push({ year: y, room: r2(room), roomSource: stated == null ? 'derived' : 'NOA',
      contributed: r2(contributed), yearEndExcess: r2(Math.max(0, net - room)), tax,
      approximate: inYear.some(e => e.dated === false) && tax > 0 });
  }
  return { years, months, total: r2(years.reduce((s, y) => s + y.tax, 0)) };
}
