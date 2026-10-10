// 204 No Content: `$fetch` resolves to `undefined` in the browser and on Nitro alike.
export default defineEventHandler((event) => {
  recordHit(event, 'no-content')
  return null
})
