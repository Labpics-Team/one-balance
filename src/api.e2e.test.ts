import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the D1-backed key service so these e2e tests exercise the worker's
// request handling (routing, vending contract, retry loop) without a database.
vi.mock('./service/key', () => ({
    listActiveKeysViaCache: vi.fn(),
    setKeyStatus: vi.fn(async () => {}),
    setKeyModelCooldownIfAvailable: vi.fn(async () => {})
}))

import * as keyService from './service/key'
import { handle } from './api'

const KEY_MANAGER_TOKEN = 'kmt-test'
const AUTH_KEY = 'svc-test'

function makeEnv(): Env {
    return {
        AUTH_KEY,
        KEY_MANAGER_TOKEN,
        AI_GATEWAY: 'one-balance',
        AI: { gateway: (_name: string) => ({ getUrl: async () => 'https://gateway.example/' }) }
    } as unknown as Env
}

function makeCtx(): ExecutionContext {
    return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

// Several keys so the retry loop can rotate (forward() splices each tried key
// out of the pool — prod gets a fresh array per call, so the mock must too).
const sampleKeys = [
    { id: 'key-1', key: 'secret-1', modelCoolings: {} },
    { id: 'key-2', key: 'secret-2', modelCoolings: {} },
    { id: 'key-3', key: 'secret-3', modelCoolings: {} }
]

beforeEach(() => {
    vi.clearAllMocks()
    ;(keyService.listActiveKeysViaCache as any).mockImplementation(async () =>
        sampleKeys.map(k => ({ ...k, modelCoolings: { ...k.modelCoolings } }))
    )
})

// ─── Key Manager vending contract (ai-node depends on this byte-for-byte) ───

describe('Key Manager vending contract', () => {
    it('GET /api/keys/next returns {key,id,cooling_until} with a valid token', async () => {
        const req = new Request('https://ob/api/keys/next?provider=google-ai-studio&model=gemini-2.5-flash', {
            method: 'GET',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}` }
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Type')).toContain('application/json')
        const body = (await res.json()) as { key: string; id: string; cooling_until: number | null }
        // Contract shape ai-node reads — exact key is selectKey's (random) choice.
        expect(Object.keys(body).sort()).toEqual(['cooling_until', 'id', 'key'])
        expect(body.key).toMatch(/^secret-/)
        expect(body.id).toMatch(/^key-/)
        expect(body.cooling_until).toBeNull()
    })

    it('GET /api/keys/next rejects a bad KEY_MANAGER_TOKEN with 401', async () => {
        const req = new Request('https://ob/api/keys/next?provider=google-ai-studio&model=m', {
            method: 'GET',
            headers: { Authorization: 'Bearer wrong' }
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(401)
    })

    it('GET /api/keys/next → 400 without provider/model', async () => {
        const req = new Request('https://ob/api/keys/next', {
            method: 'GET',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}` }
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(400)
    })

    it('GET /api/keys/next → 503 when the pool is empty', async () => {
        ;(keyService.listActiveKeysViaCache as any).mockResolvedValue([])
        const req = new Request('https://ob/api/keys/next?provider=google-ai-studio&model=m', {
            method: 'GET',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}` }
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(503)
    })

    it('POST /api/keys/{id}/status {blocked} marks the key blocked', async () => {
        const req = new Request('https://ob/api/keys/key-1/status', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocked: true, provider: 'google-ai-studio' })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(200)
        expect(keyService.setKeyStatus).toHaveBeenCalledWith(expect.anything(), 'google-ai-studio', 'key-1', 'blocked')
    })

    it('POST /api/keys/{id}/status {rate_limited} cools the key for the model', async () => {
        const req = new Request('https://ob/api/keys/key-1/status', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rate_limited: true,
                retry_after: 60,
                provider: 'google-ai-studio',
                model: 'gemini-2.5-flash'
            })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(200)
        expect(keyService.setKeyModelCooldownIfAvailable).toHaveBeenCalledWith(
            expect.anything(),
            'key-1',
            'google-ai-studio',
            'gemini-2.5-flash',
            60
        )
    })

    it('POST /api/keys/{id}/status {blocked} → 400 when provider is missing (no defaulting)', async () => {
        const req = new Request('https://ob/api/keys/key-1/status', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ blocked: true })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(400)
        expect(keyService.setKeyStatus).not.toHaveBeenCalled()
    })

    it('POST /api/keys/{id}/status {rate_limited} → 400 when provider is missing (no defaulting)', async () => {
        const req = new Request('https://ob/api/keys/key-1/status', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ rate_limited: true, retry_after: 60, model: 'gemini-2.5-flash' })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(400)
        expect(keyService.setKeyModelCooldownIfAvailable).not.toHaveBeenCalled()
    })

    it('POST /api/keys/{id}/status {ok} returns 200', async () => {
        const req = new Request('https://ob/api/keys/key-1/status', {
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY_MANAGER_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(200)
    })
})

// ─── Proxy path: happy path intact + bounded retry (the avalanche fix) ──────

describe('proxy forward() — happy path + bounded retry', () => {
    const proxyReq = () =>
        new Request('https://ob/api/compat/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${AUTH_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'google-ai-studio/gemini-2.5-flash', messages: [] })
        })

    it('passes a 200 straight through (happy path unchanged)', async () => {
        const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const res = await handle(proxyReq(), makeEnv(), makeCtx())
        expect(res.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('caps retries at 3 on persistent 429 and returns a clean 429 + Retry-After', async () => {
        const body429 = JSON.stringify({
            error: {
                code: 429,
                details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }]
            }
        })
        const fetchMock = vi.fn(async () => new Response(body429, { status: 429 }))
        vi.stubGlobal('fetch', fetchMock)

        const res = await handle(proxyReq(), makeEnv(), makeCtx())

        expect(fetchMock).toHaveBeenCalledTimes(3) // MAX_RETRIES = 3, not 30
        expect(res.status).toBe(429) // real rate-limit signal, not a generic 500
        expect(res.headers.get('Retry-After')).toBe('32') // 30 + 2s buffer
        expect(keyService.setKeyModelCooldownIfAvailable).toHaveBeenCalled()
    })

    it('returns a 400 user error without retrying (not a key problem)', async () => {
        const fetchMock = vi.fn(async () => new Response('{"error":"bad request"}', { status: 400 }))
        vi.stubGlobal('fetch', fetchMock)
        const res = await handle(proxyReq(), makeEnv(), makeCtx())
        expect(res.status).toBe(400)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects a request with an invalid service AUTH_KEY (403)', async () => {
        const req = new Request('https://ob/api/compat/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'google-ai-studio/gemini-2.5-flash', messages: [] })
        })
        const res = await handle(req, makeEnv(), makeCtx())
        expect(res.status).toBe(403)
    })
})
