import { describe, expect, it, vi } from 'vitest'
import { allMessages } from '../tools/acceptance/evidence.js'
import { safeCase3Events } from '../tools/acceptance/case3-recheck.js'

const direct = <T>(promise: Promise<T>) => promise
describe('acceptance current-turn pagination and durable evidence', () => {
  it('stops at the exact user boundary even when the server returns an unusable tail cursor', async () => {
    const list = vi.fn(async () => ({ data: [{ type: 'assistant', id: 'current-step' }, { type: 'user', id: 'current-inbox' }], cursor: { next: 'unusable-user-tail' } }))
    const messages = await allMessages({ message: { list } }, 'session', direct, 'current-inbox')
    expect(messages).toHaveLength(2); expect(list).toHaveBeenCalledOnce()
  })
  it('pages past a different user and ignores identical text as a boundary', async () => {
    const list = vi.fn().mockResolvedValueOnce({ data: [{ type: 'user', id: 'other', text: 'same' }], cursor: { next: 'next' } })
      .mockResolvedValueOnce({ data: [{ type: 'user', id: 'current', text: 'same' }], cursor: { next: 'bad-tail' } })
    expect(await allMessages({ message: { list } }, 'session', direct, 'current')).toHaveLength(2)
    expect(list).toHaveBeenCalledTimes(2); expect(list.mock.calls[1]?.[0].cursor).toBe('next')
    expect(list.mock.calls[0]?.[0].order).toBe('desc')
    expect(list.mock.calls[1]?.[0]).not.toHaveProperty('order')
  })
  it('does not interpret a short page or invalid cursor before the boundary as completion', async () => {
    const failure = new Error('InvalidCursorError')
    const list = vi.fn().mockResolvedValueOnce({ data: [{ type: 'assistant', id: 'step' }], cursor: { next: 'bad' } }).mockRejectedValueOnce(failure)
    await expect(allMessages({ message: { list } }, 'session', direct, 'missing-user')).rejects.toBe(failure)
    expect(list).toHaveBeenCalledTimes(2)
  })
  it('fails closed on endless unique cursors', async () => {
    let counter = 0
    const list = vi.fn(async () => ({ data: [], cursor: { next: `cursor-${++counter}` } }))
    await expect(allMessages({ message: { list } }, 'session', direct, 'missing-user')).rejects.toThrow('page limit')
    expect(list).toHaveBeenCalledTimes(100)
  })
  it('fails closed when the server repeats a cursor before the exact boundary', async () => {
    const list = vi.fn(async () => ({ data: [], cursor: { next: 'repeated' } }))
    await expect(allMessages({ message: { list } }, 'session', direct, 'missing-user')).rejects.toThrow('cursor loop')
    expect(list).toHaveBeenCalledTimes(2)
  })
  it('retains scoped request/source/reply IDs while hashing command and prompt contents', () => {
    const events = [
      { at: 'now', event: { type: 'permission.asked', data: { sessionID: 'ours', id: 'request', action: 'shell', resources: ['secret command'], source: { messageID: 'step', id: 'call' }, metadata: { password: 'private' } } } },
      { at: 'later', event: { type: 'permission.replied', data: { sessionID: 'ours', requestID: 'request', reply: 'reject' } } },
      { event: { type: 'session.inbox.enqueued', data: { sessionID: 'ours', inboxID: 'inbox', item: { payload: { text: 'private prompt' } } } } },
      { event: { type: 'permission.replied', data: { sessionID: 'other', requestID: 'unrelated', reply: 'once' } } },
    ]
    const projection = safeCase3Events(events, 'ours')
    expect(projection).toHaveLength(3)
    expect(projection[0]).toMatchObject({ requestID: 'request', source: { messageID: 'step', id: 'call' } })
    expect(projection[1]).toMatchObject({ requestID: 'request', reply: 'reject' })
    const text = JSON.stringify(projection)
    for (const secret of ['secret command', 'private prompt', 'password', 'unrelated']) expect(text).not.toContain(secret)
  })
})
