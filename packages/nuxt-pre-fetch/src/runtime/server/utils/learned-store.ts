// Learned requests: Nitro side (storage + browser id cookie).
import type { H3Event } from 'h3'
import { getCookie, getRequestProtocol, setCookie } from 'h3'
import { useStorage } from 'nitropack/runtime'
import type { LearnedRequest, LearnStoreOptions } from '../../shared/types'
import type { LearnedIndex, LearnedPage } from './learned'
import { BROWSER_COOKIE, indexKey, indexPaths, isBrowserId, mergeLearnedPage, newBrowserId, pageKey, touchIndex } from './learned'

/** Nitro storage mount used for learned requests (in-memory unless the app mounts one). */
export const STORAGE_BASE = 'nuxt-pre-fetch'

const storage = () => useStorage(STORAGE_BASE)

/** This browser's id, or `undefined` (the cookie is only set by `ensureBrowserId`). */
export function getBrowserId(event: H3Event): string | undefined {
  const value = getCookie(event, BROWSER_COOKIE)
  return isBrowserId(value) ? value : undefined
}

/** Returns this browser's id, creating the (HttpOnly) cookie on the response when missing. */
export function ensureBrowserId(event: H3Event, options: LearnStoreOptions): string {
  const existing = getBrowserId(event)
  if (existing) return existing
  const id = newBrowserId()
  setCookie(event, BROWSER_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: options.ttl,
    secure: getRequestProtocol(event) === 'https',
  })
  return id
}

export async function readLearnedPage(browserId: string, path: string, options: LearnStoreOptions): Promise<LearnedPage | null> {
  const page = await storage().getItem<LearnedPage>(pageKey(browserId, path))
  if (!page || !Array.isArray(page.requests)) return null
  if (Date.now() - page.at > options.ttl * 1000) return null
  return page
}

export async function readLearnedPaths(browserId: string, options: LearnStoreOptions): Promise<string[]> {
  const index = await storage().getItem<LearnedIndex>(indexKey(browserId))
  return indexPaths(index, Date.now(), options.ttl * 1000)
}

/** Stores one reported batch (see `mergeLearnedPage`) and maintains the per-browser index. */
export async function writeLearnedPage(browserId: string, path: string, visit: string, requests: LearnedRequest[], options: LearnStoreOptions): Promise<LearnedPage> {
  const now = Date.now()
  const previous = await readLearnedPage(browserId, path, options)
  const page = mergeLearnedPage(previous, visit, requests, options.maxRequestsPerPage, now)
  const index = (await storage().getItem<LearnedIndex>(indexKey(browserId))) ?? {}
  const dropped = touchIndex(index, path, now, options.maxPages, options.ttl * 1000)
  await Promise.all([
    storage().setItem(pageKey(browserId, path), page),
    storage().setItem(indexKey(browserId), index),
    ...dropped.map(old => storage().removeItem(pageKey(browserId, old))),
  ])
  return page
}
