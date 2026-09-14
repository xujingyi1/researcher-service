<script setup lang="ts">
// WikiView —— wiki 编辑页（spec §9.6 / issue #45）。
// 版面：顶部容器切换器 + 左文件树 + 中 Milkdown 编辑器 + 右图谱（可折叠）。
// 联动：点树/图谱节点 openPage；编辑器 update → store.edit（防抖自动保存落盘）；
// 顶部切换容器 → store.switchContainer（切前自动落盘）。新建/删除经 store，落盘并触发 compile。
// #668：左文件树由面板三态包装接管（inline 拖宽 / collapsed 窄条 / popped 浮层）。
// #670：右图谱接入同一套三态包装，并与文件树共用一个 panel group——同页至多一个浮层。
import { onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listInstances } from '@/api/containers'
import { getGraph } from '@/api/wiki'
import type { WikiGraphDTO } from '@/api/wiki'
import { ApiError } from '@/api/errors'
import { useWikiStore } from '@/stores/wiki'
import { useAuthStore } from '@/stores/auth'
import { INLINE_RANGE_NARROW, INLINE_RANGE_WIDE } from '@/panels/triState'
import { usePanelGroup } from '@/panels/usePanelGroup'
import { usePanelTriState } from '@/panels/usePanelTriState'
import FileTree from '@/components/FileTree.vue'
import MdEditor from '@/components/MdEditor.vue'
import WikiGraph from '@/components/WikiGraph.vue'
import PanelTriState from '@/components/PanelTriState.vue'

const store = useWikiStore()
const { current, groups, activePath, draft, dirty, saving, saveSeq } = storeToRefs(store)

// #668：文件树三态（inline 拖宽 160–560px / collapsed 窄条 / popped 浮层）。
// 宽度按用户+页面+面板落 localStorage，collapsed/popped 态不持久化。
const auth = useAuthStore()
// #670：本页三态面板组（每页一个实例，非模块级单例）——成员收到 pop 时整组重算，
// 弹一个自动收回另一个（spec #667 US25）。互斥逻辑单一实现在 usePanelGroup。
const panelGroup = usePanelGroup()
// 沿用页面原 220px 固定宽（无存储值时的默认宽度，窄屏 disabled 态同样用它）
const FILE_TREE_DEFAULT_WIDTH = 220
const filePanel = usePanelTriState({
  view: 'wiki',
  panel: 'file-tree',
  side: 'left',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: FILE_TREE_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: panelState,
  inlineWidth,
  poppedVw,
  disabled: panelDisabled,
  viewportWidth,
  onCollapse,
  onPop,
  onExpand,
  onRestore,
  onResizeInline,
  onResizePopped,
  onDragEnd,
} = filePanel

// #670：图谱三态（inline 拖宽 240–720px / collapsed 窄条 / popped 浮层），贴右边。
// 沿用页面原 320px 固定宽；与文件树同组 → 任一弹出时另一个自动收回。
const GRAPH_DEFAULT_WIDTH = 320
const graphPanel = usePanelTriState({
  view: 'wiki',
  panel: 'graph',
  side: 'right',
  inlineRange: INLINE_RANGE_WIDE,
  defaultInlineWidth: GRAPH_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: graphState,
  inlineWidth: graphInlineWidth,
  poppedVw: graphPoppedVw,
  disabled: graphDisabled,
  viewportWidth: graphViewportWidth,
  onCollapse: onGraphCollapse,
  onPop: onGraphPop,
  onExpand: onGraphExpand,
  onRestore: onGraphRestore,
  onResizeInline: onGraphResizeInline,
  onResizePopped: onGraphResizePopped,
  onDragEnd: onGraphDragEnd,
} = graphPanel

// #493: 错误二分（对齐 LoginView codex P2 惯用法）——仅「已解析的 API 错误」（信封/HTTP 语义，
// 如 20040 越权）逐字透传后端真实消息；其余（AbortError "Fetch is aborted" / TypeError "Load failed"
// 等浏览器原生网络/超时错误，非 ApiError）走本地化兜底，不把英文浏览器原文漏给用户。
function wikiErrorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback
}

const containers = ref<string[]>([])
const graph = ref<WikiGraphDTO>({ nodes: [], edges: [] })
const graphOpen = ref(true)
let graphRequestSeq = 0

async function refreshGraph(): Promise<void> {
  const requestSeq = ++graphRequestSeq
  const container = current.value
  if (!container) {
    graph.value = { nodes: [], edges: [] }
    return
  }
  try {
    const nextGraph = await getGraph(container)
    if (requestSeq === graphRequestSeq && current.value === container) {
      graph.value = nextGraph
    }
  } catch {
    if (requestSeq === graphRequestSeq && current.value === container) {
      graph.value = { nodes: [], edges: [] }
    }
  }
}

// 自动保存成功后刷新树与图谱（codex PR #62 意见6）：title/wikilink 变更即时反映。
watch(saveSeq, async () => {
  await store.loadTree(current.value)
  await refreshGraph()
})

async function selectContainer(name: string): Promise<void> {
  if (!name) return
  // 初始化/重挂载：经 resetForContainer 清掉 Pinia 残留的旧编辑器态（codex PR #62 意见3），
  // 否则旧容器 draft 会在新容器下显示/被误覆盖写。
  await store.resetForContainer(name)
  await refreshGraph()
}

async function onSwitch(name: string): Promise<void> {
  if (name === current.value) return
  try {
    await store.switchContainer(name)
    await refreshGraph()
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '容器切换失败，请重试'))
  }
}

