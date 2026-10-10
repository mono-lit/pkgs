import { describe, expect, it } from 'vitest'
import type { NuxtPage } from '@nuxt/schema'
import { compareRouteScore, compileRoutePath, flattenPages } from '../../src/build/routes'

const matches = (path: string, url: string) => {
  const compiled = compileRoutePath(path)!
  const match = new RegExp(compiled.re, 'i').exec(url)
  return match ? match.slice(1) : null
}

describe('compileRoutePath', () => {
  it('matches static, dynamic, optional and catch-all paths like vue-router', () => {
    expect(matches('/', '/')).toEqual([])
    expect(matches('/dashboard', '/dashboard/')).toEqual([])
    expect(matches('/dashboard', '/Dashboard')).toEqual([])
    expect(matches('/users/:id()', '/users/42')).toEqual(['42'])
    expect(matches('/users/:id()', '/users/42/x')).toBeNull()
    expect(matches('/users/:id?', '/users')).toEqual([undefined])
    expect(matches('/users/:id?', '/users/7')).toEqual(['7'])
    expect(matches('/:slug(.*)*', '/a/b/c')).toEqual(['a/b/c'])
    expect(matches('/:slug(.*)*', '/')).toEqual([''])
    expect(matches('/posts/post-:id()-:slug()', '/posts/post-1-hello')).toEqual(['1', 'hello'])
  })

  it('describes params, including repeatable ones', () => {
    expect(compileRoutePath('/a/:id()/:rest(.*)*')!.params).toEqual([
      { name: 'id', repeat: false },
      { name: 'rest', repeat: true },
    ])
  })

  it('refuses syntax it does not understand', () => {
    expect(compileRoutePath('/a-:b?')).toBeNull()
    expect(compileRoutePath('/:id((a)|b)')).toBeNull()
  })

  it('orders static routes before dynamic and catch-all ones', () => {
    const paths = ['/:slug(.*)*', '/users/:id()', '/users/new', '/users/:id?']
    const sorted = [...paths].sort((a, b) => compareRouteScore(compileRoutePath(a)!.score, compileRoutePath(b)!.score))
    expect(sorted).toEqual(['/users/new', '/users/:id()', '/users/:id?', '/:slug(.*)*'])
  })
})

describe('flattenPages', () => {
  it('gives nested routes the files of every parent page', () => {
    const pages: NuxtPage[] = [
      { path: '/', file: '/p/index.vue' },
      {
        path: '/users',
        file: '/p/users.vue',
        children: [
          { path: '', file: '/p/users/index.vue' },
          { path: ':id()', file: '/p/users/[id].vue' },
        ],
      },
      { path: '/old', redirect: '/' },
    ]
    expect(flattenPages(pages)).toEqual([
      { path: '/', files: ['/p/index.vue'] },
      { path: '/users', files: ['/p/users.vue', '/p/users/index.vue'] },
      { path: '/users/:id()', files: ['/p/users.vue', '/p/users/[id].vue'] },
    ])
  })
})
