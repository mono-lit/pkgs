// Changes on every call: lets tests see that refresh() really refetched.
let counter = 0
export default defineEventHandler((event) => {
  recordHit(event, 'time')
  return { n: ++counter }
})
