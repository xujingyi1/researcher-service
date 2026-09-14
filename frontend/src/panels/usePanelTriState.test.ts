// seam: usePanelTriState —— 三态包装 composable（issue #668 / spec #667）。
// 好测试标准：只断言外部行为——状态/宽度 refs 的值、持久化副作用（jsdom localStorage
// 真身）、合成指针事件驱动真 PanelTriState 的全链路；不断言内部实现。
// 依赖注入（storage/viewport/token）由 options 传入，测试可控。
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PanelTriState from '@/components/PanelTriState.vue'
import { usePanelTriState } from '@/panels/usePanelTriState'
import { usePanelGroup } from '@/panels/usePanelGroup'
import { panelPoppedWidthKey, panelWidthKey } from '@/panels/panelWidth'
import { INLINE_RANGE_NARROW, INLINE_RANGE_WIDE } from '@/panels/triState'

function mountHarness(options: Parameters<typeof usePanelTriState>[0]) {
  let api!: ReturnType<typeof usePanelTriState>
  mount(defineComponent({
    setup() {
      api = usePanelTriState(options)
      return () => h('div')
    },
  }))
  return api
}

function keyOf(owner: string): string {
  return panelWidthKey(owner, 'wiki', 'file-tree')
}

function poppedKeyOf(owner: string): string {
  return panelPoppedWidthKey(owner, 'wiki', 'file-tree')
}

const BASE = {
  view: 'wiki',
  panel: 'file-tree',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: 220,
  token: () => 'header.' + btoa(JSON.stringify({ sub: 'alice' })) + '.sig',
} as const

describe('usePanelTriState — 初始态', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('每次进页恒 inline（collapsed/popped 不持久化），宽度默认值，浮层默认 50vw', () => {
    const p = mountHarness(BASE)
    expect(p.state.value).toBe('inline')
    expect(p.inlineWidth.value).toBe(220)
    expect(p.poppedVw.value).toBe(50)
    expect(p.disabled.value).toBe(false)
  })

  it('storage 有值则恢复宽度', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '400')
    const p = mountHarness(BASE)
    expect(p.inlineWidth.value).toBe(400)
  })

  it('恢复值越界时钳制', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '9999')
    expect(mountHarness(BASE).inlineWidth.value).toBe(560)
  })

  it('按用户 token 隔离：alice 存的宽度 bob 读不到', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '400')
    const bob = mountHarness({ ...BASE, token: () => 'header.' + btoa(JSON.stringify({ sub: 'bob' })) + '.sig' })
    expect(bob.inlineWidth.value).toBe(220)
  })
})

describe('usePanelTriState — 状态机驱动', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('折叠 → 弹出 → 收回 全链路', () => {
    const p = mountHarness(BASE)
    p.onCollapse()
    expect(p.state.value).toBe('collapsed')
    p.onPop()
    expect(p.state.value).toBe('popped')
    p.onRestore()
    expect(p.state.value).toBe('inline')
  })

  it('窄条展开小按钮不经弹出直接回 inline', () => {
    const p = mountHarness(BASE)
    p.onCollapse()
    p.onExpand()
    expect(p.state.value).toBe('inline')
    expect(p.poppedVw.value).toBe(50) // 未经过弹出
  })

  it('resize 钳制：inline 160–560、popped 50–90vw（viewport 注入）', () => {
    const p = mountHarness({ ...BASE, getViewportWidth: () => 1280 })
    p.onResizeInline(1000)
    expect(p.inlineWidth.value).toBe(560)
    p.onResizeInline(50)
    expect(p.inlineWidth.value).toBe(160)
    p.onResizePopped(960) // 1280×75%
    expect(p.poppedVw.value).toBe(75)
    p.onResizePopped(100)
    expect(p.poppedVw.value).toBe(50)
  })
})

