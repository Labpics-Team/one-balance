#!/usr/bin/env node
// Opt-in smoke test against a DEPLOYED one-balance. NOT part of CI — it hits a
// live worker and consumes a real pooled key. Everything comes from env; no
// secrets are hardcoded.
//
//   ONE_BALANCE_URL=https://one-balance.example.workers.dev \
//   GEMINI_PROXY_KEY=your-service-auth-key \
//   pnpm smoke
//
// Exit codes: 0 = all checks passed, 1 = a check failed, 2 = misconfigured env.

const url = process.env.ONE_BALANCE_URL
const key = process.env.GEMINI_PROXY_KEY

if (!url || !key) {
    console.error('Missing env. Required: ONE_BALANCE_URL and GEMINI_PROXY_KEY.')
    process.exit(2)
}

const base = url.replace(/\/+$/, '')
const results = []

function record(name, ok, detail) {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${detail}`)
}

async function checkHealth() {
    const endpoint = `${base}/health`
    try {
        const res = await fetch(endpoint)
        const text = (await res.text()).trim()
        record('health', res.ok && text === 'ok', `HTTP ${res.status} body="${text}"`)
    } catch (e) {
        record('health', false, `error: ${e.message}`)
    }
}

async function checkListModels() {
    const endpoint = `${base}/api/google-ai-studio/v1beta/models`
    try {
        const res = await fetch(endpoint, { headers: { 'x-goog-api-key': key } })
        let extra = ''
        try {
            const json = await res.json()
            if (Array.isArray(json.models)) extra = ` (${json.models.length} models)`
        } catch {
            // non-JSON body is fine to ignore for a smoke check
        }
        record('listModels', res.ok, `HTTP ${res.status}${extra}`)
    } catch (e) {
        record('listModels', false, `error: ${e.message}`)
    }
}

async function checkGenerateContent() {
    const endpoint = `${base}/api/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent`
    const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 8 }
    })
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body
        })
        record('generateContent', res.ok, `HTTP ${res.status}`)
    } catch (e) {
        record('generateContent', false, `error: ${e.message}`)
    }
}

console.log(`Smoke testing ${base}`)
await checkHealth()
await checkListModels()
await checkGenerateContent()

const failed = results.filter(r => !r.ok)
console.log('')
if (failed.length === 0) {
    console.log(`PASS — all ${results.length} checks passed`)
    process.exit(0)
}
console.log(`FAIL — ${failed.length}/${results.length} failed: ${failed.map(r => r.name).join(', ')}`)
process.exit(1)
