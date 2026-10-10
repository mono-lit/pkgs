export default defineEventHandler((event) => {
  recordHit(event, 'xss')
  return { html: '</script><script>window.__pwned = true</script>', line: 'a' + String.fromCharCode(0x2028) + 'b' }
})
