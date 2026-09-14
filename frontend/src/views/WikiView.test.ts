// seam: WikiView 页 —— issue #45 wiki 编辑页组装（spec §9.6）。
// 版面：顶部容器切换器 + 左文件树 + 中 Milkdown 编辑器 + 右图谱（可折叠）。
// 联动：点树/图谱节点 openPage；编辑器 update → store.edit（防抖自动保存）；切容器 switchContainer。
// store 用真 Pinia（api/wiki mock 替身）；子组件 stub 聚焦组装逻辑。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/wiki', () => ({
  getTree: vi.fn(),
  readPage: vi.fn(),
  updatePage: vi.fn(),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  getGraph: vi.fn(),
}))
vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn() },
    ElMessageBox: { prompt: vi.fn(), confirm: vi.fn() },
  }
})

import WikiView from '@/views/WikiView.vue'
import { useWikiStore } from '@/stores/wiki'
import { getGraph, getTree, readPage } from '@/api/wiki'
import { listInstances } from '@/api/containers'
import { ElMessage } from 'element-plus'

const INSTANCES = [
  { name: 'demo', port: 19000, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c1', created_at: '', pairing: { status: 'paired' } },
  { name: 'other', port: 19001, status: 'running', health: 'healthy',
    image: 'img', container_id: 'c2', created_at: '', pairing: { status: 'paired' } },
]
const TREE = {
  groups: [
    { kind: 'concept', name: 'concepts', pages: [{ path: 'concepts/a.md', title: 'A' }] },
  ],
}
const GRAPH = { nodes: [{ id: 'concepts/a.md', title: 'A' }], edges: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const stubs = {
  FileTree: {
    name: 'FileTree',
    props: ['groups', 'activePath'],
    template: '<div data-test="file-tree" />',
    emits: ['open', 'create', 'delete'],
  },
  MdEditor: {
    name: 'MdEditor',
    props: ['content'],
    template: '<div data-test="md-editor" />',
    emits: ['update'],
  },
  WikiGraph: {
    name: 'WikiGraph',
    props: ['graph', 'activePath'],
    template: '<div data-test="wiki-graph" />',
    emits: ['open'],
  },
}

function mountView() {
  return mount(WikiView, { global: { stubs } })
}

describe('WikiView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
  })

  it('loads first container tree+graph on mount', async () => {
    mountView()
    await flushPromises()
    const s = useWikiStore()
    expect(s.current).toBe('demo')
    expect(getTree).toHaveBeenCalledWith('demo')
    expect(getGraph).toHaveBeenCalledWith('demo')
  })

  it('renders container switcher with all instances', async () => {
    const wrapper = mountView()
    await flushPromises()
    const options = wrapper.findAll('[data-test="container-switch"] option')
    expect(options.map((o) => o.text())).toEqual(['demo', 'other'])
  })

  it('opens a page when file tree emits open', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(readPage).toHaveBeenCalledWith('demo', 'concepts/a.md')
    expect(useWikiStore().activePath).toBe('concepts/a.md')
  })

  it('opens a page when graph emits open', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'WikiGraph' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(useWikiStore().activePath).toBe('concepts/a.md')
  })

  it('shows an error when opening a page fails', async () => {
    const wrapper = mountView()
    await flushPromises()
    // 真实业务失败经 apiJson 抛 ApiError（client.ts #312 信封），其 message 逐字透传。
    const { ApiError } = await import('@/api/errors')
    ;(readPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(200, '页面读取失败', 20040))
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('页面读取失败')
  })

  it('routes editor update into store.edit (autosave)', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    await wrapper.findComponent({ name: 'MdEditor' }).vm.$emit('update', '# A 改')
    expect(useWikiStore().draft).toBe('# A 改')
    expect(useWikiStore().dirty).toBe(true)
  })

  it('switches container via switcher', async () => {
    const wrapper = mountView()
    await flushPromises()
    const select = wrapper.find('[data-test="container-switch"]')
    await select.setValue('other')
    await flushPromises()
    expect(useWikiStore().current).toBe('other')
    expect(getTree).toHaveBeenCalledWith('other')
  })

  it('keeps the latest graph when container responses arrive out of order', async () => {
    const wrapper = mountView()
    await flushPromises()
    const otherGraph = deferred<typeof GRAPH>()
    const demoGraph = { nodes: [{ id: 'concepts/latest.md', title: 'Latest' }], edges: [] }
    ;(getGraph as ReturnType<typeof vi.fn>).mockImplementation(
      (name: string) => name === 'other' ? otherGraph.promise : Promise.resolve(demoGraph),
    )

    const select = wrapper.find('[data-test="container-switch"]')
    await select.setValue('other')
    await flushPromises()
    expect(getGraph).toHaveBeenCalledWith('other')
    await select.setValue('demo')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'WikiGraph' }).props('graph')).toEqual(demoGraph)

    otherGraph.resolve(GRAPH)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'WikiGraph' }).props('graph')).toEqual(demoGraph)
  })

  it('shows an error when switching container fails', async () => {
    const wrapper = mountView()
    await flushPromises()
    // 真实业务失败经 apiJson 抛 ApiError（client.ts #312 信封），其 message 逐字透传。
    const { ApiError } = await import('@/api/errors')
    ;(getTree as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(200, '容器切换失败', 20040))
    await wrapper.find('[data-test="container-switch"]').setValue('other')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('容器切换失败')
  })

  it('toggles graph panel collapsed', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(true)
    await wrapper.find('[data-test="toggle-graph"]').trigger('click')
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(false)
  })

  it('#493: 挂载链遇超时/AbortError → 弹本地化提示而非浏览器原生 "Fetch is aborted"', async () => {
    // 15s 统一超时（api/request.ts AbortSignal.timeout）触发时，fetch reject 原生 DOMException
    // （Safari 文案 "Fetch is aborted"）。它不是 ApiError，不应把浏览器原文漏给用户。
    const abort = new DOMException('Fetch is aborted', 'AbortError')
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValueOnce(abort)
    mountView()
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled()
    const shown = (ElMessage.error as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(shown).not.toBe('Fetch is aborted') // 不得原样弹浏览器原生 AbortError 文案
    expect(typeof shown).toBe('string')
    expect((shown as string).length).toBeGreaterThan(0) // 给出可理解的本地化提示
  })

  it('#493: 挂载链的真实业务错误（ApiError）仍逐字透传，不回归', async () => {
    // 20040 越权等真实业务错误经信封解析为 ApiError，其 message 是后端真实可读消息，逐字透传。
    const { ApiError } = await import('@/api/errors')
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(200, '容器不可访问', 20040),
    )
    mountView()
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('容器不可访问')
  })
})

