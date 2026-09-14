<script setup lang="ts">
// 消息流（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// ADR 0014：审批卡不再进时间线（resolved/expired 不留痕；pending/resolving 在 composer 上方
// ApprovalDock）——本组件回归纯消息流渲染，不再合并 approvals、不再合成 SyntheticAnchor。
// ADR 0009 / #400：窗口自动向下滚动（范式 B 上滚让位 + rAF 节流）——宿主在本组件内部，
// 滚动容器即根元素 .stream；仅用户停留底部时跟随，上滚不抢滚动条，回到底部恢复；一帧内多次
// 流式 delta 合并滚一次（rAF 节流，平滑不抖动）。渲染 messages（ChatMessageItem 注入 msg-item/
// thinking/tool-line slot）+ 历史分页「加载更多」。thinking+回答保持同气泡、工具行挂 run（不扁平化）。
// 消息锚点导航（issue #669 / #667 spec）：滚动几何纯函数（chat/anchorNav.ts）+ 本宿主 DOM 度量
// 注入——筛选 user 锚点/摘要、读消息元素 offsetTop 算刻度比例、scroll 事件更新 scrollspy 指示器、
// 点击跳转（程序性滚动，经 scroll 事件自然落范式 B 语义）+ 目标消息高亮渐隐。
// #667 收口：几何在「容器尺寸变化」（面板拖宽/折叠/弹出、窗口 resize）时同样要重测——见下方
// ResizeObserver（仅 onUpdated/onMounted 会漏掉不改 messages 的纯尺寸变化）。
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import type { Msg } from '@/stores/chat'
import { shouldFollowBottom } from '@/chat/scroll'
import { activeAnchorIndex, anchorRatios, anchorSummary, selectUserAnchorIndices, viewportRatio } from '@/chat/anchorNav'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import AnchorRail from '@/components/chat/AnchorRail.vue'

// props 供 script 侧 watch 追踪布局快照（模板按名访问，无需此绑定）
const props = defineProps<{
  messages: Msg[]
  historyHasMore: boolean
  historyLoading: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  regenerate: [text: string]
  toggleTraceFold: [msg: Msg] // T1 轮次折叠（#664）：折叠条开合转发（携带所属消息，父层落 store）
}>()

function previousUserText(message: Msg): string {
  const index = props.messages.indexOf(message)
  for (let i = index - 1; i >= 0; i--) {
    const candidate = props.messages[i]
    if (candidate.role !== 'user') continue
    // 现有前端只能重发文本，无法从历史 Msg 安全重建原始附件；含附件时不显示入口，
    // 避免“重新生成”静默退化为只发送文字。
    return candidate.media.length === 0 ? candidate.text : ''
  }
  return ''
}

// ---- 自动滚动（ADR 0009 / #400，范式 B 上滚让位 + rAF 节流）----
// 滚动容器即根元素 .stream（overflow-y:auto）。stickyBottom 记录「用户是否停留在底部」：
// 由 scroll 事件实时判定；上滚离开底部 → false（新内容不抢滚动条），回到底部 → true（恢复跟随）。
const streamEl = ref<HTMLElement | null>(null)
const stickyBottom = ref(true)
const hasNewContent = ref(false)
const indicator = ref(1) // 锚点导航 scrollspy 指示器比例（初始 1 = 首连自动滚底）
let rafId = 0

// 滚动判定（范式 B）：距底 < 阈值视为停留底部。scroll 事件驱动——用户滚动操作与
// 程序性滚动（跟随触底/锚点跳转）都经过这里；跟随触底时距底=0 保持 stickyBottom=true 不抖动。
// 锚点导航 scrollspy：同一事件更新指示器比例。
function onScroll(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = shouldFollowBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
  indicator.value = viewportRatio(el.scrollTop, el.scrollHeight, el.clientHeight)
  if (stickyBottom.value) hasNewContent.value = false
}

// rAF 节流跟随：一帧内多次流式 delta 合并滚一次到底（平滑不抖动）。
// 仅 stickyBottom（用户停留底部）时滚；上滚回看历史时不抢滚动条。
function scrollToBottom(): void {
  if (!stickyBottom.value) return
  if (rafId) return // 本帧已调度
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const el = streamEl.value
    if (el && stickyBottom.value) el.scrollTop = el.scrollHeight
  })
}

function onTimelineContentChanged(): void {
  if (!stickyBottom.value) {
    hasNewContent.value = true
    return
  }
  scrollToBottom()
}

function jumpToBottom(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = true
  hasNewContent.value = false
  el.scrollTop = el.scrollHeight
}

