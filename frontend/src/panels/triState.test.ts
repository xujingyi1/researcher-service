// seam: triState —— 面板三态纯逻辑（issue #668 / spec #667 决策层）。
// 状态机转移表（inline → collapsed → popped → inline；collapsed 可直接展开回 inline）、
// 宽度钳制、vw↔px 换算、拖拽几何、窄屏判定——全部纯函数，DOM 度量由宿主注入
// （贴滚动判定 shouldFollowBottom 先例：几何进参数，不摸 window/document）。
import { describe, expect, it } from 'vitest'
import {
  INLINE_RANGE_NARROW,
  INLINE_RANGE_WIDE,
  NARROW_VIEWPORT_MAX,
  POPPED_DEFAULT_VW,
  POPPED_MAX_VW,
  POPPED_MIN_VW,
  POPPED_VW_RANGE,
  clampPoppedVw,
  clampRange,
  draggedWidth,
  pxToVw,
  transitionGroup,
  transitionPanelState,
  triStateEnabled,
  vwToPx,
} from '@/panels/triState'

describe('transitionPanelState（三态状态机）', () => {
  it('inline --collapse--> collapsed', () => {
    expect(transitionPanelState('inline', 'collapse')).toBe('collapsed')
  })

  it('collapsed --pop--> popped（点击窄条弹出）', () => {
    expect(transitionPanelState('collapsed', 'pop')).toBe('popped')
  })

  it('collapsed --expand--> inline（窄条展开小按钮，不经弹出）', () => {
    expect(transitionPanelState('collapsed', 'expand')).toBe('inline')
  })

  it('popped --restore--> inline（浮层显式收回）', () => {
    expect(transitionPanelState('popped', 'restore')).toBe('inline')
  })

  it('非法转移幂等返回原状态（如 inline 上误触 pop/expand）', () => {
    expect(transitionPanelState('inline', 'pop')).toBe('inline')
    expect(transitionPanelState('inline', 'expand')).toBe('inline')
    expect(transitionPanelState('inline', 'restore')).toBe('inline')
    expect(transitionPanelState('collapsed', 'collapse')).toBe('collapsed')
    expect(transitionPanelState('collapsed', 'restore')).toBe('collapsed')
    // popped 只能显式收回——不因 collapse 误触离开
    expect(transitionPanelState('popped', 'collapse')).toBe('popped')
    expect(transitionPanelState('popped', 'pop')).toBe('popped')
    expect(transitionPanelState('popped', 'expand')).toBe('popped')
  })
})

