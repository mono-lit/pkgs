// A JSON `null` body (returning `null` from a handler would send 204 No Content).
export default defineEventHandler((event) => {
  recordHit(event, 'null')
  setResponseHeader(event, 'content-type', 'application/json')
  return 'null'
})
