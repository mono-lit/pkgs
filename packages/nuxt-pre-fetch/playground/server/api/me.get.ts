// "Authentication": the user comes from a cookie, so each browser sees its own data.
export default defineEventHandler((event) => {
  recordHit(event, 'me')
  const user = getCookie(event, 'user')
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  return { user }
})
