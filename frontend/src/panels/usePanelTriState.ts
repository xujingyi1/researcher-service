// usePanelTriState —— 面板三态包装 composable（issue #668 / spec #667）。
// 宿主侧胶水：持有三态 refs，把哑组件冒泡的事件经纯函数（triState 状态机/钳制、
// panelWidth 持久化）落成状态更新；storage / viewport / token 由 options 注入
// （jsdom 无布局——DOM 度量一律注入）。四个面板复用同一套。
// 可选 group 注入（spec #667 US25）：同页多面板共享一个 usePanelGroup，弹 B 自动收 A。
// 持久化（spec #667 US16 + US26）：inline 宽度与 popped 宽度各存独立 key；collapsed/popped
// 态本身不持久化，每次进页恒 inline。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import {
  clampPoppedVw,
  clampRange,
  POPPED_DEFAULT_VW,
  POPPED_VW_RANGE,
  pxToVw,
  transitionPanelState,
  triStateEnabled,
} from '@/panels/triState'
import type { PanelEvent, PanelSide, PanelState, WidthRange } from '@/panels/triState'
import {
  loadPanelWidth,
  panelPoppedWidthKey,
  panelWidthKey,
  savePanelWidth,
} from '@/panels/panelWidth'
import type { PanelGroup } from '@/panels/usePanelGroup'
import { tokenOwner } from '@/stores/auth'
import { safeLocalStorage } from '@/storage'

export interface PanelTriStateOptions {
  /** 持久化 key 的页面段（如 'wiki' / 'chat'） */
  view: string
  /** 持久化 key 的面板段（如 'file-tree' / 'graph'） */
  panel: string
  /** 面板贴边侧，默认 left */
  side?: PanelSide
  /** inline 宽度硬边界（spec #667 两档：160–560 / 240–720，见 triState 常量） */
  inlineRange: WidthRange
  /** storage 无值时的默认宽度（该面板现状固定宽） */
  defaultInlineWidth: number
  /** access token 供给者（解析出按用户隔离的 key owner，chat 草稿先例） */
  token: () => string
  /** Storage 供给者，默认 safeLocalStorage()（隐私模式兜底） */
  storage?: () => Storage | null
  /** 视口宽供给者，默认 window.innerWidth（窄屏判定 + popped px↔vw 换算） */
  getViewportWidth?: () => number
  /** 同页面板组（同一页面各三态面板传同一个实例）：同页至多一个 popped。不传＝单面板。 */
  group?: PanelGroup
}

export function usePanelTriState(options: PanelTriStateOptions) {
  const storage = options.storage ?? safeLocalStorage
  const getViewportWidth = options.getViewportWidth ?? (() => window.innerWidth)
  const side: PanelSide = options.side ?? 'left'
  const { min, max } = options.inlineRange

  // key 在挂载时按当前身份算一次（refresh 换 token 不改 sub，owner 稳定）。
  const owner = tokenOwner(options.token())
  const key = panelWidthKey(owner, options.view, options.panel)
  const poppedKey = panelPoppedWidthKey(owner, options.view, options.panel)

  const state = ref<PanelState>('inline') // collapsed/popped 不持久化：每次进页恒 inline
  const inlineWidth = ref(loadPanelWidth(storage(), key, options.inlineRange) ?? options.defaultInlineWidth)
  const poppedVw = ref(loadPanelWidth(storage(), poppedKey, POPPED_VW_RANGE) ?? POPPED_DEFAULT_VW)

  const viewportWidth = ref(getViewportWidth())
  const disabled = computed(() => !triStateEnabled(viewportWidth.value))

  function syncViewport(): void {
    viewportWidth.value = getViewportWidth()
  }
  onMounted(() => window.addEventListener('resize', syncViewport))
  onUnmounted(() => window.removeEventListener('resize', syncViewport))

  // 组内成员身份（组按页创建，故 view 段冗余但无害——防同页同名面板相撞）。
  const memberId = `${options.view}/${options.panel}`
  const unregister = options.group?.register(memberId, () => state.value, (next) => {
    state.value = next
  })
  onUnmounted(() => unregister?.())

  // 三态事件统一出口：有组则经组协调（同页互斥纯函数）+ 组内广播落回各成员；
  // 无组则本实例自行按转移表迁移。两条路径共用同一转移表，语义不分叉。
  function dispatch(event: PanelEvent): void {
    if (options.group) options.group.apply(memberId, event)
    else state.value = transitionPanelState(state.value, event)
  }

  function onCollapse(): void {
    dispatch('collapse')
  }
  function onPop(): void {
    dispatch('pop')
  }
  function onExpand(): void {
    dispatch('expand')
  }
  function onRestore(): void {
    dispatch('restore')
  }

  function onResizeInline(widthPx: number): void {
    inlineWidth.value = clampRange(widthPx, min, max)
  }
  function onResizePopped(widthPx: number): void {
    poppedVw.value = clampPoppedVw(pxToVw(widthPx, viewportWidth.value))
  }
  function onDragEnd(): void {
    // 宽度按当前形态落各自 key（spec #667 US16/US26：两种宽度都被记住）；
    // 形态本身（collapsed/popped）从不落盘——每次进页恒 inline。
    if (state.value === 'inline') savePanelWidth(storage(), key, inlineWidth.value)
    else if (state.value === 'popped') savePanelWidth(storage(), poppedKey, poppedVw.value)
  }

  return {
    state: state as Ref<PanelState>,
    inlineWidth,
    poppedVw,
    disabled,
    viewportWidth,
    side,
    onCollapse,
    onPop,
    onExpand,
    onRestore,
    onResizeInline,
    onResizePopped,
    onDragEnd,
  }
}