// ---- 消息锚点导航（issue #669 / #667 spec）----
// 几何判定在 chat/anchorNav.ts 纯函数层；本宿主负责 DOM 度量注入（消息元素 offsetTop +
// 容器 scrollHeight/clientHeight）与交互（跳转/高亮）。锚点按消息数组下标锚定（与渲染 key
// 策略一致）；切会话/切容器 messages 清空 → 锚点清空、轨消失（重置语义）。
const anchorPoints = computed(() =>
  selectUserAnchorIndices(props.messages).map((index) => ({
    index,
    summary: anchorSummary(props.messages[index]),
  })),
)
const ratios = ref<number[]>([])
const railHeight = ref(0) // 滚动容器视口高（宿主度量注入 AnchorRail——sticky 0 高占位包含块不可用 %）
const scrollable = ref(false) // 内容可滚（scrollHeight > clientHeight）——不可滚时导航无意义，轨隐藏
const activeAnchor = computed(() => activeAnchorIndex(ratios.value, indicator.value))
const railVisible = computed(() => scrollable.value && anchorPoints.value.length > 0)
// 度量结果（ratios 平行数组）并入锚点后再注入哑组件（ratio 0 兜底：首测前的初始渲染）
const railAnchors = computed(() =>
  anchorPoints.value.map((a, i) => ({ ...a, ratio: ratios.value[i] ?? 0 })),
)

// DOM 度量：锚点消息元素 offsetTop → 刻度比例。onUpdated/onMounted 驱动（流式 delta 原地
// mutation 不触发 onUpdated，不重复度量；新消息/加载更多/prepend 触发的组件更新自然重测）。
function measureAnchors(): void {
  const el = streamEl.value
  if (el) {
    scrollable.value = el.scrollHeight > el.clientHeight
    if (el.clientHeight !== railHeight.value) railHeight.value = el.clientHeight
  }
  const next = !el || anchorPoints.value.length === 0
    ? []
    : anchorRatios(
        anchorPoints.value.map((a) => {
          const node = el.querySelector(`[data-index="${a.index}"]`)
          return node instanceof HTMLElement ? node.offsetTop : 0
        }),
        el.scrollHeight,
        el.clientHeight,
      )
  // 值级比较：不变则不替换引用——onUpdated 中赋值会自触发重渲染（递归更新死循环）
  if (next.length === ratios.value.length && next.every((v, i) => v === ratios.value[i])) return
  ratios.value = next
}
// #667 收口：面板三态（拖宽/折叠/弹出）改的是 .stream 的盒子——宽度变则消息换行重排、
// offsetTop 全变，高度变则 railHeight 与「可滚」判定变；而这两件事都不经 messages 快照，
// onUpdated/layoutWatch 都不触发（流式 delta 原地 mutation 同理）。故用 ResizeObserver 盯
// .stream 盒子，尺寸变化即重测。轨自身 sticky + height:0 不占流，重测不会反向改变盒子尺寸
// （无 ResizeObserver 回环）。
let resizeObserver: ResizeObserver | null = null

function observeResize(): void {
  // jsdom 无 ResizeObserver（真浏览器恒有）：缺席时跳过观察，滚动/滚动spy 语义不变。
  if (typeof ResizeObserver === 'undefined' || !streamEl.value) return
  resizeObserver = new ResizeObserver(() => measureAnchors())
  resizeObserver.observe(streamEl.value)
}

onMounted(() => {
  measureAnchors()
  observeResize()
})
// 底部时布局更新后校正滚底（非时间线更新如断线态不制造“有新消息”）；同时重测锚点几何。
onUpdated(() => {
  if (stickyBottom.value) scrollToBottom()
  measureAnchors()
})

// 点击刻度跳转：程序性滚动定位到目标消息，经 scroll 事件自然落范式 B 语义（跳到中部即上滚
// 让位、流式新内容不抢滚动条；跳到底部附近则继续跟随）——不 hack stickyBottom。
function jumpToAnchor(msgIndex: number): void {
  const el = streamEl.value
  if (!el) return
  const node = el.querySelector(`[data-index="${msgIndex}"]`)
  if (!(node instanceof HTMLElement)) return
  el.scrollTop = node.offsetTop
  flashAnchor(msgIndex)
}

// 目标消息高亮渐隐（1.6s 动画 + 定时落定清除）；重复点击重置定时器。
const flashIndex = ref<number | null>(null)
let flashTimer = 0
function flashAnchor(msgIndex: number): void {
  flashIndex.value = msgIndex
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    flashIndex.value = null
    flashTimer = 0
  }, 1600)
}
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer)
})