describe('usePanelTriState — 持久化时机（inline / popped 宽度各落各 key，态不落盘）', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('inline 拖拽结束写入 inline key', () => {
    const p = mountHarness(BASE)
    p.onResizeInline(480)
    p.onDragEnd()
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBe('480')
  })

  // spec #667 US26：弹出宽度被记住（而弹出/折叠态本身不记）。此前实现为「不写入」并
  // 有反向用例锁死——那是与 spec 相反的行为，已按 spec 更正。
  it('popped 拖拽结束写入 popped key（浮层宽度被记住）', () => {
    const p = mountHarness({ ...BASE, getViewportWidth: () => 1280 })
    p.onCollapse()
    p.onPop()
    p.onResizePopped(896) // 1280×70%
    expect(p.poppedVw.value).toBe(70)
    p.onDragEnd()
    expect(globalThis.localStorage.getItem(poppedKeyOf('alice'))).toBe('70')
    // 不污染 inline key
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBeNull()
  })

  it('popped 宽度重进恢复；形态仍恒回 inline（态不持久化）', () => {
    globalThis.localStorage.setItem(poppedKeyOf('alice'), '72')
    const p = mountHarness({ ...BASE, getViewportWidth: () => 1280 })
    expect(p.state.value).toBe('inline')
    expect(p.poppedVw.value).toBe(72)
    p.onCollapse()
    p.onPop()
    expect(p.state.value).toBe('popped')
    expect(p.poppedVw.value).toBe(72) // 收回后再弹出仍是记住的宽度
  })

  it('popped 宽度越界存储值读出时钳制到 50–90vw', () => {
    globalThis.localStorage.setItem(poppedKeyOf('alice'), '120')
    expect(mountHarness(BASE).poppedVw.value).toBe(90)
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem(poppedKeyOf('alice'), '10')
    expect(mountHarness(BASE).poppedVw.value).toBe(50)
  })

  it('popped 宽度按用户 token 隔离', () => {
    globalThis.localStorage.setItem(poppedKeyOf('alice'), '72')
    const bob = mountHarness({ ...BASE, token: () => 'header.' + btoa(JSON.stringify({ sub: 'bob' })) + '.sig' })
    expect(bob.poppedVw.value).toBe(50)
  })
})

describe('usePanelTriState — 组内互斥（spec #667 US25：同页至多一个 popped）', () => {
  beforeEach(() => globalThis.localStorage.clear())

  const GRAPH = {
    ...BASE,
    panel: 'graph',
    inlineRange: INLINE_RANGE_WIDE,
    defaultInlineWidth: 320,
  } as const

  function mountPair() {
    let a!: ReturnType<typeof usePanelTriState>
    let b!: ReturnType<typeof usePanelTriState>
    mount(defineComponent({
      setup() {
        const group = usePanelGroup() // 每页一个组实例（非模块级单例）
        a = usePanelTriState({ ...BASE, group })
        b = usePanelTriState({ ...GRAPH, group })
        return () => h('div')
      },
    }))
    return { a, b }
  }

  it('弹 B 自动收回已 popped 的 A（恒至多一个 popped）', () => {
    const { a, b } = mountPair()
    a.onCollapse()
    a.onPop()
    expect(a.state.value).toBe('popped')
    b.onCollapse()
    b.onPop()
    expect(b.state.value).toBe('popped')
    expect(a.state.value).toBe('inline') // A 被自动收回
  })

  it('反向同样成立', () => {
    const { a, b } = mountPair()
    b.onCollapse()
    b.onPop()
    a.onCollapse()
    a.onPop()
    expect(a.state.value).toBe('popped')
    expect(b.state.value).toBe('inline')
  })

  it('非 pop 事件不触发互斥（收起着不与兄弟联动）', () => {
    const { a, b } = mountPair()
    a.onCollapse()
    a.onPop()
    b.onCollapse() // B 折叠成窄条——A 的浮层不受影响
    expect(a.state.value).toBe('popped')
    expect(b.state.value).toBe('collapsed')
    b.onExpand()
    expect(a.state.value).toBe('popped')
    expect(b.state.value).toBe('inline')
  })

  it('不传 group 的单面板实例行为不变（#671 前的兼容路径）', () => {
    const solo = mountHarness(BASE)
    solo.onCollapse()
    solo.onPop()
    expect(solo.state.value).toBe('popped')
    solo.onRestore()
    expect(solo.state.value).toBe('inline')
  })

  it('组不是模块级单例：同一次 setup 内两个组互不串扰', () => {
    let wikiA!: ReturnType<typeof usePanelTriState>
    let chatA!: ReturnType<typeof usePanelTriState>
    mount(defineComponent({
      setup() {
        const wikiGroup = usePanelGroup()
        const chatGroup = usePanelGroup()
        wikiA = usePanelTriState({ ...BASE, group: wikiGroup })
        chatA = usePanelTriState({ ...BASE, view: 'chat', group: chatGroup })
        return () => h('div')
      },
    }))
    wikiA.onCollapse()
    wikiA.onPop()
    expect(wikiA.state.value).toBe('popped')
    expect(chatA.state.value).toBe('inline') // chat 页的组各管各的
  })
})

