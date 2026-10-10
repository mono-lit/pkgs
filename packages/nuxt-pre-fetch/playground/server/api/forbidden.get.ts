export default defineEventHandler((event) => {
  recordHit(event, 'forbidden')
  throw createError({ statusCode: 403, statusMessage: 'Forbidden', data: { reason: 'no access' } })
})
