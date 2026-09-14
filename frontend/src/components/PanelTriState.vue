<script setup lang="ts">
// PanelTriState —— 面板三态包装哑组件（issue #668 / spec #667，CONTEXT.md「面板三态」）。
// 三种呈现态：inline（常驻可拖宽）/ collapsed（边缘窄条）/ popped（贴边全高非模态浮层）。
// props-in/emits-out：状态与宽度钳制在宿主（usePanelTriState），本组件只渲染形态并冒泡
// 事件——拖拽经纯函数 draggedWidth 换算原始几何值 emit，宿主钳制后回灌 props。
// popped 非模态：无遮罩、不因点击外部关闭，仅显式收回按钮（restore）关闭。
// 窄屏 disabled：宿主经 triStateEnabled 判定后传入，渲染为无控件的常驻面板（保持现有响应式布局）。
import { computed, onUnmounted } from 'vue'
import { draggedWidth, vwToPx } from '@/panels/triState'
import type { PanelSide, PanelState } from '@/panels/triState'

const props = withDefaults(defineProps<{
  state: PanelState
  /** 面板贴边侧：left（手柄在右缘）| right（手柄在左缘） */
  side?: PanelSide
  /** 窄屏 (<720px) 由宿主判定传入：三态整体禁用 */
  disabled?: boolean
  /** aria 文案用面板名 */
  label?: string
  /** inline 态宽度（宿主钳制后的 px） */
  inlineWidth: number
  /** disabled 态回退宽度（窄屏保持现有固定宽布局） */
  defaultWidth: number
  /** popped 态宽度（vw 数值，50 = 50vw） */
  poppedVw: number
  /** 视口宽（宿主注入）：popped 拖拽 px↔vw 换算用 */
  viewportWidth: number
}>(), { side: 'left', disabled: false, label: '面板' })

const emit = defineEmits<{
  collapse: []
  pop: []
  expand: []
  restore: []
  /** inline 手柄拖拽中的原始宽度（px，未钳制） */
  'resize-inline': [widthPx: number]
  /** popped 手柄拖拽中的原始宽度（px，未换算未钳制） */
  'resize-popped': [widthPx: number]
  /** 一次拖拽结束（宿主据此做 inline 宽度持久化） */
  'drag-end': []
}>()

// 拖拽监听挂 window：指针移出手柄也不丢事件。起始宽度 inline 取 props，popped 经注入的
// 视口宽换算 px——组件自己不摸 DOM 度量。
let drag: { kind: 'inline' | 'popped'; startX: number; startWidth: number } | null = null

function onPointerMove(e: PointerEvent): void {
  if (!drag) return
  const width = draggedWidth(drag.startWidth, drag.startX, e.clientX, props.side)
  if (drag.kind === 'inline') emit('resize-inline', width)
  else emit('resize-popped', width)
}

function onPointerUp(): void {
  drag = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  emit('drag-end')
}

function startDrag(kind: 'inline' | 'popped', e: PointerEvent): void {
  if (props.disabled) return
  e.preventDefault()
  const startWidth = kind === 'inline' ? props.inlineWidth : vwToPx(props.poppedVw, props.viewportWidth)
  drag = { kind, startX: e.clientX, startWidth }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  // 触控被打断（来电/手势接管）时 pointercancel 收尾，避免 drag 句柄与 window 监听残留
  window.addEventListener('pointercancel', onPointerUp)
}

onUnmounted(() => {
  if (drag) onPointerUp()
})

// 箭头方向随贴边侧镜像：left 面板折叠朝左 «、展开/收回朝右 »；right 面板相反。
const arrows = computed(() => props.side === 'left'
  ? { collapse: '«', expand: '»', restore: '»' }
  : { collapse: '»', expand: '«', restore: '«' })
</script>

