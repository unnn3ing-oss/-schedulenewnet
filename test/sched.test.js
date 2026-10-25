const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../web/sched.js');

const NOW = new Date(2026, 9, 25, 14, 3, 27);   // 2026-10-25 14:03:27（本機時區）

test('formatTyping：剛好 4 碼補冒號，其他原樣', () => {
  assert.equal(S.formatTyping('2130'), '21:30');
  assert.equal(S.formatTyping('0905'), '09:05');
  assert.equal(S.formatTyping('213'), '213');
  assert.equal(S.formatTyping('21:30'), '21:30');
  assert.equal(S.formatTyping(''), '');
  assert.equal(S.formatTyping('ab12'), 'ab12');
});

test('parseTime', () => {
  assert.deepEqual(S.parseTime('2130'), { h: 21, m: 30 });
  assert.deepEqual(S.parseTime('21:30'), { h: 21, m: 30 });
  assert.deepEqual(S.parseTime('930'), { h: 9, m: 30 });
  assert.deepEqual(S.parseTime('0:00'), { h: 0, m: 0 });
  assert.equal(S.parseTime('2430'), null);
  assert.equal(S.parseTime('2160'), null);
  assert.equal(S.parseTime('21'), null);
  assert.equal(S.parseTime('21:3'), null);
  assert.equal(S.parseTime(null), null);
});

test('combine：日期字串或 Date＋時間', () => {
  const d = S.combine('2026-10-26', '2130');
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 9); assert.equal(d.getDate(), 26);
  assert.equal(d.getHours(), 21); assert.equal(d.getMinutes(), 30); assert.equal(d.getSeconds(), 0);
  assert.equal(S.combine(NOW, '21:30').getDate(), 25);
  assert.equal(S.combine('2026-10-26', '25:00'), null);
  assert.equal(S.combine('bad', '21:30'), null);
});

test('defaultAt：現在＋30 分並取到 10 分整', () => {
  const d = S.defaultAt(NOW);   // 14:33:27 → 14:40
  assert.equal(S.fmtTime(d), '14:40');
  assert.ok(d - NOW >= 30 * 60000);
  assert.equal(S.fmtTime(S.defaultAt(new Date(2026, 9, 25, 14, 10, 0))), '14:40');   // 剛好整 10 分不再進位
  const late = S.defaultAt(new Date(2026, 9, 25, 23, 45, 0));
  assert.equal(late.getDate(), 26); assert.equal(S.fmtTime(late), '00:20');
});

test('validate：最早 現在＋20 分（不取整）、最晚 3 天', () => {
  const plus = m => new Date(NOW.getTime() + m * 60000);
  assert.equal(S.validate(plus(20), NOW), null);
  assert.equal(S.validate(plus(19.9), NOW).code, 'too_soon');
  assert.match(S.validate(plus(5), NOW).msg, /20 分鐘/);
  assert.equal(S.validate(plus(3 * 1440), NOW), null);
  assert.equal(S.validate(plus(3 * 1440 + 1), NOW).code, 'too_late');
  assert.equal(S.validate(null, NOW).code, 'bad_time');
  assert.equal(S.validate(S.combine('2026-10-25', '2130'), NOW), null);
  assert.equal(S.validate(S.combine('2026-10-25', '1410'), NOW).code, 'too_soon');
});

test('step：↑↓ ±10 分，跨日', () => {
  const d = S.combine('2026-10-25', '2355');
  assert.equal(S.fmtTime(S.step(d, 1)), '00:05');
  assert.equal(S.step(d, 1).getDate(), 26);
  assert.equal(S.fmtTime(S.step(d, -1)), '23:45');
});

test('toScheduleString 與 fmtWhen', () => {
  const d = S.combine('2026-10-26', '0905');
  assert.equal(S.toScheduleString(d), '2026-10-26T09:05');
  assert.equal(S.fmtWhen(S.combine('2026-10-25', '2130'), NOW), '21:30');
  assert.equal(S.fmtWhen(d, NOW), '10/26 09:05');
});
