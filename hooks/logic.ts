// Решения подогрева без обращений к движку: что делать на тике, после пинга и после хода.

export type Sess = {
  enabled: boolean
  // Последний запрос основного разговора, прочитавший или записавший кэш: конец хода или пинг.
  lastRequestAt: number
  // Конец последнего настоящего хода (сообщение, фоновая задача, пробуждение).
  lastTurnAt: number
  // Пауза до следующего хода и её причина.
  waiting?: string
  pings: number
  errors: number
  nextTryAt?: number
  maxIdleHours: number
  // Почему мод выключился сам.
  stopped?: string
}

export const CFG = {
  ttlMs: 60 * 60_000,
  leadMs: 5 * 60_000,
  // Ближе к концу кэш считаем остывшим: пинг уже не успеет.
  coldMarginMs: 15_000,
  minContextTokens: 20_000,
  retryMs: 2 * 60_000,
  defaultIdleHours: 8,
}

export const fresh = (now: number, maxIdleHours = CFG.defaultIdleHours): Sess => ({
  enabled: true, lastRequestAt: now, lastTurnAt: now, pings: 0, errors: 0, maxIdleHours,
})

export type Decision = { kind: 'idle' } | { kind: 'ping' } | { kind: 'pause'; reason: string }

export function decide(s: Sess, now: number, contextTokens: number | undefined): Decision {
  if (!s.enabled || s.waiting !== undefined || s.lastRequestAt === 0) return { kind: 'idle' }
  if (now - s.lastTurnAt > s.maxIdleHours * 3_600_000) return { kind: 'pause', reason: `простой дольше ${s.maxIdleHours} ч` }
  const expires = s.lastRequestAt + CFG.ttlMs
  if (now >= expires - CFG.coldMarginMs) return { kind: 'pause', reason: 'кэш уже остыл: компьютер спал или сессия была закрыта' }
  if (now < expires - CFG.leadMs) return { kind: 'idle' }
  if (s.nextTryAt !== undefined && now < s.nextTryAt) return { kind: 'idle' }
  if (contextTokens !== undefined && contextTokens < CFG.minContextTokens) return { kind: 'pause', reason: `разговор меньше ${CFG.minContextTokens} токенов, греть невыгодно` }
  return { kind: 'ping' }
}

export type PingOutcome =
  | { isAnswered: true; read: number; write: number }
  | { isAnswered: false; reason: string }

export function afterPing(s: Sess, r: PingOutcome, now: number): Sess {
  if (r.isAnswered) {
    // Промах: пинг записал разговор заново вместо чтения. Дальше пинги только жгут лимит.
    if (r.read === 0 || r.read < r.write) return { ...s, enabled: false, stopped: `пинг промахнулся мимо кэша (прочитано ${r.read}, записано ${r.write})` }
    return { ...s, lastRequestAt: now, pings: s.pings + 1, errors: 0, nextTryAt: undefined }
  }
  if (r.reason === 'nothing-to-fork') return { ...s, waiting: 'греть нечего: в разговоре ещё нет запросов' }
  if (r.reason === 'aborted') return { ...s, nextTryAt: now + 60_000 }
  const errors = s.errors + 1
  if (errors >= 2) return { ...s, errors, waiting: `две ошибки пинга подряд (${r.reason})` }
  return { ...s, errors, nextTryAt: now + CFG.retryMs }
}

export type Usage = { read: number; write: number }

// Конец настоящего хода: кэш записан заново, отсчёт часа и простоя начинается снова.
// Самопроверка: если перерыв держали пингами, а ход записал больше, чем прочитал, подогрев не сработал.
export function afterTurn(s: Sess, now: number, usage?: Usage): { s: Sess; selfCheckFailed: boolean } {
  const selfCheckFailed = s.enabled && s.pings > 0 && usage !== undefined && usage.read < usage.write
  const next: Sess = { ...s, lastRequestAt: now, lastTurnAt: now, waiting: undefined, pings: 0, errors: 0, nextTryAt: undefined }
  if (selfCheckFailed) return { s: { ...next, enabled: false, stopped: `самопроверка: после подогретого перерыва ход записал ${usage!.write}, прочитал ${usage!.read}` }, selfCheckFailed }
  return { s: next, selfCheckFailed }
}

export function nextPingAt(s: Sess): number | undefined {
  if (!s.enabled || s.waiting !== undefined) return undefined
  return Math.max(s.lastRequestAt + CFG.ttlMs - CFG.leadMs, s.nextTryAt ?? 0)
}

export const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function describe(s: Sess | undefined): string {
  if (!s) return 'Подогрев кэша в этой сессии выключен.'
  if (!s.enabled) return `Подогрев выключен${s.stopped ? `: ${s.stopped}` : ''}.`
  if (s.waiting) return `Подогрев включён, на паузе до следующего хода: ${s.waiting}.`
  const at = nextPingAt(s)
  return `Подогрев включён: следующий пинг около ${at ? hhmm(at) : '—'}, пингов с последнего хода ${s.pings}, остановка после ${s.maxIdleHours} ч простоя.`
}
