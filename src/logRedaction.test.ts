import { describe, expect, it } from 'vitest'
import { isSensitiveLogKey, redactLogString, redactLogValue } from './logRedaction'

describe('log redaction', () => {
  it('redacts sensitive object keys', () => {
    expect(redactLogValue('sk-abcdefghijklmnopqrstuvwxyz123456', 'apiKey')).toBe('[redacted]')
    expect(redactLogValue('Bearer abcdefghijklmnop', 'authorization')).toBe('[redacted]')
    expect(isSensitiveLogKey('prompt_tokens')).toBe(false)
  })

  it('redacts common secret strings while keeping surrounding text readable', () => {
    const text = [
      'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart',
    ].join('\n')

    const redacted = redactLogString(text)
    expect(redacted).toContain('Bearer [redacted]')
    expect(redacted).toContain('OPENAI_API_KEY=[redacted]')
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    expect(redacted).not.toContain('eyJhbGci')
  })
})
