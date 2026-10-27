import type { Register } from 'claude-code'
import { CFG, afterPing, afterTurn, decide, describe, fresh, hhmm, nextPingAt, type PingOutcome, type Sess } from './logic.ts'

const TICK_MS = 30_000
const KEEP_DAYS = 14
const PING_PROMPT = 'Служебный пинг подогрева кэша, не задача и не вопрос. Ответь одной точкой.'

// Живёт до перезагрузки мода; всё, что должно пережить её, лежит в $.store.
const M = {
  sid: '',
  logPath: '',
  turnRunning: false,
  pinging: false,
  shownStatus: undefined as string | undefined,
}

async function load($: any): Promise<Sess | undefined> {
  return (await $.store.get(`s:${M.sid}`)) as Sess | undefined
}

async function save($: any, s: Sess) {
  await $.store.set(`s:${M.sid}`, s)
  await showStatus($, s)
}

async function log($: any, entry: Record<string, unknown>) {
  if (!M.logPath) return
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...entry })
  const old = await $.fs.read(M.logPath).catch(() => '')
  const lines = (old ? old.trimEnd().split('\n') : []).slice(-999)
  await $.fs.write(M.logPath, [...lines, line].join('\n') + '\n').catch(() => {})
}

async function showStatus($: any, s: Sess | undefined) {
  let text: string | undefined
  if (s?.enabled) {
    const at = nextPingAt(s)
    text = s.waiting ? 'подогрев: пауза' : `подогрев: ${at ? hhmm(at) : '—'}`
  }
  if (text === M.shownStatus) return
  M.shownStatus = text
  $.ui.status(text)
}

async function ping($: any, s: Sess, manual: boolean): Promise<Sess> {
  M.pinging = true
  let r: any
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } finally {
    M.pinging = false
  }
  const outcome: PingOutcome = r.isAnswered
    ? { isAnswered: true, read: r.usage?.cache_read_input_tokens ?? 0, write: r.usage?.cache_creation_input_tokens ?? 0 }
    : { isAnswered: false, reason: String(r.reason) }
  const after = afterPing(s, outcome, await $.clock.now())
  await log($, { event: manual ? 'ping-now' : 'ping', ...outcome, status: r.status, usage: r.usage })
  if (after.enabled === false && s.enabled) $.ui.toast(`keepwarm: подогрев выключен — ${after.stopped}`)
  else if (after.waiting && !s.waiting) $.ui.toast(`keepwarm: пауза — ${after.waiting}`)
  return after
}

async function tick($: any) {
  if (!M.sid || M.turnRunning || M.pinging) return
  const s = await load($)
  if (!s?.enabled || s.waiting) return
  const now = await $.clock.now()
  const tokens = (await $.session.usage().catch(() => undefined))?.context?.tokens as number | undefined
  const d = decide(s, now, tokens)
  if (d.kind === 'idle') return
  if (d.kind === 'pause') {
    await log($, { event: 'pause', reason: d.reason, contextTokens: tokens })
    await save($, { ...s, waiting: d.reason })
    return
  }
  await save($, await ping($, s, false))
}

async function act($: any, action: string, hours?: number): Promise<string> {
  const now = await $.clock.now()
  const s = await load($)
  if (action === 'on') {
    const idle = hours && hours > 0 ? Math.min(hours, 24) : CFG.defaultIdleHours
    // lastRequestAt = сейчас: включение идёт внутри хода, который и так обновит кэш.
    await save($, fresh(now, idle))
    await log($, { event: 'on', maxIdleHours: idle })
    return `Подогрев кэша включён в этой сессии. Пинг — за ${CFG.leadMs / 60_000} мин до истечения часа с последнего запроса; остановка после ${idle} ч простоя. Выключить: /keepwarm off.`
  }
  if (action === 'off') {
    if (s) await save($, { ...s, enabled: false, stopped: 'выключен вручную' })
    await log($, { event: 'off' })
    return 'Подогрев кэша в этой сессии выключен.'
  }
  if (action === 'now') {
    if (!s?.enabled) return 'Подогрев выключен: сначала /keepwarm on.'
    if (M.pinging) return 'Пинг уже идёт — повторите позже.'
    const after = await ping($, s, true)
    await save($, after)
    return `Пинг отправлен. ${describe(after)}`
  }
  return describe(s)
}

// После смены модели и сжатия кэша для нового разговора ещё нет: ждём следующего хода.
async function pauseUntilTurn($: any, reason: string) {
  const s = await load($)
  if (!s?.enabled) return
  await log($, { event: 'pause', reason })
  await save($, { ...s, waiting: reason })
}

async function prune($: any) {
  const now = await $.clock.now()
  for (const k of await $.store.keys()) {
    if (!k.startsWith('s:')) continue
    const v = (await $.store.get(k)) as Sess | undefined
    if (!v || now - (v.lastTurnAt ?? 0) > KEEP_DAYS * 86_400_000) await $.store.delete(k)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    M.sid = await $.session.id()
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    if (home) M.logPath = `${home.replace(/\\/g, '/')}/.claude/keepwarm/${M.sid}.jsonl`

    await $.command.register({ name: 'keepwarm', description: 'Подогрев кэша в этой сессии: on [часы] | off | status | now', argumentHint: '[on [часы] | off | status | now]' })
    await $.tool.register({
      name: 'keepwarm',
      description: 'Подогрев кэша промпта в ТЕКУЩЕЙ сессии (пинг перед истечением часового кэша, пока сессия простаивает). Вызывай, когда пользователь просит включить, выключить подогрев кэша или узнать его состояние («включи подогрев», «буду долго работать с перерывами»). Сам без просьбы не включай.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['on', 'off', 'status', 'now'], description: 'on — включить, off — выключить, status — состояние, now — пинг сейчас (проверка, что кэш читается)' },
          hours: { type: 'number', description: 'Для on: через сколько часов простоя остановиться (по умолчанию 8, максимум 24)' },
        },
        required: ['action'],
      },
    })

    await prune($)
    await showStatus($, await load($))
    $.clock.every(TICK_MS, () => { tick($).catch(err => log($, { event: 'tick-error', error: String(err?.message ?? err) })) })
    return started
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const [action = 'status', h] = e.args.trim().split(/\s+/)
    return { text: await act($, action || 'status', h ? Number(h) : undefined) }
  })

  on('tool.call', { tool: 'mcp__keepwarm__keepwarm' }, async ($, e: any) => ({ result: await act($, e.action, e.hours) }))
    .catch(() => ({ deny: 'keepwarm: команда не выполнена' }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !M.pinging) M.turnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || M.pinging) return r
    M.turnRunning = false
    const s = await load($)
    if (!s) return r
    const usage = e.usage ? { read: e.usage.cache_read_input_tokens, write: e.usage.cache_creation_input_tokens } : undefined
    const { s: after, selfCheckFailed } = afterTurn(s, await $.clock.now(), usage)
    if (selfCheckFailed) {
      await log($, { event: 'self-check-failed', ...usage })
      $.ui.toast(`keepwarm: подогрев выключен — ${after.stopped}`)
    } else if (s.pings > 0) await log($, { event: 'turn-after-pings', pings: s.pings, ...usage })
    await save($, after)
    return r
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    await pauseUntilTurn($, 'сменилась модель, кэша для неё ещё нет')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && !('skip' in (r as any))) await pauseUntilTurn($, 'разговор сжат, кэша для него ещё нет')
    return r
  })
}