<template>
  <!-- 窄屏：无手柄无按钮，保持现有响应式布局。仍带 data-side——窄屏同样贴边，
       贴边边框由 [data-side] 规则给（面板自身不再各自写边框）。
       宽度走自定义属性而非内联 width：窄屏下宽度属于页面响应式布局（如 chat 页整列铺满），
       宿主媒体查询需能覆盖它——内联样式会把它钉死。 -->
  <aside
    v-if="disabled"
    data-test="panel"
    data-state="disabled"
    class="panel plain"
    :data-side="side"
    :style="{ '--panel-default-width': `${defaultWidth}px` }"
  >
    <div class="panel-body" data-test="panel-body"><slot /></div>
  </aside>

  <aside
    v-else-if="state === 'inline'"
    data-test="panel"
    data-state="inline"
    class="panel inline"
    :data-side="side"
    :style="{ width: `${inlineWidth}px` }"
  >
    <div class="panel-body" data-test="panel-body"><slot /></div>
    <button
      type="button"
      class="edge-btn collapse-btn"
      data-test="collapse-btn"
      :aria-label="`折叠${label}`"
      :title="`折叠${label}`"
      @click="emit('collapse')"
    >{{ arrows.collapse }}</button>
    <span
      class="drag-handle"
      data-test="drag-handle"
      role="separator"
      aria-orientation="vertical"
      :aria-label="`调整${label}宽度`"
      tabindex="0"
      @pointerdown="startDrag('inline', $event)"
    />
  </aside>

  <aside
    v-else-if="state === 'collapsed'"
    data-test="panel"
    data-state="collapsed"
    class="panel rail-panel"
    :data-side="side"
  >
    <button
      type="button"
      class="edge-btn expand-btn"
      data-test="expand-btn"
      :aria-label="`展开${label}`"
      :title="`展开${label}`"
      @click="emit('expand')"
    >{{ arrows.expand }}</button>
    <button
      type="button"
      class="rail"
      data-test="rail"
      :aria-label="`弹出${label}`"
      :title="`弹出${label}`"
      @click="emit('pop')"
    ><span class="rail-label">{{ label }}</span></button>
  </aside>

  <aside
    v-else
    data-test="panel"
    data-state="popped"
    class="panel popped"
    :data-side="side"
    :style="{ width: `${poppedVw}vw` }"
  >
    <div class="panel-body" data-test="panel-body"><slot /></div>
    <button
      type="button"
      class="edge-btn restore-btn"
      data-test="restore-btn"
      :aria-label="`收回${label}`"
      :title="`收回${label}`"
      @click="emit('restore')"
    >{{ arrows.restore }}</button>
    <span
      class="drag-handle"
      data-test="pop-handle"
      role="separator"
      aria-orientation="vertical"
      :aria-label="`调整${label}浮层宽度`"
      tabindex="0"
      @pointerdown="startDrag('popped', $event)"
    />
  </aside>
</template>

<style scoped>
.panel {
  position: relative;
  background: var(--el-bg-color);
}
.panel-body {
  height: 100%;
  overflow: hidden;
}
.panel.inline {
  flex: none;
  overflow: hidden;
}
/* 窄屏禁用态：无控件的常驻块，宽度取自宿主注入的默认值（CSS 变量，可被页面媒体查询覆盖）。 */
.panel.plain {
  flex: none;
  overflow: hidden;
  width: var(--panel-default-width);
}
[data-side='left'] {
  border-right: 1px solid var(--el-border-color);
}
[data-side='right'] {
  border-left: 1px solid var(--el-border-color);
}

/* 拖拽手柄：贴缘窄热区（left 面板骑右缘，right 镜像），focus-visible 基线照 FileTree */
.drag-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  touch-action: none;
  z-index: 5;
}
[data-side='left'] .drag-handle {
  right: -3px;
}
[data-side='right'] .drag-handle {
  left: -3px;
}
.drag-handle:hover,
.drag-handle:focus-visible {
  background: var(--el-color-primary-light-7);
}
.drag-handle:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -2px;
}

/* 折叠/展开/收回小钮：贴缘顶部小圆钮，默认半透明不抢内容注意力 */
.edge-btn {
  position: absolute;
  top: 6px;
  z-index: 6;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 50%;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: .55;
}
.edge-btn:hover,
.edge-btn:focus-visible {
  opacity: 1;
  color: var(--el-color-primary);
}
.edge-btn:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: 1px;
}
[data-side='left'] .edge-btn {
  right: 8px;
}
[data-side='right'] .edge-btn {
  left: 8px;
}

/* collapsed 边缘窄条：顶部展开小钮 + 下方整条可点（点击弹出） */
.rail-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 32px;
  flex: none;
}
.rail-panel .edge-btn {
  position: static;
  margin: 6px 6px 2px;
}
.rail {
  flex: 1;
  min-height: 0;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  padding: 8px 0;
}
.rail:hover,
.rail:focus-visible {
  color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}
.rail:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -2px;
}
.rail-label {
  writing-mode: vertical-rl;
  font-size: 12px;
  letter-spacing: 2px;
  user-select: none;
}

/* popped 贴边全高非模态浮层：fixed 显式贴缘（不靠 static 位置兜底，right 面板复用不错位）、
   阴影浮起；无遮罩，外部内容可交互 */
.panel.popped {
  position: fixed;
  top: 0;
  bottom: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  box-shadow: 0 0 24px rgba(0, 0, 0, .18);
}
.panel.popped[data-side='left'] {
  left: 0;
}
.panel.popped[data-side='right'] {
  right: 0;
}
.panel.popped .panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
