import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cachedFetcher } from './fetch'

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

function cache (fetcher, options = {}) {
  return cachedFetcher(fetcher, {
    cacheExpiry: 100,
    forceRefreshThreshold: 200,
    keyGenerator: key => key,
    debug: false,
    ...options
  })
}

test('concurrent cold requests share one fetch and its result', async () => {
  const pending = deferred()
  let calls = 0
  const fetch = cache(() => { calls++; return pending.promise })
  const requests = Array.from({ length: 10 }, () => fetch('USD'))
  const started = calls
  const value = { price: 123 }
  pending.resolve(value)
  assert.deepEqual(await Promise.all(requests), Array(10).fill(value))
  assert.equal(started, 1)
  assert.equal(await fetch('USD'), value)
})

test('pending entries wait even when the eventual data is undefined', async () => {
  const pending = deferred()
  let calls = 0
  const fetch = cache(() => { calls++; return pending.promise })
  const first = fetch('key')
  const second = fetch('key')
  pending.resolve(undefined)
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined])
  assert.equal(await fetch('key'), undefined)
  assert.equal(calls, 1)
})

test('different keys still fetch independently', async () => {
  const pending = deferred()
  const keys = []
  const fetch = cache(key => { keys.push(key); return pending.promise })
  const requests = [fetch('USD'), fetch('EUR')]
  pending.resolve(1)
  await Promise.all(requests)
  assert.deepEqual(keys, ['USD', 'EUR'])
})

test('shared rejection reaches every caller and a later request can retry', async () => {
  const pending = deferred()
  let calls = 0
  const fetch = cache(() => ++calls === 1 ? pending.promise : Promise.resolve(42))
  const requests = [fetch('key'), fetch('key')]
  const error = new Error('provider unavailable')
  const results = Promise.allSettled(requests)
  pending.reject(error)
  for (const result of await results) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, error)
  }
  assert.equal(calls, 1)
  assert.equal(await fetch('key'), 42)
  assert.equal(calls, 2)
})

test('expired foreground requests share the replacement fetch', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const pending = deferred()
  let calls = 0
  const fetch = cache(() => ++calls === 1 ? Promise.resolve('old') : pending.promise)
  assert.equal(await fetch('key'), 'old')
  now = 201
  const requests = [fetch('key'), fetch('key')]
  pending.resolve('new')
  assert.deepEqual(await Promise.all(requests), ['new', 'new'])
  assert.equal(calls, 2)
})

test('stale reads retain their data while one background refresh runs', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const pending = deferred()
  let calls = 0
  const fetch = cache(() => ++calls === 1 ? Promise.resolve('old') : pending.promise)
  assert.equal(await fetch('key'), 'old')
  now = 101
  assert.equal(await fetch('key'), 'old')
  assert.equal(await fetch('key'), 'old')
  assert.equal(calls, 2)
  pending.resolve('new')
  await pending.promise
  assert.equal(await fetch('key'), 'new')
})
