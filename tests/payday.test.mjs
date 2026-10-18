// Payday every second Friday: the picker's choices, validation, "Next payday" and periods across year ends.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { S, U, fresh, setToday } from './env.mjs';

const throwsField = (fn, field) => assert.throws(fn, (e) => e instanceof S.ValidationError && e.field === field && !/undefined|NaN/.test(e.message));
const dow = (iso) => U.parseISO(iso).getDay();

describe('payday: choosing the next payday', () => {
  test('isFriday', () => {
    assert.equal(S.isFriday('2026-10-23'), true);
    assert.equal(S.isFriday('2026-10-22'), false);
    assert.equal(S.isFriday('2026-02-30'), false);
    assert.equal(S.isFriday('nope'), false);
  });
  test('the picker offers the next two Fridays (today counts on a Friday)', () => {
    assert.deepEqual(S.paydayChoices('2026-10-18'), ['2026-10-23', '2026-10-30']); // Sunday
    assert.deepEqual(S.paydayChoices('2026-10-23'), ['2026-10-23', '2026-10-30']); // Friday
    assert.deepEqual(S.paydayChoices('2026-10-24'), ['2026-10-30', '2026-11-06']); // Saturday
    assert.deepEqual(S.paydayChoices('2026-12-26'), ['2027-01-01', '2027-01-08']); // across New Year
    assert.deepEqual(S.paydayChoices('2028-02-26'), ['2028-03-03', '2028-03-10']); // leap year (Feb 29 is a Tuesday)
  });
  test('setPayday accepts only one of those Fridays and stores it as the anchor', async () => {
    fresh({ today: '2026-10-18' });
    throwsField(() => S.setPayday('2026-10-22'), 'payAnchor'); // Thursday
    throwsField(() => S.setPayday('2026-10-16'), 'payAnchor'); // last Friday
    throwsField(() => S.setPayday('2026-11-06'), 'payAnchor'); // three weeks away
    throwsField(() => S.setPayday('2026-13-01'), 'payAnchor');
    throwsField(() => S.setPayday('2026-10-23', -5), 'payAmount');
    assert.equal(S.db.settings.payAnchor, '2026-10-09', 'nothing changed');
    S.setPayday('2026-10-30', '25,000');
    assert.equal(S.db.settings.payAnchor, '2026-10-30');
    assert.equal(S.db.settings.payAmount, 25000);
    await S.flush();
  });
  test('"Next payday: Fri, Oct 23 · 5 days"', () => {
    fresh({ today: '2026-10-18' });
    S.setPayday('2026-10-23');
    assert.deepEqual(S.paydayInfo(), { next: '2026-10-23', days: 5, isToday: false });
    setToday('2026-10-23');
    assert.deepEqual(S.paydayInfo(), { next: '2026-10-23', days: 0, isToday: true });
    setToday('2026-10-24');
    assert.deepEqual(S.paydayInfo(), { next: '2026-11-06', days: 13, isToday: false });
    assert.equal(U.fmtDate('2026-10-23', { weekday: 'short', month: 'short', day: 'numeric' }), 'Fri, Oct 23');
  });
});

describe('payday: 14-day periods across year boundaries', () => {
  test('a period that spans New Year', () => {
    fresh({ today: '2026-12-31', anchor: '2026-12-25' });
    assert.deepEqual(S.period('2026-12-31'), { start: '2026-12-25', end: '2027-01-07', next: '2027-01-08' });
    assert.deepEqual(S.period('2027-01-07'), { start: '2026-12-25', end: '2027-01-07', next: '2027-01-08' });
    assert.deepEqual(S.period('2027-01-08'), { start: '2027-01-08', end: '2027-01-21', next: '2027-01-22' });
    assert.deepEqual(S.period('2026-12-24'), { start: '2026-12-11', end: '2026-12-24', next: '2026-12-25' });
    assert.deepEqual(S.paydayInfo('2026-12-31'), { next: '2027-01-08', days: 8, isToday: false });
  });
  test('a leap-year February is counted day by day', () => {
    fresh({ today: '2028-03-01', anchor: '2028-02-25' });
    assert.deepEqual(S.period('2028-03-01'), { start: '2028-02-25', end: '2028-03-09', next: '2028-03-10' });
    assert.deepEqual(S.period('2028-02-29'), { start: '2028-02-25', end: '2028-03-09', next: '2028-03-10' });
  });
  test('with a Friday anchor every period starts on a Friday for years, both directions', () => {
    fresh({ today: '2026-10-18', anchor: '2026-10-23' });
    for (let d = '2025-01-01'; d < '2029-01-01'; d = U.addDays(d, 1)) {
      const p = S.period(d);
      assert.equal(dow(p.start), 5, `${d} -> ${p.start}`);
      assert.equal(dow(p.next), 5);
      assert.ok(p.start <= d && d <= p.end, d);
      assert.equal(U.daysBetween(p.start, p.next), 14);
    }
  });
  test('paydaysUntil counts across New Year', () => {
    fresh({ today: '2026-12-20', anchor: '2026-12-25' });
    // paydays after today: Dec 25, Jan 8, Jan 22, Feb 5
    assert.equal(S.paydaysUntil('2027-02-05'), 4);
    assert.equal(S.paydaysUntil('2027-02-04'), 3);
  });
  test('a v2 anchor that is not a Friday keeps working until a Friday is picked', () => {
    fresh({ today: '2026-10-18', anchor: '2026-10-15' }); // a Thursday from v2
    assert.deepEqual(S.paydayInfo(), { next: '2026-10-29', days: 11, isToday: false });
    S.setPayday('2026-10-23');
    assert.equal(dow(S.period().next), 5);
  });
});
