// Echoes the query so tests can check that each query is its own request.
export default defineEventHandler((event) => {
  const { status = 'all' } = getQuery(event)
  recordHit(event, `filtered:${status}`)
  return { status }
})