describe('usePanelTriState — 窄屏禁用（viewport 注入 + resize 联动）', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('<720 禁用，≥720 启用', () => {
    const p = mountHarness({ ...BASE, getViewportWidth: () => 500 })
    expect(p.disabled.value).toBe(true)
    expect(p.viewportWidth.value).toBe(500)
  })

  it('窗口 resize 跨阈值时联动（用户拉伸窗口）', () => {
    const getViewportWidth = vi.fn(() => 1024)
    const p = mountHarness({ ...BASE, getViewportWidth })
    expect(p.disabled.value).toBe(false)
    getViewportWidth.mockReturnValue(600)
    window.dispatchEvent(new Event('resize'))
    expect(p.disabled.value).toBe(true)
    getViewportWidth.mockReturnValue(1024)
    window.dispatchEvent(new Event('resize'))
    expect(p.disabled.value).toBe(false)
  })
})

describe('usePanelTriState — 端到端：真 PanelTriState + 合成指针事件 + localStorage', () => {
  beforeEach(() => globalThis.localStorage.clear())

  function mountE2E() {
    let api!: ReturnType<typeof usePanelTriState>
    const harness = defineComponent({
      setup() {
        api = usePanelTriState(BASE)
        return () => h(PanelTriState, {
          state: api.state.value,
          inlineWidth: api.inlineWidth.value,
          defaultWidth: 220,
          poppedVw: api.poppedVw.value,
          viewportWidth: api.viewportWidth.value,
          label: '文件树',
          'onCollapse': api.onCollapse,
          'onPop': api.onPop,
          'onExpand': api.onExpand,
          'onRestore': api.onRestore,
          'onResizeInline': api.onResizeInline,
          'onResizePopped': api.onResizePopped,
          'onDragEnd': api.onDragEnd,
        }, { default: () => h('div', '内容') })
      },
    })
    return { wrapper: mount(harness), api }
  }

  it('拖拽 → 宽度钳制更新 → 松手落 storage → 重进恢复', async () => {
    const { wrapper, api } = mountE2E()
    const handle = wrapper.get('[data-test="drag-handle"]')
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 480 })) // 220+280=500，界内
    expect(api.inlineWidth.value).toBe(500)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 800 })) // 220+600=820 → 钳 560
    expect(api.inlineWidth.value).toBe(560)
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBe('560')

    // 重进（重新挂载 harness）→ 宽度恢复，形态恒 inline
    const again = mountE2E()
    expect(again.api.state.value).toBe('inline')
    expect(again.api.inlineWidth.value).toBe(560)
  })

  it('折叠 → 点窄条弹出 → 收回，全链路事件驱动', async () => {
    const { wrapper, api } = mountE2E()
    await wrapper.get('[data-test="collapse-btn"]').trigger('click')
    expect(wrapper.find('[data-test="rail"]').exists()).toBe(true)
    await wrapper.get('[data-test="rail"]').trigger('click')
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('popped')
    await wrapper.get('[data-test="restore-btn"]').trigger('click')
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('inline')
    expect(api.state.value).toBe('inline')
  })
})
