const USERS: Record<string, { id: number, name: string }> = {
  1: { id: 1, name: 'Ada' },
  2: { id: 2, name: 'Grace' },
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  recordHit(event, `user:${id}`)
  const user = USERS[id]
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })
  return user
})
