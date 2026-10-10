export default defineEventHandler((event) => {
  recordHit(event, 'empty')
  return []
})
