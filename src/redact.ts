/**
 * Secret redaction. Non-negotiable: no secret value ever appears in a tool
 * response, an audit log entry, or a Slack message.
 */

/**
 * Mask a single secret value, keeping just enough of a recognizable prefix to be
 * useful for a human ("is this the right key?") without leaking the secret.
 * Examples: "sk-abcd1234..." -> "sk-****", "abc" -> "****".
 */
export function maskValue(value: string): string {
  if (value === undefined || value === null) return '****';
  const str = String(value);
  // Keep a short alpha/dash prefix if the value looks like a typed key (sk-, ghp-, etc.).
  const prefixMatch = str.match(/^([A-Za-z]{2,5}[-_])/);
  if (prefixMatch && prefixMatch[1]) {
    return `${prefixMatch[1]}****`;
  }
  return '****';
}

/** Turn a key/value variable map into "KEY = masked" display lines. */
export function maskVariableMap(vars: Record<string, string>): string[] {
  return Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} = ${maskValue(value)}`);
}

/**
 * Redact tool arguments before they are written to the audit log. We log that a
 * variable was set, never its value. Any argument key that looks like it holds
 * secret values is stripped down to the list of affected variable KEYS only.
 */
export function redactArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'variables' && value && typeof value === 'object' && !Array.isArray(value)) {
      // { KEY: "secret" } -> log only the keys that were touched.
      out[key] = { keys: Object.keys(value as Record<string, unknown>) };
    } else if (/secret|password|token|value/i.test(key) && typeof value === 'string') {
      out[key] = '****';
    } else {
      out[key] = value;
    }
  }
  return out;
}
