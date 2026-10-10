export default defineEventHandler((event) => {
  recordHit(event, 'products')
  return [{ id: 10, name: 'Product A' }]
})