describe('WikiView — #668 面板三态接线（wiki 文件树）', () => {
  // 视口宽是全局状态：每个用例后复位，防窄屏用例失败时向后续用例泄漏
  afterEach(() => {
    window.innerWidth = 1024
    globalThis.localStorage.clear()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
    globalThis.localStorage.clear()
  })

  it('FileTree 被三态包装接管（panel 根 + inline 态 + slot 内）', async () => {
    const wrapper = mountView()
    await flushPromises()
    const panel = wrapper.find('[data-test="panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('data-state')).toBe('inline') // collapsed/popped 不持久化：每次进页 inline
    // 拖宽手柄与折叠按钮就位（三态控件，窄屏才整体消失）
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="collapse-btn"]').exists()).toBe(true)
    // FileTree 在三态包装的 slot 内
    expect(panel.element.contains(wrapper.find('[data-test="file-tree"]').element)).toBe(true)
  })

  it('宽度经 localStorage 恢复（key 按页面+面板隔离，owner 未登录为 signed-out）', async () => {
    globalThis.localStorage.setItem('researcher:panel:signed-out:wiki:file-tree:width', '400')
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="panel"]').attributes('style')).toContain('width: 400px')
  })

  it('窄屏 (<720px) 三态整体禁用：无手柄无按钮，树照常渲染', async () => {
    window.innerWidth = 500
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('disabled')
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="collapse-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="file-tree"]').exists()).toBe(true)
  })
})

