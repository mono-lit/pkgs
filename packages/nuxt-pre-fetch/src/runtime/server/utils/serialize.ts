const UNSAFE_CHARS = /[<>&\u2028\u2029]/g

/**
 * JSON for an HTML `<script type="application/json">` body. `<`, `>` and `&`
 * are escaped so API data can never close the element (`</script>`) or open a
 * comment; U+2028/U+2029 for older parsers. All of them only ever occur inside
 * JSON strings, where `\uXXXX` decodes back to the same characters.
 */
export function serializeForHTML(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE_CHARS, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Attribute-safe text (for the `data-path` attribute). */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
