export default defineEventHandler((event) => {
  recordHit(event, 'zero')
  return 0
})
