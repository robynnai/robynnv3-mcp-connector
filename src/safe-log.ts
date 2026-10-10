/**
 * Redacting structured logger for the Worker (COS-PLUGIN-001 P06).
 *
 * Worker logs must never carry OAuth codes, state, access/refresh tokens,
 * signatures, cookies, query strings, `Location` headers or upstream response
 * bodies. Callers pass an event name plus a flat record of primitive fields;
 * this module drops sensitive keys outright and scrubs every string value
 * before it reaches `console`. There is deliberately no way to log an object,
 * an Error message or a raw body.
 */

export type SafeLogValue = string | number | boolean | null | undefined;
export type SafeLogFields = Record<string, SafeLogValue>;
type Level = "info" | "warn" | "error";

const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 160;
const EVENT_PATTERN = /^[a-z0-9_.]{1,80}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z0-9_]{1,60}$/;

// Field names whose values are never logged, whatever they contain.
const SENSITIVE_FIELD =
  /(^|_)(code|state|token|tokens|secret|password|authorization|cookie|signature|verifier|challenge|nonce|location|body|query|bearer|jwt|props|credential|session_?id)$|(Code|State|Token|Secret|Password|Authorization|Cookie|Signature|Verifier|Challenge|Nonce|Location|Body|Query|Bearer|Jwt|Props|Credential|SessionId)$/;

// Every regex below runs on at most MAX_INPUT_LENGTH characters and uses
// bounded quantifiers, so worst-case backtracking is a small constant per
// call even for attacker-chosen values (P06 review B1: unbounded patterns on
// an unauthenticated `grant_type` were quadratic).
const MAX_INPUT_LENGTH = 512;
const URL_PATTERN = /\b([a-z][a-z0-9+.-]{0,31}):\/\/([^\s"'<>?#]{0,256})[^\s"'<>]{0,512}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{0,512}\.[A-Za-z0-9_-]{0,512}\.[A-Za-z0-9_-]{0,512}/g;
const PROVIDER_TOKEN_PATTERN = /[A-Za-z0-9_-]{4,64}:[A-Za-z0-9_-]{4,64}:[A-Za-z0-9_-]{8,128}/g;
const KEY_VALUE_PATTERN =
  /\b(code|state|token|access_token|refresh_token|id_token|secret|password|signature|nonce|code_verifier|code_challenge)=[^\s&"']{0,512}/gi;
const LONG_RUN_PATTERN = /[A-Za-z0-9_\-+/=]{20,512}/g;

/** Scrub one string value: URLs lose query/fragment, token-like runs vanish. */
export function redactLogString(value: string): string {
  // Cap first: nothing longer than MAX_INPUT_LENGTH ever reaches a regex.
  // A cut can split a secret; drop the trailing token-like fragment too.
  const capped =
    value.length > MAX_INPUT_LENGTH
      ? `${value.slice(0, MAX_INPUT_LENGTH).replace(/[A-Za-z0-9_\-+/=.:%~]{1,512}$/, "")}…`
      : value;
  const scrubbed = capped
    .replace(JWT_PATTERN, REDACTED)
    .replace(URL_PATTERN, (_match, scheme: string, rest: string) => `${scheme}://${rest}`)
    .replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(PROVIDER_TOKEN_PATTERN, REDACTED)
    // Long runs with digits or capitals look like secrets; lower-case
    // snake_case reason codes stay readable.
    .replace(LONG_RUN_PATTERN, (run) => (/[A-Z0-9+/=]/.test(run) ? REDACTED : run))
    // Control characters (log injection) never reach the sink.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");

  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}

function sanitizeFields(fields: SafeLogFields | undefined): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = {};
  if (!fields) return out;

  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_NAME_PATTERN.test(key)) continue;
    if (SENSITIVE_FIELD.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactLogString(value);
    } else if (
      value === null ||
      value === undefined ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      out[key] = value;
    }
  }

  return out;
}

function emit(level: Level, event: string, fields?: SafeLogFields) {
  const safeEvent = EVENT_PATTERN.test(event) ? event : "invalid_event_name";
  const line = JSON.stringify({ event: safeEvent, ...sanitizeFields(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const safeLog = {
  info: (event: string, fields?: SafeLogFields) => emit("info", event, fields),
  warn: (event: string, fields?: SafeLogFields) => emit("warn", event, fields),
  error: (event: string, fields?: SafeLogFields) => emit("error", event, fields),
};

/**
 * Loggable description of a thrown value: the constructor name only. Error
 * messages can embed URLs, upstream bodies or tokens, so they are never logged.
 */
export function errorKind(err: unknown): string {
  if (err instanceof Error) {
    return /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : "Error";
  }
  return typeof err;
}
