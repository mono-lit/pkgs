export default defineEventHandler((event) => {
  recordHit(event, 'false')
  return false
})
