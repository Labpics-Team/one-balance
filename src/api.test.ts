import { describe, it, expect } from 'vitest'
import { cooldownSecondsFor429 } from './api'

// Builds a Gemini-style 429 error Response with the given error details.
function gemini429(details: unknown[]): Response {
    return new Response(JSON.stringify({ error: { code: 429, message: 'rate limited', details } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
    })
}

describe('cooldownSecondsFor429 — 429 classification (replaces the 24h consecutive-count bench)', () => {
    it('per-day (RPD) quota → benches until midnight PT (large, not the short fallbacks)', async () => {
        const resp = gemini429([
            {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }]
            }
        ])
        const sec = await cooldownSecondsFor429(resp, 'google-ai-studio')
        // Seconds-until-midnight-PT is in (0, 86400]; crucially it is NOT one of
        // the short per-minute fallbacks (39 / 65) — RPD genuinely benches the key.
        expect(sec).toBeGreaterThan(0)
        expect(sec).toBeLessThanOrEqual(24 * 60 * 60)
        expect(sec).not.toBe(65)
    })

    it('per-minute limit with RetryInfo → short cooldown (retryDelay + 2s), NOT a 24h bench', async () => {
        const resp = gemini429([
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }
        ])
        const sec = await cooldownSecondsFor429(resp, 'google-ai-studio')
        expect(sec).toBe(39)
    })

    it('QuotaFailure that is NOT per-day still resolves via RetryInfo as a short cooldown', async () => {
        const resp = gemini429([
            {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }]
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }
        ])
        const sec = await cooldownSecondsFor429(resp, 'google-ai-studio')
        expect(sec).toBe(14)
    })

    it('unclassified 429 (no QuotaFailure/RetryInfo) → 65s fallback', async () => {
        const resp = gemini429([])
        const sec = await cooldownSecondsFor429(resp, 'google-ai-studio')
        expect(sec).toBe(65)
    })

    it('unparseable body → 65s fallback, never throws', async () => {
        const resp = new Response('not json', { status: 429 })
        const sec = await cooldownSecondsFor429(resp, 'google-ai-studio')
        expect(sec).toBe(65)
    })

    it('non-google provider falls back to 65s when no rate-limit headers', async () => {
        const resp = new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } })
        const sec = await cooldownSecondsFor429(resp, 'some-other-provider')
        expect(sec).toBe(65)
    })
})
