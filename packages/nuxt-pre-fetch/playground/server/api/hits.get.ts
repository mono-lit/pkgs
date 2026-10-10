export default defineEventHandler((event) => {
  if (getQuery(event).reset !== undefined) resetHits()
  return readHits()
})
