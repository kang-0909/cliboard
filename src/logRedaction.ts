const REDACTED = '[redacted]'

const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|authorization|auth|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|jwt|bearer|private[_-]?key)$/i

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|JWT|BEARER|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*([^\s'"]+)/gi

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi
const API_KEY_PATTERN = /\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{16,}\b/g
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function isSensitiveLogKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(key)
}

export function redactLogString(value: string) {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(API_KEY_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, name: string) => `${name}=${REDACTED}`)
}

export function redactLogValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveLogKey(key)) return REDACTED
  if (typeof value === 'string') return redactLogString(value)
  return value
}
