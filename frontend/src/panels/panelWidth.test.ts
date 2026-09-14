// seam: panelWidth —— 面板宽度持久化纯逻辑（issue #668）。
// 好测试标准：只测外部行为——key 格式、读写往返与坏值兜底；
// Storage 真身注入（jsdom localStorage），不断言内部实现。
// owner 解析（tokenOwner）的直测在 stores/auth.test.ts——实现在 auth 域，此处只验 key 隔离。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  panelPoppedWidthKey,
  panelWidthKey,
  loadPanelWidth,
  savePanelWidth,
} from '@/panels/panelWidth'
import { tokenOwner } from '@/stores/auth'
import { INLINE_RANGE_NARROW, POPPED_VW_RANGE } from '@/panels/triState'

describe('panelWidthKey（key 家族 researcher:panel:<owner>:<view>:<panel>:width）', () => {
  it('按「owner + 页面 + 面板」隔离', () => {
    expect(panelWidthKey('alice', 'wiki', 'file-tree')).toBe('researcher:panel:alice:wiki:file-tree:width')
    expect(panelWidthKey('alice', 'wiki', 'file-tree'))
      .not.toBe(panelWidthKey('bob', 'wiki', 'file-tree'))
    expect(panelWidthKey('alice', 'chat', 'file-tree'))
      .not.toBe(panelWidthKey('alice', 'wiki', 'file-tree'))
  })

  it('owner 来自共享 tokenOwner（与 chat 草稿同一隔离语义）', () => {
    const token = `header.${btoa(JSON.stringify({ sub: 'alice' }))}.sig`
    expect(panelWidthKey(tokenOwner(token), 'wiki', 'file-tree'))
      .toBe('researcher:panel:alice:wiki:file-tree:width')
  })
})

describe('panelPoppedWidthKey（浮层宽度独立 key，spec #667 US26）', () => {
  it('与 inline 宽度 key 不同段但同族，且同样按 owner/页面/面板隔离', () => {
    expect(panelPoppedWidthKey('alice', 'wiki', 'file-tree'))
      .toBe('researcher:panel:alice:wiki:file-tree:popped-width')
    expect(panelPoppedWidthKey('alice', 'wiki', 'file-tree'))
      .not.toBe(panelWidthKey('alice', 'wiki', 'file-tree'))
    expect(panelPoppedWidthKey('alice', 'wiki', 'file-tree'))
      .not.toBe(panelPoppedWidthKey('bob', 'wiki', 'file-tree'))
  })

  it('两种宽度互不干扰：写 inline 不覆盖 popped，反之亦然（同族不同 key）', () => {
    const storage = globalThis.localStorage
    storage.clear()
    savePanelWidth(storage, panelWidthKey('alice', 'wiki', 'file-tree'), 400)
    savePanelWidth(storage, panelPoppedWidthKey('alice', 'wiki', 'file-tree'), 72)
    expect(loadPanelWidth(storage, panelWidthKey('alice', 'wiki', 'file-tree'), INLINE_RANGE_NARROW)).toBe(400)
    expect(loadPanelWidth(storage, panelPoppedWidthKey('alice', 'wiki', 'file-tree'), POPPED_VW_RANGE)).toBe(72)
  })
})

describe('loadPanelWidth / savePanelWidth（Storage 注入）', () => {
  let storage: Storage

  beforeEach(() => {
    storage = globalThis.localStorage
    storage.clear()
  })

  it('写读往返', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    savePanelWidth(storage, key, 400)
    expect(loadPanelWidth(storage, key, INLINE_RANGE_NARROW)).toBe(400)
  })

  it('无值返回 null', () => {
    expect(loadPanelWidth(storage, panelWidthKey('nobody', 'wiki', 'file-tree'), INLINE_RANGE_NARROW)).toBeNull()
  })

  it('storage 缺席（隐私模式）读 null 写不抛', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    expect(() => savePanelWidth(null, key, 400)).not.toThrow()
    expect(loadPanelWidth(null, key, INLINE_RANGE_NARROW)).toBeNull()
  })

  it('坏值（非数）返回 null', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    storage.setItem(key, 'garbage')
    expect(loadPanelWidth(storage, key, INLINE_RANGE_NARROW)).toBeNull()
  })

  it('越界存储值读出时钳制（存储值可能过期或被手改）', () => {
    const key = panelWidthKey('alice', 'wiki', 'file-tree')
    storage.setItem(key, '9999')
    expect(loadPanelWidth(storage, key, INLINE_RANGE_NARROW)).toBe(560)
    storage.setItem(key, '1')
    expect(loadPanelWidth(storage, key, INLINE_RANGE_NARROW)).toBe(160)
  })
})