describe('clampRange（inline 拖宽硬边界）', () => {
  it('界内原样返回', () => {
    expect(clampRange(220, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(220)
    expect(clampRange(160, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(160)
    expect(clampRange(560, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(560)
  })

  it('越界钳制到 min/max（中间编辑区不被挤没）', () => {
    expect(clampRange(100, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(160)
    expect(clampRange(9999, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(560)
  })

  it('wide 档（图谱/文件预览 240–720）同样生效', () => {
    expect(clampRange(100, INLINE_RANGE_WIDE.min, INLINE_RANGE_WIDE.max)).toBe(240)
    expect(clampRange(800, INLINE_RANGE_WIDE.min, INLINE_RANGE_WIDE.max)).toBe(720)
  })
})

describe('clampPoppedVw（浮层 50–90vw）', () => {
  it('默认 50vw、界内原样', () => {
    expect(POPPED_DEFAULT_VW).toBe(50)
    expect(clampPoppedVw(50)).toBe(50)
    expect(clampPoppedVw(75)).toBe(75)
    expect(clampPoppedVw(90)).toBe(90)
  })

  it('越界钳制', () => {
    expect(clampPoppedVw(10)).toBe(POPPED_MIN_VW)
    expect(clampPoppedVw(120)).toBe(POPPED_MAX_VW)
  })
})

describe('vw↔px 换算（viewport 由宿主注入）', () => {
  it('vwToPx / pxToVw 互逆', () => {
    expect(vwToPx(50, 1280)).toBe(640)
    expect(vwToPx(90, 1000)).toBe(900)
    expect(pxToVw(640, 1280)).toBe(50)
    expect(pxToVw(900, 1000)).toBe(90)
  })

  it('非整数 px 保留浮点 vw（拖拽连续调整，不取整步进）', () => {
    expect(pxToVw(645, 1280)).toBeCloseTo(50.390625)
    expect(vwToPx(pxToVw(645, 1280), 1280)).toBeCloseTo(645)
  })
})

describe('draggedWidth（拖拽几何：side 决定拖向）', () => {
  it('left 面板（手柄在右缘）：右拖变宽、左拖变窄', () => {
    expect(draggedWidth(220, 200, 320, 'left')).toBe(340)
    expect(draggedWidth(220, 200, 150, 'left')).toBe(170)
  })

  it('right 面板（手柄在左缘）：左拖变宽、右拖变窄', () => {
    expect(draggedWidth(300, 400, 300, 'right')).toBe(400)
    expect(draggedWidth(300, 400, 450, 'right')).toBe(250)
  })
})

describe('triStateEnabled（窄屏 ≤720px 整体禁用，与 CSS breakpoint 同一语义）', () => {
  it('719 / 720 / 721 三点：720px 已进入窄屏布局，三态不得继续启用', () => {
    expect(NARROW_VIEWPORT_MAX).toBe(720)
    expect(triStateEnabled(719)).toBe(false)
    expect(triStateEnabled(720)).toBe(false) // max-width:720px 命中 → 窄屏
    expect(triStateEnabled(721)).toBe(true)
  })

  it('远离阈值两侧', () => {
    expect(triStateEnabled(1024)).toBe(true)
    expect(triStateEnabled(375)).toBe(false)
  })
})

describe('transitionGroup（组内互斥：同页至多一个 popped）', () => {
  it('弹 B 自动收回已 popped 的 A（恒至多一个 popped）', () => {
    const before = [
      { id: 'wiki/file-tree', state: 'popped' as const },
      { id: 'wiki/graph', state: 'collapsed' as const },
    ]
    expect(transitionGroup(before, 'wiki/graph', 'pop')).toEqual([
      { id: 'wiki/file-tree', state: 'inline' },
      { id: 'wiki/graph', state: 'popped' },
    ])
  })

  it('反向同样成立（镜像：弹图谱收文件树 / 弹文件树收图谱）', () => {
    const before = [
      { id: 'wiki/file-tree', state: 'collapsed' as const },
      { id: 'wiki/graph', state: 'popped' as const },
    ]
    expect(transitionGroup(before, 'wiki/file-tree', 'pop')).toEqual([
      { id: 'wiki/file-tree', state: 'popped' },
      { id: 'wiki/graph', state: 'inline' },
    ])
  })

  it('非 pop 事件与兄弟无关（collapse/expand/restore 不动他人）', () => {
    const before = [
      { id: 'a', state: 'collapsed' as const },
      { id: 'b', state: 'popped' as const },
    ]
    expect(transitionGroup(before, 'a', 'expand')).toEqual([
      { id: 'a', state: 'inline' },
      { id: 'b', state: 'popped' },
    ])
    expect(transitionGroup(before, 'b', 'restore')).toEqual([
      { id: 'a', state: 'collapsed' },
      { id: 'b', state: 'inline' },
    ])
  })

  it('非法转移幂等，且不误伤兄弟（inline 上误触 pop 不触发互斥）', () => {
    const before = [
      { id: 'a', state: 'inline' as const },
      { id: 'b', state: 'popped' as const },
    ]
    expect(transitionGroup(before, 'a', 'pop')).toEqual(before)
    expect(transitionGroup(before, 'a', 'restore')).toEqual(before)
  })

  it('成员单独成组 / 空组：不误收、不抛', () => {
    expect(transitionGroup([{ id: 'a', state: 'popped' }], 'a', 'pop')).toEqual([
      { id: 'a', state: 'popped' },
    ])
    expect(transitionGroup([], 'a', 'pop')).toEqual([])
  })

  it('三成员组：互斥后恒至多一个 popped（其余全被收回）', () => {
    const before = [
      { id: 'a', state: 'popped' as const },
      { id: 'b', state: 'popped' as const },
      { id: 'c', state: 'collapsed' as const },
    ]
    const after = transitionGroup(before, 'c', 'pop')
    expect(after.filter((m) => m.state === 'popped')).toHaveLength(1)
    expect(after.find((m) => m.id === 'c')?.state).toBe('popped')
    expect(after.find((m) => m.id === 'a')?.state).toBe('inline')
    expect(after.find((m) => m.id === 'b')?.state).toBe('inline')
  })

  it('不修改入参（纯函数）', () => {
    const before = [
      { id: 'a', state: 'popped' as const },
      { id: 'b', state: 'collapsed' as const },
    ]
    transitionGroup(before, 'b', 'pop')
    expect(before).toEqual([
      { id: 'a', state: 'popped' },
      { id: 'b', state: 'collapsed' },
    ])
  })
})

describe('POPPED_VW_RANGE（浮层宽度持久化档）', () => {
  it('与钳制常量同源（存储读出后按同一档钳制）', () => {
    expect(POPPED_VW_RANGE).toEqual({ min: POPPED_MIN_VW, max: POPPED_MAX_VW })
    expect(clampRange(120, POPPED_VW_RANGE.min, POPPED_VW_RANGE.max)).toBe(90)
  })
})