// DOM 更新后（新消息/历史加载更多 prepend）跟随。onUpdated 只对「本组件 render effect
// 失效」触发——流式 delta 是 useChatConnection 对消息对象**原地 mutation**（last.raw/text 就地改，
// 数组与对象身份不变），本组件渲染不读 text/thinking，render effect 不失效，onUpdated 不触发，
// 流式逐字追加会漏滚（#400 验收①第三场景，code-review 实证）。故补 layoutWatch：投影快照
// 只追踪「渲染布局相关字段」（role/streaming/raw 决定气泡高度），detailOpen/tools 等不属布局
// 变化、天然不进快照——不因 deep watch 被破坏。watch 回调统一走 scrollToBottom（rAF 节流）。
watch(
  () => props.messages.map((m) => `${m.role}|${m.streaming}|${m.raw.length}`).join('|'),
  onTimelineContentChanged,
)
onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  resizeObserver = null
})

defineSlots<{
  // 覆盖 msg-item 者须自行在根元素透传 data-index（锚点度量锚定标记）；anchor-flash 同理
  // （跳转高亮）。不透传则锚点比例退化 0、高亮失效——当前唯一使用方 ChatView 未覆盖。
  'msg-item'?: (props: { msg: Msg }) => unknown
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
  empty?: (props: {}) => unknown
}>()
</script>

<template>
  <!-- ADR 0009 / #400：.stream 即滚动容器（根元素，overflow-y:auto）——ref 供范式 B 跟随滚底，
       @scroll 实时判定 stickyBottom（用户停留底部则跟随、上滚则让位） -->
  <div class="stream" data-test="stream" ref="streamEl" role="log" aria-live="polite" aria-label="对话消息" @scroll="onScroll">
    <!-- 消息锚点导航（#669）：挂在 stream 滚动容器内右缘。必须位于内容最前——sticky top:0
         只能钉住「随内容流经视口顶」的元素，放内容末尾则滚到接近底部才出现（spec 轴评审实测）；
         anchors/active/高度由本宿主度量注入 -->
    <AnchorRail v-if="railVisible" :anchors="railAnchors" :active-index="activeAnchor" :rail-height="railHeight" @jump="jumpToAnchor" />
    <!-- T3 历史分页（issue #82）：hasMore 时顶部「加载更多」向回翻更旧消息，prepend 到头部。 -->
    <button
      v-if="historyHasMore"
      class="load-more"
      :disabled="historyLoading"
      data-test="load-more"
      @click="emit('loadMore')"
    >
      {{ historyLoading ? '加载中…' : '加载更多' }}
    </button>
    <!-- msg-item slot：父注入消息表现（默认 ChatMessageItem）；thinking/tool-line 透传给叶子。
         data-index/anchor-flash 经 attrs fallthrough 落消息根元素——锚点度量与高亮的锚定标记 -->
    <template v-for="(m, i) in messages" :key="`m-${i}`">
      <slot name="msg-item" :msg="m">
        <ChatMessageItem
          :msg="m"
          :data-index="i"
          :class="{ 'anchor-flash': i === flashIndex }"
          :regenerate-text="m.role === 'assistant' ? previousUserText(m) : ''"
          @regenerate="emit('regenerate', $event)"
          @toggle-trace-fold="emit('toggleTraceFold', m)"
        />
      </slot>
    </template>
    <slot name="empty" />
    <button v-if="!stickyBottom" class="jump-bottom" data-test="jump-bottom" @click="jumpToBottom">
      {{ hasNewContent ? '有新消息 · 回到底部' : '回到底部' }}
    </button>
  </div>
</template>

<style scoped>
/* position:relative：消息元素 offsetTop 的 offsetParent 锚定到 .stream（锚点度量语义：相对
   滚动文档顶部的布局位置）；不影响 sticky 的 jump-bottom（相对滚动祖先定位） */
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; position: relative; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
.jump-bottom { position: sticky; bottom: 4px; align-self: center; border: 1px solid var(--el-border-color); border-radius: 18px; padding: 7px 14px; background: var(--el-bg-color-overlay); color: var(--el-color-primary); box-shadow: var(--el-box-shadow-light); cursor: pointer; z-index: 2; }
/* 锚点跳转高亮（#669）：目标消息亮起后 1.6s 渐隐（动画结束态透明，class 由定时器移除） */
.stream :deep(.anchor-flash) { animation: anchor-flash 1.6s ease-out forwards; border-radius: 10px; }
@keyframes anchor-flash {
  0% { background: var(--el-color-primary-light-8); box-shadow: 0 0 0 6px var(--el-color-primary-light-8); }
  55% { background: var(--el-color-primary-light-8); box-shadow: 0 0 0 6px var(--el-color-primary-light-8); }
  100% { background: transparent; box-shadow: 0 0 0 6px transparent; }
}
</style>
