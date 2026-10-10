export default defineEventHandler((event) => {
  recordHit(event, 'users')
  return [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ]
})
