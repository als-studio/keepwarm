import { test, expect } from 'claude-code/testing'
import { CFG, afterPing, afterTurn, decide, fresh, nextPingAt } from '../hooks/logic.ts'

const H = 3_600_000
const MIN = 60_000
const T0 = 1_000_000_000_000

test('до окна пинга ничего не делает, в окне — пингует', async () => {
  const s = fresh(T0)
  expect(decide(s, T0 + 30 * MIN, 100_000).kind).toBe('idle')
  expect(decide(s, T0 + 54 * MIN, 100_000).kind).toBe('idle')
  expect(decide(s, T0 + 56 * MIN, 100_000).kind).toBe('ping')
  expect(nextPingAt(s)).toBe(T0 + CFG.ttlMs - CFG.leadMs)
})

test('выключенный или на паузе — не пингует', async () => {
  expect(decide({ ...fresh(T0), enabled: false }, T0 + 56 * MIN, 100_000).kind).toBe('idle')
  expect(decide({ ...fresh(T0), waiting: 'сжатие' }, T0 + 56 * MIN, 100_000).kind).toBe('idle')
})

test('остывший кэш и долгий простой — пауза до хода', async () => {
  expect(decide(fresh(T0), T0 + 61 * MIN, 100_000).kind).toBe('pause')
  // Пинги держат кэш, но с последнего хода прошло больше 8 часов.
  const s = { ...fresh(T0), lastRequestAt: T0 + 8 * H }
  expect(decide(s, T0 + 8 * H + 56 * MIN, 100_000).kind).toBe('pause')
  expect(decide({ ...s, maxIdleHours: 12 }, T0 + 8 * H + 56 * MIN, 100_000).kind).toBe('ping')
})

test('маленький разговор не греем', async () => {
  expect(decide(fresh(T0), T0 + 56 * MIN, 5_000).kind).toBe('pause')
})

test('удачный пинг сдвигает отсчёт часа', async () => {
  const s = afterPing(fresh(T0), { isAnswered: true, read: 150_000, write: 20 }, T0 + 56 * MIN)
  expect(s.enabled).toBe(true)
  expect(s.pings).toBe(1)
  expect(s.lastRequestAt).toBe(T0 + 56 * MIN)
  expect(decide(s, T0 + 60 * MIN, 150_000).kind).toBe('idle')
})

test('промах мимо кэша выключает подогрев', async () => {
  const s = afterPing(fresh(T0), { isAnswered: true, read: 0, write: 150_000 }, T0 + 56 * MIN)
  expect(s.enabled).toBe(false)
  expect(s.stopped).toContain('промахнулся')
})

test('ошибка API: повтор через 2 минуты, вторая подряд — пауза', async () => {
  const once = afterPing(fresh(T0), { isAnswered: false, reason: 'api-error' }, T0 + 55 * MIN)
  expect(once.waiting).toBeUndefined()
  expect(decide(once, T0 + 56 * MIN, 100_000).kind).toBe('idle')
  expect(decide(once, T0 + 57 * MIN + 1, 100_000).kind).toBe('ping')
  const twice = afterPing(once, { isAnswered: false, reason: 'api-error' }, T0 + 57 * MIN)
  expect(twice.waiting).toBeDefined()
})

test('ход снимает паузу и обнуляет счётчики', async () => {
  const { s } = afterTurn({ ...fresh(T0), waiting: 'сжатие', pings: 3 }, T0 + 2 * H, { read: 100_000, write: 2_000 })
  expect(s.waiting).toBeUndefined()
  expect(s.pings).toBe(0)
  expect(s.lastTurnAt).toBe(T0 + 2 * H)
})

test('самопроверка: ход после пингов записал больше, чем прочитал', async () => {
  const r = afterTurn({ ...fresh(T0), pings: 2 }, T0 + 3 * H, { read: 1_000, write: 150_000 })
  expect(r.selfCheckFailed).toBe(true)
  expect(r.s.enabled).toBe(false)
  // Без пингов в перерыве самопроверка не срабатывает.
  expect(afterTurn(fresh(T0), T0 + 3 * H, { read: 1_000, write: 150_000 }).selfCheckFailed).toBe(false)
})