async function onOpen(path: string): Promise<void> {
  try {
    await store.openPage(path)
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '页面打开失败，请重试'))
  }
}

function onEdit(markdown: string): void {
  store.edit(markdown)
}

async function onCreate(): Promise<void> {
  let path = ''
  try {
    const { value } = await ElMessageBox.prompt(
      '相对 wiki/main 的路径（如 concepts/foo.md）',
      '新建页面',
      { confirmButtonText: '新建', cancelButtonText: '取消', inputPattern: /\.md$/,
        inputErrorMessage: '须以 .md 结尾' },
    )
    path = (value ?? '').trim()
  } catch {
    return // 用户取消
  }
  if (!path) return
  try {
    await store.createPage(path, `---\ntitle: ${path}\n---\n\n`)
    await refreshGraph()
    await store.openPage(path)
    ElMessage.success('页面已创建')
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '页面创建失败，请重试'))
  }
}

async function onDelete(path: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除页面 ${path}？`, '删除页面',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    await store.deletePage(path)
    await refreshGraph()
    ElMessage.success('页面已删除')
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, '页面删除失败，请重试'))
  }
}

onMounted(async () => {
  try {
    const list = await listInstances()
    containers.value = list.map((i) => i.name)
    if (containers.value.length > 0) {
      await selectContainer(containers.value[0])
    }
  } catch (e) {
    ElMessage.error(wikiErrorMessage(e, 'Wiki 加载失败，请重试'))
  }
})
</script>

<template>
  <div class="wiki-view">
    <header class="wiki-header">
      <span class="brand">Wiki</span>
      <select
        data-test="container-switch"
        class="switcher"
        :value="current"
        @change="onSwitch(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
      </select>
      <span v-if="saving" class="save-state" data-test="saving">保存中…</span>
      <span v-else-if="dirty" class="save-state dirty" data-test="dirty">未保存</span>
      <span v-else class="save-state" data-test="saved">已保存</span>
      <button
        class="toggle-graph"
        data-test="toggle-graph"
        @click="graphOpen = !graphOpen"
      >
        {{ graphOpen ? '隐藏图谱' : '显示图谱' }}
      </button>
    </header>

    <div class="wiki-body">
      <PanelTriState
        :state="panelState"
        side="left"
        label="文件树"
        :disabled="panelDisabled"
        :inline-width="inlineWidth"
        :default-width="FILE_TREE_DEFAULT_WIDTH"
        :popped-vw="poppedVw"
        :viewport-width="viewportWidth"
        @collapse="onCollapse"
        @pop="onPop"
        @expand="onExpand"
        @restore="onRestore"
        @resize-inline="onResizeInline"
        @resize-popped="onResizePopped"
        @drag-end="onDragEnd"
      >
        <FileTree
          :groups="groups"
          :active-path="activePath"
          @open="onOpen"
          @create="onCreate"
          @delete="onDelete"
        />
      </PanelTriState>

      <main class="center">
        <MdEditor v-if="activePath" :content="draft" @update="onEdit" />
        <div v-else class="empty" data-test="empty">从左侧选择或新建一个页面开始编辑</div>
      </main>

      <!-- #670：图谱接入三态包装。graphOpen=false 时连包装一起不渲染（无幽灵手柄）。
           浮层态贴右缘（side="right"），拖宽/弹出后 WikiGraph 由 ResizeObserver 重新 fit。 -->
      <PanelTriState
        v-if="graphOpen"
        :state="graphState"
        side="right"
        label="图谱"
        :disabled="graphDisabled"
        :inline-width="graphInlineWidth"
        :default-width="GRAPH_DEFAULT_WIDTH"
        :popped-vw="graphPoppedVw"
        :viewport-width="graphViewportWidth"
        @collapse="onGraphCollapse"
        @pop="onGraphPop"
        @expand="onGraphExpand"
        @restore="onGraphRestore"
        @resize-inline="onGraphResizeInline"
        @resize-popped="onGraphResizePopped"
        @drag-end="onGraphDragEnd"
      >
        <WikiGraph :graph="graph" :active-path="activePath" @open="onOpen" />
      </PanelTriState>
    </div>
  </div>
</template>

<style scoped>
.wiki-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wiki-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand {
  font-weight: 600;
}
.switcher {
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
}
.save-state {
  font-size: 12px;
  color: var(--el-color-success);
}
.save-state.dirty {
  color: var(--el-color-warning);
}
.toggle-graph {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  cursor: pointer;
}
.wiki-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.center {
  flex: 1;
  /* #668：min-width:0 放开 flex 默认 min-content 下限——面板拖到 560px 时编辑区收缩
     到剩余空间而不是把 .wiki-body 顶溢出（「中间编辑区不被挤没」的实现保障）。 */
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px;
}
/* 图谱原 .right 固定宽/边框已移除：宽度与贴边边框现由 PanelTriState 三态接管
   （inline 宽度可拖、collapsed 收窄条、popped 浮层），避免双重定宽与双边框。 */
.empty {
  color: var(--el-text-color-secondary);
  padding: 40px;
  text-align: center;
}
</style>
