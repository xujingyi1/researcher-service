<script setup lang="ts">
// 左栏：容器 + 会话列表 / workspace 文件树（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// #626 T1（变体 A）：顶部「会话｜文件」胶囊分段控制左栏内容切换（#671 后不变）。
// #671：宽度不再由本组件固定（原 220px）——由宿主 ChatView 的 PanelTriState 三态包装接管，
// 默认宽度仍是 220px，避免包装与本组件双重定宽。
// sessions 分支=容器+会话列表（原有逻辑）；files 分支=WorkspaceTree（数据由父注入，点击冒泡 openFile）。
import type { InstanceDTO } from '@/api/containers'
import type { SessionDTO } from '@/chat/gatewayChat'
import type { DirListing } from '@/api/files'
import { computed, ref } from 'vue'
import WorkspaceTree from '@/components/chat/WorkspaceTree.vue'

type SideTab = 'sessions' | 'files'

const props = withDefaults(
  defineProps<{
    instances: InstanceDTO[]
    sessions: SessionDTO[]
    selectedContainer: string
    selectedSession: string
    sidebarTab?: SideTab
    tree?: DirListing | null
    treeError?: string | null
    activeFilePath?: string
  }>(),
  { sidebarTab: 'sessions', tree: null, treeError: null, activeFilePath: '' },
)

const emit = defineEmits<{
  selectContainer: [name: string]
  selectSession: [key: string]
  removeSession: [key: string]
  newSession: []
  switchTab: [tab: SideTab]
  openFile: [path: string]
}>()

defineSlots<{
  'empty'?: (props: {}) => unknown
}>()

function sessionTitle(s: SessionDTO): string {
  return s.title || s.session_key.slice(0, 8)
}
const query = ref('')
const groupedSessions = computed(() => {
  const q = query.value.trim().toLowerCase()
  const groups = new Map<string, SessionDTO[]>()
  for (const s of props.sessions.filter((item) => !q || sessionTitle(item).toLowerCase().includes(q) || item.session_key.toLowerCase().includes(q))) {
    const time = Date.parse(s.updated_at)
    const days = Number.isFinite(time) ? (Date.now() - time) / 86_400_000 : Infinity
    const label = days < 1 ? '今天' : days < 7 ? '最近 7 天' : '更早'
    groups.set(label, [...(groups.get(label) ?? []), s])
  }
  return [...groups.entries()]
})
</script>

<template>
  <aside class="side">
    <div class="seg" role="tablist" data-test="side-seg">
      <button type="button" role="tab" :class="{ on: sidebarTab === 'sessions' }" :aria-selected="sidebarTab === 'sessions'" data-test="side-tab-sessions" @click="emit('switchTab', 'sessions')">会话</button>
      <button type="button" role="tab" :class="{ on: sidebarTab === 'files' }" :aria-selected="sidebarTab === 'files'" data-test="side-tab-files" @click="emit('switchTab', 'files')">文件</button>
    </div>
    <div v-show="sidebarTab === 'sessions'" class="pane">
      <h3>容器</h3>
      <ul class="list">
        <li v-for="inst in instances" :key="inst.name">
          <button
            type="button"
            :class="['pill', { active: inst.name === selectedContainer }]"
            :aria-current="inst.name === selectedContainer ? 'true' : undefined"
            :data-test="`container-${inst.name}`"
            @click="emit('selectContainer', inst.name)"
          >
            <span class="dot" :class="{ off: inst.status !== 'running' }"></span>{{ inst.name }}
          </button>
        </li>
      </ul>
      <h3>会话</h3>
      <input v-model="query" class="search" type="search" placeholder="搜索会话" aria-label="搜索会话">
      <ul class="list">
        <template v-for="([label, group]) in groupedSessions" :key="label">
        <li class="group-label">{{ label }}</li>
        <li v-for="s in group" :key="s.session_key" class="sess-row">
          <button
            type="button"
            :class="['sess', { active: s.session_key === selectedSession }]"
            :aria-current="s.session_key === selectedSession ? 'true' : undefined"
            :data-test="`session-${s.session_key}`"
            @click="emit('selectSession', s.session_key)"
          >
            <span class="sess-title">{{ sessionTitle(s) }}</span>
          </button>
          <button
            type="button"
            class="sess-del"
            title="删除会话"
            :data-test="`delete-session-${s.session_key}`"
            @click="emit('removeSession', s.session_key)"
          >✕</button>
        </li>
        </template>
        <slot name="empty" />
      </ul>
      <button class="ghost" data-test="new-session" @click="emit('newSession')">＋ 新会话</button>
    </div>
    <div v-show="sidebarTab === 'files'" class="pane pane-files">
      <WorkspaceTree
        :tree="tree ?? null"
        :tree-error="treeError ?? null"
        :active-path="activeFilePath"
        @open="emit('openFile', $event)"
      />
    </div>
  </aside>
</template>

<style scoped>
/* #671：自身定宽与贴边边框已移除——宽度与边框由 PanelTriState 三态包装接管
   （inline 可拖宽 / collapsed 窄条 / popped 浮层），本组件只填满包装给的盒子。
   height:100% + overflow-y:auto 与 FileTree 同构：在包装的 panel-body 内自行滚动。 */
.side { height: 100%; padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; }
.seg { display: flex; background: var(--el-fill-color-light); border-radius: 9px; padding: 3px; margin-bottom: 10px; flex: none; }
.seg button { flex: 1; border: none; border-radius: 7px; padding: 5px 0; background: transparent; color: var(--el-text-color-secondary); font-size: 13px; cursor: pointer; }
.seg button.on { background: var(--el-bg-color); color: var(--el-text-color-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .12); }
.pane { flex: 1; min-height: 0; }
.pane-files { display: flex; flex-direction: column; }
.side h3 { font-size: 12px; color: var(--el-text-color-secondary); text-transform: uppercase; margin: 8px 0 4px; }
.search { width: 100%; box-sizing: border-box; border: 1px solid var(--el-border-color); border-radius: 7px; padding: 7px 9px; margin-bottom: 5px; background: var(--el-bg-color); color: inherit; }
.group-label { padding: 7px 10px 2px; color: var(--el-text-color-placeholder); font-size: 11px; }
.list { list-style: none; padding: 0; margin: 0; }
.pill, .sess { width: 100%; padding: 7px 10px; border: none; border-radius: 7px; cursor: pointer; color: var(--el-text-color-regular); font: inherit; text-align: left; }
.pill { display: flex; align-items: center; gap: 8px; background: var(--el-fill-color-light); margin-bottom: 4px; }
.sess-row { display: flex; align-items: center; }
.sess { min-width: 0; font-size: 13px; color: var(--el-text-color-secondary); display: flex; align-items: center; gap: 6px; background: transparent; }
.sess .sess-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-del { flex: none; background: transparent; border: none; color: var(--el-text-color-placeholder); cursor: pointer; font-size: 12px; padding: 4px; border-radius: 4px; }
.sess-del:hover { color: var(--el-color-danger); }
.pill.active, .sess.active { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.pill:focus-visible, .sess:focus-visible, .sess-del:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-success); }
.dot.off { background: var(--el-text-color-disabled); }
.ghost { width: 100%; margin-top: 8px; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px; cursor: pointer; color: var(--el-text-color-secondary); }
</style>