describe('WikiView — #670 面板三态接线（wiki 图谱 + 同页互斥）', () => {
  afterEach(() => {
    window.innerWidth = 1024
    globalThis.localStorage.clear()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
    globalThis.localStorage.clear()
  })

  // 面板根节点按贴边侧区分：左文件树 / 右图谱（互斥用例要分别点名两个面板）
  function panels(wrapper: ReturnType<typeof mountView>) {
    return {
      tree: wrapper.find('[data-test="panel"][data-side="left"]'),
      graph: wrapper.find('[data-test="panel"][data-side="right"]'),
    }
  }

  it('图谱被三态包装接管（inline 态 + 贴右缘 + WikiGraph 在 slot 内）', async () => {
    const wrapper = mountView()
    await flushPromises()
    const { graph } = panels(wrapper)
    expect(graph.exists()).toBe(true)
    expect(graph.attributes('data-state')).toBe('inline') // 态不持久化：每次进页 inline
    expect(graph.attributes('style')).toContain('width: 320px') // 沿用原固定宽
    expect(graph.element.contains(wrapper.find('[data-test="wiki-graph"]').element)).toBe(true)
  })

  it('图谱宽度经 localStorage 恢复（key 按 wiki/graph 独立于文件树）', async () => {
    globalThis.localStorage.setItem('researcher:panel:signed-out:wiki:graph:width', '600')
    const wrapper = mountView()
    await flushPromises()
    expect(panels(wrapper).graph.attributes('style')).toContain('width: 600px')
    // 文件树仍是自己的默认宽——两个面板不共用 key
    expect(panels(wrapper).tree.attributes('style')).toContain('width: 220px')
  })

  it('graphOpen=false 时连三态包装一起不渲染（无幽灵手柄/浮层）', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-test="toggle-graph"]').trigger('click')
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(false)
    expect(panels(wrapper).graph.exists()).toBe(false)
    // 右侧面板消失后，页面上只剩文件树一个三态面板（其手柄仍可用）
    expect(wrapper.findAll('[data-test="panel"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(true)

    await wrapper.find('[data-test="toggle-graph"]').trigger('click')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('inline')
  })

  it('图谱折叠 → 弹出：浮层态，文件树不受影响', async () => {
    const wrapper = mountView()
    await flushPromises()
    const { graph, tree } = panels(wrapper)
    await graph.find('[data-test="collapse-btn"]').trigger('click')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('collapsed')
    expect(tree.attributes('data-state')).toBe('inline')
    await panels(wrapper).graph.find('[data-test="rail"]').trigger('click')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('popped')
    expect(tree.attributes('data-state')).toBe('inline')
  })

  it('US25 同页互斥：图谱弹出时自动收回已弹出的文件树', async () => {
    const wrapper = mountView()
    await flushPromises()
    // 文件树：折叠 → 弹出
    await panels(wrapper).tree.find('[data-test="collapse-btn"]').trigger('click')
    await panels(wrapper).tree.find('[data-test="rail"]').trigger('click')
    expect(panels(wrapper).tree.attributes('data-state')).toBe('popped')
    // 图谱：折叠 → 弹出 → 文件树被自动收回（同页至多一个浮层）
    await panels(wrapper).graph.find('[data-test="collapse-btn"]').trigger('click')
    await panels(wrapper).graph.find('[data-test="rail"]').trigger('click')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('popped')
    expect(panels(wrapper).tree.attributes('data-state')).toBe('inline')
  })

  it('US25 互斥反向同样成立（弹文件树收图谱）', async () => {
    const wrapper = mountView()
    await flushPromises()
    await panels(wrapper).graph.find('[data-test="collapse-btn"]').trigger('click')
    await panels(wrapper).graph.find('[data-test="rail"]').trigger('click')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('popped')
    await panels(wrapper).tree.find('[data-test="collapse-btn"]').trigger('click')
    await panels(wrapper).tree.find('[data-test="rail"]').trigger('click')
    expect(panels(wrapper).tree.attributes('data-state')).toBe('popped')
    expect(panels(wrapper).graph.attributes('data-state')).toBe('inline')
  })

  it('US26 图谱浮层宽度拖拽结束落独立 key（inline 宽度不被污染）', async () => {
    window.innerWidth = 1000
    const wrapper = mountView()
    await flushPromises()
    await panels(wrapper).graph.find('[data-test="collapse-btn"]').trigger('click')
    await panels(wrapper).graph.find('[data-test="rail"]').trigger('click')
    const handle = panels(wrapper).graph.find('[data-test="pop-handle"]')
    // 贴右缘浮层：手柄在左缘，左拖变宽（起始 500px = 50vw → 拖到 700px = 70vw）
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }))
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(globalThis.localStorage.getItem('researcher:panel:signed-out:wiki:graph:popped-width')).toBe('70')
    expect(globalThis.localStorage.getItem('researcher:panel:signed-out:wiki:graph:width')).toBeNull()
  })

  it('窄屏 (<720px) 图谱三态禁用：无控件，图谱照常渲染（保持现有响应式布局）', async () => {
    window.innerWidth = 500
    const wrapper = mountView()
    await flushPromises()
    const { graph } = panels(wrapper)
    expect(graph.attributes('data-state')).toBe('disabled')
    // 禁用态宽度走 CSS 变量（非内联 width）——宿主窄屏媒体查询可覆盖它
    expect(graph.attributes('style')).toContain('--panel-default-width: 320px')
    expect(graph.find('[data-test="collapse-btn"]').exists()).toBe(false)
    expect(graph.find('[data-test="drag-handle"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="wiki-graph"]').exists()).toBe(true)
  })
})

describe('WikiView — codex PR #62 意见6 回归', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue(INSTANCES)
    ;(getTree as ReturnType<typeof vi.fn>).mockResolvedValue(TREE)
    ;(getGraph as ReturnType<typeof vi.fn>).mockResolvedValue(GRAPH)
    ;(readPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: 'concepts/a.md', title: 'A', content: '# A',
    })
  })

  it('refreshes tree and graph after a successful autosave (意见6)', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findComponent({ name: 'FileTree' }).vm.$emit('open', 'concepts/a.md')
    await flushPromises()
    ;(getTree as ReturnType<typeof vi.fn>).mockClear()
    ;(getGraph as ReturnType<typeof vi.fn>).mockClear()
    // 触发一次自动保存完成
    const s = useWikiStore()
    s.edit('# A 改了标题')
    await s._flush()
    await flushPromises()
    // 保存成功后树与图谱被刷新（title/wikilink 变更即时反映）
    expect(getTree).toHaveBeenCalled()
    expect(getGraph).toHaveBeenCalled()
  })
})
