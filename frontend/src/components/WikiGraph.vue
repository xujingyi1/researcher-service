<script setup lang="ts">
// WikiGraph —— obsidian 风格 wiki 关系图谱（spec §9.6 / issue #45 graph）。
// 节点=wiki 页（含 ghost 虚节点），边=[[wikilink]]；当前页节点高亮，点节点冒泡 open 进编辑器。
// vis-network 渲染（canvas）；数据组装与点击转发是组件 seam。
// #670：容器尺寸随面板三态变化（拖宽 / 弹出浮层 / 收回）——画布盒子变了但视图变换不跟随，
// 节点会跑出可视区。用 ResizeObserver 盯 host 盒子，尺寸真变化时 fit（fit 内含 redraw）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Network } from 'vis-network'
import { DataSet } from 'vis-data'
import type { WikiGraphDTO } from '@/api/wiki'

const props = defineProps<{ graph: WikiGraphDTO; activePath: string }>()
const emit = defineEmits<{ open: [path: string] }>()

const host = ref<HTMLDivElement | null>(null)
let network: Network | null = null
let nodeData: DataSet<NodeItem> | null = null
let edgeData: DataSet<EdgeItem> | null = null

interface NodeItem {
  id: string
  label?: string
  color?: string
  borderWidth?: number
}

interface EdgeItem {
  id: string
  from: string
  to: string
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function toNodes(): NodeItem[] {
  const activeColor = cssVar('--el-color-primary', '#409eff')
  return props.graph.nodes.map((n) => ({
    id: n.id,
    label: n.title,
    // 当前页高亮描边；ghost 虚节点淡色
    color: n.id === props.activePath ? activeColor : undefined,
    borderWidth: n.id === props.activePath ? 3 : 1,
  }))
}

function toEdges(): EdgeItem[] {
  return props.graph.edges.map((e, index) => ({
    // index 保留重复 wikilink 边；同一快照内仍有稳定 id，供 DataSet 增量同步。
    id: JSON.stringify([e.from, e.to, index]),
    from: e.from,
    to: e.to,
  }))
}

function rebuild(): void {
  if (!host.value) return
  const textColor = cssVar('--el-text-color-regular', '#606266')
  const borderColor = cssVar('--el-border-color', '#c0c4cc')
  network?.destroy()
  nodeData = new DataSet<NodeItem>(toNodes())
  edgeData = new DataSet<EdgeItem>(toEdges())
  network = new Network(
    host.value,
    { nodes: nodeData as never, edges: edgeData as never },
    {
      nodes: { shape: 'dot', size: 12, font: { size: 12, color: textColor } },
      edges: { arrows: 'to', color: borderColor },
      physics: { barnesHut: { gravitationalConstant: -8000 } },
    },
  )
  network.on('click', (params: { nodes: string[] }) => {
    const id = params.nodes[0]
    if (id) emit('open', id)
  })
}

function hasSameNodeSet(): boolean {
  if (!nodeData) return false
  const currentIds = new Set(nodeData.getIds().map(String))
  return (
    currentIds.size === props.graph.nodes.length &&
    props.graph.nodes.every((n) => currentIds.has(n.id))
  )
}

function syncGraph(): void {
  if (!network || !nodeData || !edgeData || !hasSameNodeSet()) {
    rebuild()
    return
  }

  nodeData.update(toNodes())

  const nextEdges = toEdges()
  const nextEdgeIds = new Set(nextEdges.map((edge) => edge.id))
  const removedEdgeIds = edgeData.getIds().filter((id) => !nextEdgeIds.has(String(id)))
  if (removedEdgeIds.length) edgeData.remove(removedEdgeIds)
  if (nextEdges.length) edgeData.update(nextEdges)
}

function updateActivePath(activePath: string, previousPath: string): void {
  if (!nodeData || activePath === previousPath) return
  const nodeIds = new Set(nodeData.getIds().map(String))
  const activeColor = cssVar('--el-color-primary', '#409eff')
  const updates: NodeItem[] = []
  if (previousPath && nodeIds.has(previousPath)) {
    updates.push({ id: previousPath, color: undefined, borderWidth: 1 })
  }
  if (activePath && nodeIds.has(activePath)) {
    updates.push({ id: activePath, color: activeColor, borderWidth: 3 })
  }
  if (updates.length) nodeData.update(updates)
}

// 尺寸适配（#670）：只在盒子尺寸真变化时 fit——避免与重建/数据同步互相触发（fit 不改盒子，
// 但同尺寸重复 fit 会白丢用户当前的缩放/平移视角）。
let resizeObserver: ResizeObserver | null = null
let lastBoxWidth = 0
let lastBoxHeight = 0

function fitToBox(width: number, height: number): void {
  if (!network) return
  if (width === lastBoxWidth && height === lastBoxHeight) return
  lastBoxWidth = width
  lastBoxHeight = height
  network.fit()
}

function observeResize(): void {
  // jsdom 无 ResizeObserver（真浏览器恒有）：缺席时跳过观察，其余行为不变。
  if (typeof ResizeObserver === 'undefined' || !host.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (box) fitToBox(box.width, box.height)
  })
  resizeObserver.observe(host.value)
}

onMounted(() => {
  rebuild()
  observeResize()
})
watch(() => props.graph, syncGraph, { deep: true })
watch(() => props.activePath, updateActivePath)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  network?.destroy()
  network = null
  nodeData = null
  edgeData = null
})
</script>

<template>
  <div ref="host" class="wiki-graph" data-test="wiki-graph" />
</template>

<style scoped>
.wiki-graph {
  height: 100%;
  min-height: 300px;
}
</style>
