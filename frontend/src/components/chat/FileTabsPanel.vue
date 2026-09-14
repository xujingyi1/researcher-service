<script setup lang="ts">
// FileTabsPanel —— 右面板壳（#626 T1 / #618 规格 §2，变体 A：横排 tab 条 + 骨架/全文）。
// 哑组件：横排 tab 条（basename + ×）+ 全关按钮 + 内嵌 FileViewer 渲染 active tab。
// #672：宽度与贴边边框改由宿主 ChatView 的 PanelTriState 三态包装接管（原 360px 定宽 + 自身
// border-left 会产生双重定宽/双边框），本组件只占满包装给的盒子。tab 关闭 × 用 @click.stop 不触发 activate。
import { computed } from 'vue'
import type { FileTab } from '@/stores/fileTabs'
import FileViewer from '@/components/chat/FileViewer.vue'

const props = defineProps<{ tabs: FileTab[]; activePath: string | null }>()
const emit = defineEmits<{
  activate: [path: string]
  close: [path: string]
  closeAll: []
  retry: [path: string] // #628 T3：FileViewer error 重试 → 上浮 active tab path
}>()

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

const activeTab = computed(() => props.tabs.find((t) => t.path === props.activePath) ?? null)
</script>

<template>
  <section class="panel" data-test="file-tabs-panel">
    <div class="strip">
      <div
        v-for="t in tabs"
        :key="t.path"
        class="tab"
        :class="{ active: t.path === activePath }"
        :data-test="`tab-${t.path}`"
        :title="t.path"
        @click="emit('activate', t.path)"
      >
        <span class="tab-name">{{ basename(t.path) }}</span>
        <button
          type="button"
          class="x"
          :data-test="`tab-close-${t.path}`"
          title="关闭"
          @click.stop="emit('close', t.path)"
        >×</button>
      </div>
      <button
        v-if="tabs.length"
        type="button"
        class="closeall"
        data-test="tabs-closeall"
        @click="emit('closeAll')"
      >全部关闭</button>
    </div>
    <div class="pbody">
      <FileViewer v-if="activeTab" :tab="activeTab" @retry="emit('retry', $event)" />
    </div>
  </section>
</template>

<style scoped>
/* 贴边左边框由三态包装的 [data-side='right'] 规则给，此处不再自画（避免双边框）。 */
.panel { height: 100%; display: flex; flex-direction: column; min-width: 0; background: var(--el-bg-color); }
.strip { display: flex; align-items: center; border-bottom: 1px solid var(--el-border-color); overflow-x: auto; flex: none; }
.tab { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-right: 1px solid var(--el-border-color); font-size: 12.5px; color: var(--el-text-color-secondary); white-space: nowrap; cursor: pointer; user-select: none; }
.tab:hover { background: var(--el-fill-color-light); }
.tab.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); box-shadow: inset 0 -2px 0 var(--el-color-primary); }
.tab-name { overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.x { border: none; background: transparent; color: var(--el-text-color-placeholder); padding: 0 2px; border-radius: 4px; font-size: 14px; line-height: 1; cursor: pointer; }
.x:hover { background: var(--el-fill-color-dark); color: var(--el-color-danger); }
.closeall { margin-left: auto; flex: none; border: none; background: transparent; color: var(--el-text-color-placeholder); font-size: 11.5px; padding: 6px 10px; white-space: nowrap; cursor: pointer; }
.closeall:hover { color: var(--el-color-danger); }
.pbody { flex: 1; min-height: 0; }
</style>
