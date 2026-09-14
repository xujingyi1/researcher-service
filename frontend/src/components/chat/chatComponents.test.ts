// seam: chat 展示组件哑测（#316 / #340 验收：props-in/emits-out 零逻辑，贴 FileTree 测试形态）。
// 覆盖：ChatSidebar 容器/会话渲染 + emits；ChatComposer 输入 v-model + 发送禁用门 + slash-menu slot；
// ChatMessageItem thinking/tool-line slot 透传 + 光标；ApprovalCard resolve emits + 已解决态；
// ChatStream 消息流渲染 + 自动滚动（ADR 0014 审批卡撤离时间线；#400 范式 B + rAF 节流）。
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { newMsg, type ApprovalItem, type Msg } from '@/stores/chat'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import TraceFold from '@/components/chat/TraceFold.vue'
import ApprovalCard from '@/components/chat/ApprovalCard.vue'
import ApprovalDock from '@/components/chat/ApprovalDock.vue'
import ChatStream from '@/components/chat/ChatStream.vue'
import AnchorRail from '@/components/chat/AnchorRail.vue'

const INSTANCE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'i',
  container_id: 'c',
  created_at: '',
  pairing: { status: 'unpaired' },
}
const SESSION = { session_key: 'sk-1', title: '文献综述', updated_at: '' }

describe('ChatHeader', () => {
  it('长标题保留完整提示，容器与连接状态保持独立标签', () => {
    const title = '一个非常长的会话标题，用于验证窄窗口下不会挤压容器和连接状态'
    const w = mount(ChatHeader, {
      props: { title, container: 'research-container', connecting: true },
    })
    expect(w.get('[data-test="chat-title"]').attributes('title')).toBe(title)
    expect(w.findAll('.tag').map((tag) => tag.text())).toEqual(['research-container', '连接中…'])
  })
})

describe('ChatSidebar', () => {
  it('渲染容器/会话 + 选中态 + 删除/新建 emits', async () => {
    const w = mount(ChatSidebar, {
      props: {
        instances: [INSTANCE],
        sessions: [SESSION],
        selectedContainer: 'demo',
        selectedSession: '',
      },
    })
    expect(w.text()).toContain('demo')
    expect(w.text()).toContain('文献综述')
    await w.find('[data-test="new-session"]').trigger('click')
    expect(w.emitted('newSession')).toBeTruthy()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    expect(w.emitted('removeSession')?.[0]).toEqual(['sk-1'])
    await w.find('[data-test="container-demo"]').trigger('click')
    expect(w.emitted('selectContainer')?.[0]).toEqual(['demo'])
    await w.find('[data-test="session-sk-1"]').trigger('click')
    expect(w.emitted('selectSession')?.[0]).toEqual(['sk-1'])
    expect(w.get('[data-test="container-demo"]').element.tagName).toBe('BUTTON')
    expect(w.get('[data-test="session-sk-1"]').element.tagName).toBe('BUTTON')
    expect(w.get('[data-test="delete-session-sk-1"]').element.tagName).toBe('BUTTON')
  })
})

describe('ChatComposer', () => {
  const baseProps = {
    modelValue: '',
    matches: [],
    slashOpen: false,
    slashIndex: 0,
    connecting: false,
    streaming: false,
    disconnected: false,
  }

  it('v-model 输入 + 发送 emit', async () => {
    const w = mount(ChatComposer, { props: baseProps })
    await w.find('[data-test="input"]').setValue('hello')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['hello'])
    // 真实输入同时抛 input 事件（父复位菜单态，修复评审发现的死 emit 回归）
    expect(w.emitted('input')).toBeTruthy()
    await w.find('[data-test="send"]').trigger('click')
    expect(w.emitted('send')).toBeTruthy()
  })

  it('连接/流式/断线任一为真 → 发送禁用', () => {
    const mk = (over: Partial<{ connecting: boolean; streaming: boolean; disconnected: boolean }>) =>
      mount(ChatComposer, {
        props: { ...baseProps, ...over },
      })
    expect(mk({ connecting: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({ streaming: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({ disconnected: true }).find('[data-test="send"]').attributes('disabled')).toBeDefined()
    expect(mk({}).find('[data-test="send"]').attributes('disabled')).toBeUndefined()
  })

  it('slash-menu slot：slashOpen 且匹配 → slot 渲染（父注入表现）', async () => {
    const w = mount(ChatComposer, {
      props: {
        ...baseProps,
        modelValue: '/mod',
        matches: [{ alias: '/model', description: '切换模型' }],
        slashOpen: true,
      },
      slots: {
        'slash-menu': `<div data-test="custom-menu">{{ matches[0].alias }}</div>`,
      },
    })
    expect(w.find('[data-test="custom-menu"]').text()).toContain('/model')
  })

  it('slashOpen=false → 菜单不渲染', () => {
    const w = mount(ChatComposer, { props: baseProps })
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(false)
  })

  it('#511: 输入内容变化时自动增高，并限制最大高度', async () => {
    const w = mount(ChatComposer, { props: baseProps })
    const textarea = w.find<HTMLTextAreaElement>('[data-test="input"]')
    Object.defineProperty(textarea.element, 'scrollHeight', { configurable: true, value: 260 })
    await w.setProps({ modelValue: '多行\n'.repeat(20) })
    await nextTick()
    expect(textarea.element.style.height).toBe('180px')

    Object.defineProperty(textarea.element, 'scrollHeight', { configurable: true, value: 64 })
    await w.setProps({ modelValue: '两行' })
    await nextTick()
    expect(textarea.element.style.height).toBe('64px')
  })
})

describe('ChatMessageItem', () => {
  it('#515: completed assistant response can request regeneration of its user prompt', async () => {
    const m = newMsg('assistant', 'answer'); m.streaming = false
    const w = mount(ChatMessageItem, { props: { msg: m, regenerateText: 'question' } })
    await w.get('[data-test="regenerate"]').trigger('click')
    expect(w.emitted('regenerate')?.[0]).toEqual(['question'])
  })

  it('#515: 含附件的用户消息不显示误导性的重新生成入口', () => {
    const user = newMsg('user', '请分析附件')
    user.media.push({ type: 'image', mimeType: 'image/png', src: 'AA==' })
    const answer = newMsg('assistant', '完成'); answer.streaming = false
    const w = mount(ChatStream, {
      props: { messages: [user, answer], historyHasMore: false, historyLoading: false },
    })
    expect(w.find('[data-test="regenerate"]').exists()).toBe(false)
  })
  it('thinking/tool-line slot 透传（默认渲染 ThinkingCard/ToolLine）', async () => {
    const m = newMsg('assistant', '正文')
    m.thinking = '思考内容'
    m.thinkingOpen = false
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: undefined, input: 'ls', result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('思考内容')
    expect(w.find('[data-test="tool-line"]').exists()).toBe(true)
    expect(w.text()).toContain('正文')
  })

  it('assistant 正文走 markdown 渲染（**加粗** → strong 节点，非源码）', () => {
    const m = newMsg('assistant', '**加粗** 和 `code`')
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('.markdown-body strong').exists()).toBe(true)
    expect(w.find('.markdown-body strong').text()).toBe('加粗')
    expect(w.find('.markdown-body code').exists()).toBe(true)
  })

  it('user 消息保持纯文本（* # _ 不渲染成语法）', () => {
    const m = newMsg('user', '我输入 **星号** 和 # 井号')
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('.markdown-body').exists()).toBe(false)
    expect(w.find('strong').exists()).toBe(false)
    expect(w.text()).toContain('**星号**') // 源码原样，不解析
    expect(w.text()).toContain('# 井号')
  })

  it('流式助手消息渲染光标（MarkdownRenderer streaming）', () => {
    const m = newMsg('assistant', '')
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('.cursor').exists()).toBe(true)
  })

  it('已落定助手消息无光标', () => {
    const m = newMsg('assistant', '完整')
    m.streaming = false
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('.cursor').exists()).toBe(false)
  })

  it('settled assistant message shows AI reference notice', () => {
    const m = newMsg('assistant', '完整回答')
    m.streaming = false
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="ai-notice"]').text()).toContain('内容由 AI 生成，仅供参考')
  })

  it('streaming assistant and user messages do not show AI reference notice', () => {
    const streamingAssistant = mount(ChatMessageItem, { props: { msg: newMsg('assistant', '生成中') } })
    expect(streamingAssistant.find('[data-test="ai-notice"]').exists()).toBe(false)

    const user = mount(ChatMessageItem, { props: { msg: newMsg('user', '用户输入') } })
    expect(user.find('[data-test="ai-notice"]').exists()).toBe(false)
  })

  // #498：超长连续命令不再撑破气泡——.bubble 作为 .msg 的 flex item 须 min-width:0，
  // 让收缩约束贯穿到 ToolLine 的 .t-args 截断链。jsdom 无布局引擎、也不注入 SFC scoped
  // 样式到 document，故直接读组件源码锁定该约束（防未来重构误删 min-width:0 回归）。
  it('.bubble 规则含 min-width:0（flex item 可收缩，#498 防回归）', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/components/chat/ChatMessageItem.vue'), 'utf8')
    const bubbleRule = src.match(/\.bubble\s*\{[^}]*\}/)?.[0] ?? ''
    expect(bubbleRule).toContain('min-width: 0')
  })

  it('#510: 消息与工具收缩链完整，长内容不会撑宽对话区', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const message = readFileSync(join(process.cwd(), 'src/components/chat/ChatMessageItem.vue'), 'utf8')
    const tool = readFileSync(join(process.cwd(), 'src/components/chat/ToolLine.vue'), 'utf8')
    expect(message.match(/\.bubble\s*\{[^}]*\}/)?.[0]).toContain('min-width: 0')
    expect(tool.match(/\.tool\s*\{[^}]*\}/)?.[0]).toContain('min-width: 0')
    expect(tool.match(/\.tool \.t-args\s*\{[^}]*\}/)?.[0]).toContain('text-overflow: ellipsis')
  })

  it('使用紧凑布局：用户气泡右对齐，assistant 不显示气泡背景', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/components/chat/ChatMessageItem.vue'), 'utf8')
    const userRowRule = src.match(/\.msg\.user\s*\{[^}]*\}/)?.[0] ?? ''
    const assistantBubbleRule = src.match(/\.msg\.assistant \.bubble\s*\{[^}]*\}/)?.[0] ?? ''
    const userBubbleRule = src.match(/\.msg\.user \.bubble\s*\{[^}]*\}/)?.[0] ?? ''

    expect(userRowRule).toContain('justify-content: flex-end')
    expect(assistantBubbleRule).toContain('background: transparent')
    expect(userBubbleRule).toContain('background:')
  })

  // ---- #568: 附件元数据呈现（image 尺寸/体积、audio 时长/体积、video 尺寸/时长、document 下载卡、url 形态）----
  it('#568: image 附件带 width/height/sizeBytes → 元数据行显示尺寸与体积', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'AAA', width: 1280, height: 720, sizeBytes: 2048 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const meta = w.get('[data-test="media-meta"]')
    expect(meta.text()).toContain('1280 × 720')
    expect(meta.text()).toContain('2 KB')
  })
  it('#568: audio 附件带 durationMs/sizeBytes → 元数据行显示时长与体积', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'audio', mimeType: 'audio/mpeg', src: 'QUJD', durationMs: 150000, sizeBytes: 1024 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const meta = w.get('[data-test="media-meta"]')
    expect(meta.text()).toContain('2:30')
    expect(meta.text()).toContain('1 KB')
  })
  it('#568: video 附件带 width/height/durationMs → 元数据行显示尺寸与时长', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'video', mimeType: 'video/mp4', src: 'REVG', width: 640, height: 360, durationMs: 60000 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const meta = w.get('[data-test="media-meta"]')
    expect(meta.text()).toContain('640 × 360')
    expect(meta.text()).toContain('1:00')
  })
  it('#568: 无元数据的附件 → 不渲染元数据行（现状无差）', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'AAA' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="media-meta"]').exists()).toBe(false)
  })
  it('#568: document 附件 → 下载链接卡（fileName + sizeBytes + dataURL href）', () => {
    const m = newMsg('assistant', '请下载：')
    m.media.push({ type: 'document', mimeType: 'application/pdf', src: 'JVBER', fileName: 'report.pdf', sizeBytes: 2048 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const link = w.get('[data-test="media-document"]')
    expect(link.text()).toContain('report.pdf')
    expect(link.text()).toContain('2 KB')
    expect(link.attributes('href')).toBe('data:application/pdf;base64,JVBER')
    expect(link.attributes('download')).toBe('report.pdf')
  })
  it('#568: document 附件 label 优先于 fileName 展示', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'document', mimeType: 'application/pdf', src: 'JVBER', fileName: 'report.pdf', label: '研究报告', sizeBytes: 2048 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="media-document"]').text()).toContain('研究报告')
  })
  it('#568: url 形态附件 src 原样使用不拼 base64（mediaSrc http 分支）', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'https://img.example.com/x.png' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="media-image"]').attributes('src')).toBe('https://img.example.com/x.png')
  })
  it('Phase 2: blob 形态附件 src 原样返回不拼 base64（agent 容器媒体经 files/raw resolve 的 objectURL）', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'blob:http://localhost:5173/1234-5678' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="media-image"]').attributes('src')).toBe('blob:http://localhost:5173/1234-5678')
  })
  it('#568: url 形态 document → href 直用 url（不拼 base64），download 仍生效', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'document', mimeType: 'application/pdf', src: 'https://files.example.com/report.pdf', fileName: 'report.pdf' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const link = w.get('[data-test="media-document"]')
    expect(link.attributes('href')).toBe('https://files.example.com/report.pdf')
    expect(link.attributes('download')).toBe('report.pdf')
  })
  // ---- #568 安全修复（security review）：document dataURL href mime 白名单 + mediaSrc scheme 防御 ----
  it('#568(security): document 非白名单 mime（text/html / image/svg+xml）→ 不渲染下载卡（防下载脚本类文件）', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'document', mimeType: 'text/html', src: 'PGh0bWw+', fileName: 'x.html', sizeBytes: 100 })
    m.media.push({ type: 'document', mimeType: 'image/svg+xml', src: 'PHN2Zz4=', fileName: 'x.svg', sizeBytes: 100 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="media-document"]').exists()).toBe(false)
  })
  it('#568(security): document 白名单 mime（application/pdf / text/plain）→ 渲染下载卡', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'document', mimeType: 'application/pdf', src: 'JVBER', fileName: 'a.pdf', sizeBytes: 100 })
    m.media.push({ type: 'document', mimeType: 'text/plain', src: 'aGVsbG8=', fileName: 'b.txt', sizeBytes: 100 })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.findAll('[data-test="media-document"]').length).toBe(2)
  })
  it('#568(security): mediaSrc 对 javascript: scheme src 不原样透出（拼进 base64 段，解码失败不渲染）', () => {
    const m = newMsg('assistant', '')
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'javascript:alert(1)' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="media-image"]').attributes('src')?.startsWith('data:image/png;base64,')).toBe(true)
  })
})

describe('ToolLine', () => {
  it('#509: defaults to a compact summary and exposes input/output on demand', async () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'exec', state: 'done', title: '执行命令', input: { command: 'echo ok' }, result: 'ok' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const details = w.get('details[data-test="tool-line"]')
    expect(details.attributes('open')).toBeUndefined()
    expect(w.get('[data-test="tool-detail"]').text()).toContain('echo ok')
    expect(w.get('[data-test="tool-detail"]').text()).toContain('ok')
  })

  it('#555: command rows show the unwrapped command as the summary main text', () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'sh -lc "echo hi"' }, result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="tool-line"] .t-name').text()).toBe('echo hi')
  })

  it('#555: read rows show basename bold + directory dimmed', () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'read', state: 'done', title: null, input: { file_path: '/repo/src/util.ts' }, result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="tool-line"] .t-name').text()).toBe('util.ts')
    expect(w.get('[data-test="tool-line"] .t-args').text()).toBe('/repo/src')
  })

  it('#555: edit rows render an inline diff with stat when result carries details.diff', () => {
    const m = newMsg('assistant', '')
    m.tools.push({
      id: 't1', name: 'edit', state: 'done', title: null,
      input: { file_path: '/repo/a.ts' },
      result: { diff: '+457 foo\n-455 bar\n' },
    })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="tool-diff"]').text()).toContain('foo')
    expect(w.get('[data-test="tool-diff"]').text()).toContain('bar')
    expect(w.get('[data-test="tool-stat"]').text()).toContain('+1')
    expect(w.get('[data-test="tool-stat"]').text()).toContain('−1')
  })
})

// #555:聚合摘要(>=2 个工具调用折叠为一条摘要,展开逐行;单工具调用直接渲染)
describe('ToolGroup', () => {
  it('aggregates 2+ tool calls into a collapsed summary row', () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'ls' }, result: '' })
    m.tools.push({ id: 't2', name: 'bash', state: 'done', title: null, input: { command: 'pwd' }, result: '' })
    m.tools.push({ id: 't3', name: 'read', state: 'error', title: null, input: { path: '/repo/a.ts' }, result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const group = w.get('details[data-test="tool-group"]')
    expect(group.attributes('open')).toBeUndefined()
    expect(w.get('[data-test="tool-group-summary"]').text()).toBe('Ran 2 commands, read a file · 1 failed')
    expect(w.findAll('[data-test="tool-line"]')).toHaveLength(3)
  })

  it('keeps single tool calls ungrouped (direct ToolLine row)', () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'ls' }, result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="tool-group"]').exists()).toBe(false)
    expect(w.findAll('[data-test="tool-line"]')).toHaveLength(1)
  })

  it('aggregation keeps tool-line slot passthrough per row', async () => {
    const m = newMsg('assistant', '')
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'ls' }, result: '' })
    m.tools.push({ id: 't2', name: 'bash', state: 'done', title: null, input: { command: 'pwd' }, result: '' })
    const w = mount(ChatMessageItem, {
      props: { msg: m },
      slots: {
        'tool-line': ({ tool }: { tool: Msg['tools'][number] }) => `custom:${tool.id}`,
      },
    })
    expect(w.text()).toContain('custom:t1')
    expect(w.text()).toContain('custom:t2')
  })
})

// T1 轮次折叠（#664）：TraceFold 条面哑组件——计数文案 + 点击开合 emit（props-in/emits-out）。
// 时长格式化（后续票）不单开纯函数测试，经条面文案断言。
describe('TraceFold', () => {
  it('条面计数文案：思考+工具 → 「执行过程 · 思考 · N 次工具」', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 5, folded: true } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考 · 5 次工具')
  })
  it('纯思考轮按实际内容计数：「执行过程 · 思考」', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 0, folded: true } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考')
  })
  it('纯工具轮按实际内容计数：思考段省略', () => {
    const w = mount(TraceFold, { props: { hasThinking: false, toolCount: 3, folded: true } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 3 次工具')
  })
  it('点击条面 → emit toggle（开合由父层落 store）', async () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 1, folded: true } })
    await w.get('[data-test="trace-fold"]').trigger('click')
    expect(w.emitted('toggle')).toBeTruthy()
  })
})

// T2 执行时长（#665）：条面文案升级——有时长主文案「已执行 42s」（≥60s 中文分秒）+ 次要计数；
// 无时长数据（历史轮）回退「执行过程」计数文案。时长格式化经条面文案断言（spec 决议：不新增
// 纯函数测试接缝）。
describe('TraceFold 执行时长（#665 T2）', () => {
  it('不足 60s：「已执行 42s · 思考 · 5 次工具」（42s 边界）', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 5, folded: true, turnDurationMs: 42_000 } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('已执行 42s · 思考 · 5 次工具')
  })
  it('≥60s：「已执行 1 分 12 秒 · 思考 · 5 次工具」（1 分 12 秒边界）', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 5, folded: true, turnDurationMs: 72_000 } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('已执行 1 分 12 秒 · 思考 · 5 次工具')
  })
  it('整分钟省略秒段：60s → 「已执行 1 分 · …」（60s 边界）', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 5, folded: true, turnDurationMs: 60_000 } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('已执行 1 分 · 思考 · 5 次工具')
  })
  it('纯工具轮带时长：计数段按实际内容（无思考段）', () => {
    const w = mount(TraceFold, { props: { hasThinking: false, toolCount: 3, folded: true, turnDurationMs: 42_000 } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('已执行 42s · 3 次工具')
  })
  it('无时长数据（durationMs 缺省，历史轮）回退「执行过程」计数文案，不显示「已执行」', () => {
    const w = mount(TraceFold, { props: { hasThinking: true, toolCount: 5, folded: true, turnDurationMs: undefined } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考 · 5 次工具')
  })
})

// T1 轮次折叠（#664）：折叠条渲染规则（ChatMessageItem 集成，展示接缝）——
// 折叠态只渲染条面（正文/附件/AI 提示条恒在外）；展开态平铺思考卡+逐行工具行（无分组二级聚合）；
// 无轨迹不渲染；流式进行中现状渲染不动。
describe('ChatMessageItem 轮次折叠（#664 T1）', () => {
  // 构造一条完成且带轨迹（思考 + 2 工具行）的 assistant 消息
  function tracedAssistant(): Msg {
    const m = newMsg('assistant', '总结正文')
    m.streaming = false
    m.thinking = '思考内容'
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'ls' }, result: '' })
    m.tools.push({ id: 't2', name: 'read', state: 'done', title: null, input: { file_path: '/a.ts' }, result: '' })
    return m
  }

  it('折叠态只渲染条面（思考卡/工具行不渲染）；正文、附件、AI 提示条仍可见', () => {
    const m = tracedAssistant()
    m.traceFolded = true
    m.media.push({ type: 'image', mimeType: 'image/png', src: 'AAA' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true) // 条面在
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考 · 2 次工具')
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 轨迹收起
    expect(w.find('[data-test="tool-line"]').exists()).toBe(false)
    expect(w.text()).toContain('总结正文') // 正文恒在外
    expect(w.find('[data-test="media-image"]').exists()).toBe(true) // 附件恒在外
    expect(w.find('[data-test="ai-notice"]').text()).toContain('内容由 AI 生成') // AI 提示条恒在外
  })

  it('展开态平铺思考卡 + 逐行工具行（无工具分组 details）；条面仍在、可再收起', async () => {
    const m = tracedAssistant()
    m.traceFolded = false
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true) // 条面仍在（可再收起）
    expect(w.find('[data-test="cot-card"]').text()).toContain('思考内容') // 思考卡平铺
    // 2 个工具行平铺直渲染，绕过 >=2 工具的分组聚合 details（单层展开）
    expect(w.find('[data-test="tool-group"]').exists()).toBe(false)
    expect(w.findAll('[data-test="tool-line"]')).toHaveLength(2)
    await w.get('[data-test="trace-fold"]').trigger('click')
    expect(w.emitted('toggleTraceFold')).toBeTruthy() // 可再收起（emit 回父层落 store）
  })

  it('点击折叠条 → emit toggleTraceFold（父层落 store mutation）', async () => {
    const m = tracedAssistant()
    m.traceFolded = true
    const w = mount(ChatMessageItem, { props: { msg: m } })
    await w.get('[data-test="trace-fold"]').trigger('click')
    expect(w.emitted('toggleTraceFold')).toBeTruthy()
  })

  it('无轨迹（思考空且无工具）的完成消息不渲染折叠条', () => {
    const m = newMsg('assistant', '纯文本回复')
    m.streaming = false
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(false)
  })

  it('纯思考轮照常渲染折叠条（计数文案无工具段）', () => {
    const m = newMsg('assistant', '正文')
    m.streaming = false
    m.thinking = '只有思考'
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考')
  })

  it('纯工具轮照常渲染折叠条（单工具直接平铺）', () => {
    const m = newMsg('assistant', '正文')
    m.streaming = false
    m.tools.push({ id: 't1', name: 'bash', state: 'done', title: null, input: { command: 'ls' }, result: '' })
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 1 次工具')
  })

  it('traceFolded 缺省（undefined，error/断线/宽限收尾轮不置折叠态）→ 条面渲染且轨迹展开可见（缺省即展开）', () => {
    const m = tracedAssistant() // 不设 traceFolded——异常收尾轮同形态
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true) // 条目展开（无「箭头闭合却展开」矛盾态）
    expect(w.findAll('[data-test="tool-line"]')).toHaveLength(2)
    expect(w.find('[data-test="tool-group"]').exists()).toBe(false) // 折叠条场景绕过分组聚合
  })

  // T3 历史轮默认折叠（#666）：历史翻译产物形态 = traceFolded=true + turnDurationMs 缺省。
  it('历史翻译消息形态（traceFolded=true、无时长数据）→ 默认折叠：条面步骤计数无「已执行」，轨迹收起、正文在外', () => {
    const m = tracedAssistant()
    m.traceFolded = true // #666 起 loadHistory/外来 final 插入的翻译产物同形态（时长恒缺省）
    const w = mount(ChatMessageItem, { props: { msg: m } })
    const label = w.get('[data-test="trace-fold-label"]').text()
    expect(label).toBe('执行过程 · 思考 · 2 次工具') // 步骤计数（无时长数据回退文案）
    expect(label).not.toContain('已执行') // 历史轮不显示执行时长
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 轨迹默认收起
    expect(w.find('[data-test="tool-line"]').exists()).toBe(false)
    expect(w.text()).toContain('总结正文') // 正文恒在折叠外
  })

  it('历史折叠条手动开合与实时轮一致：折叠态点击 → emit toggleTraceFold；展开态单层平铺（无分组）', async () => {
    const m = tracedAssistant()
    m.traceFolded = true // 历史默认折叠态
    const w = mount(ChatMessageItem, { props: { msg: m } })
    await w.get('[data-test="trace-fold"]').trigger('click')
    expect(w.emitted('toggleTraceFold')).toBeTruthy() // 与实时轮同一开合链路（→父层落 store）
    // 展开态（store mutation 后 traceFolded=false）：平铺思考卡 + 逐行工具行，无二级聚合
    const w2 = mount(ChatMessageItem, { props: { msg: { ...m, traceFolded: false } } })
    expect(w2.find('[data-test="trace-fold"]').exists()).toBe(true) // 条面仍在（可再收起）
    expect(w2.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w2.findAll('[data-test="tool-line"]')).toHaveLength(2)
    expect(w2.find('[data-test="tool-group"]').exists()).toBe(false)
  })

  it('完成轮带执行时长（msg.turnDurationMs）→ 条面显示「已执行 …」（#665 prop 传递）', () => {
    const m = tracedAssistant()
    m.turnDurationMs = 42_000
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('已执行 42s · 思考 · 2 次工具')
  })

  it('流式进行中渲染现状不动：无折叠条，思考卡 + >=2 工具分组聚合照旧', () => {
    const m = tracedAssistant()
    m.streaming = true // 流式中
    m.traceFolded = undefined
    const w = mount(ChatMessageItem, { props: { msg: m } })
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(false) // 不渲染折叠条
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true) // 思考卡照旧
    expect(w.find('[data-test="tool-group"]').exists()).toBe(true) // 既有分组聚合照旧
    expect(w.findAll('[data-test="tool-line"]')).toHaveLength(2)
  })

  it('ChatStream 转发 toggleTraceFold（携带所属消息，供父层落 store）', async () => {
    const m = tracedAssistant()
    m.traceFolded = true
    const w = mount(ChatStream, {
      props: { messages: [m], historyHasMore: false, historyLoading: false },
    })
    await w.get('[data-test="trace-fold"]').trigger('click')
    expect(w.emitted('toggleTraceFold')?.[0]).toEqual([m])
  })
})

// 审批卡测试与 ChatStream 合并时间线测试共用的卡片基底
const card: ApprovalItem = {
  id: 'a1',
  kind: 'exec',
  command: 'rm -rf /tmp/x',
  sessionKey: null,
  agentId: null,
  status: 'pending',
  decision: '',
  detailOpen: false,
  seq: 0,
}
describe('ApprovalCard', () => {

  it('批准/拒绝 emit + 断线禁用按钮', async () => {
    const w = mount(ApprovalCard, { props: { approval: card, disconnected: false } })
    await w.find('[data-test="approve-a1"]').trigger('click')
    expect(w.emitted('resolve')?.[0]).toEqual([card, 'allow-once'])
    await w.find('[data-test="deny-a1"]').trigger('click')
    expect(w.emitted('resolve')?.[1]).toEqual([card, 'deny'])
    const dw = mount(ApprovalCard, { props: { approval: card, disconnected: true } })
    expect(dw.find('[data-test="approve-a1"]').attributes('disabled')).toBeDefined()
  })

  it('已解决态：按钮消失 + 权威 decision 标签', () => {
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, status: 'resolved', decision: 'allow-once' }, disconnected: false },
    })
    expect(w.find('[data-test="approve-a1"]').exists()).toBe(false)
    expect(w.text()).toContain('已批准')
  })

  // #492：失效态（网关侧审批过期/已处理）——终态不可回覆：按钮消失 + 「已失效」标签
  it('失效态：按钮消失 + 「已失效」标签', () => {
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, status: 'expired' }, disconnected: false },
    })
    expect(w.find('[data-test="approve-a1"]').exists()).toBe(false)
    expect(w.find('[data-test="deny-a1"]').exists()).toBe(false)
    expect(w.find('[data-test="approval-expired"]').exists()).toBe(true)
    expect(w.text()).toContain('已失效')
  })

  // #405-T3（#408）：来源徽标——subagent 审批卡带 agentId 徽标，main 审批无徽标
  it('subagent 审批卡（agentId 非空）→ 徽标显示 agentId 值', () => {
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, agentId: 'sub-agent-7' }, disconnected: false },
    })
    const badge = w.find('[data-test="approval-source"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('sub-agent-7')
  })

  it('subagent 审批卡（agentId 缺失、sessionKey 判定）→ 徽标降级「subagent」', () => {
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, sessionKey: 'agent:main:subagent:abc-123' }, disconnected: false },
    })
    const badge = w.find('[data-test="approval-source"]')
    expect(badge.exists()).toBe(true)
    // 精确断言：降级标签是「subagent」而非 sessionKey 原样（toContain 会被子串掩盖）
    expect(badge.text()).toEqual('subagent')
  })

  it('subagent 审批卡（agentId 空串 + subagent 形态 sessionKey）→ 徽标降级「subagent」', () => {
    // 空串 agentId 视同缺失（0 信任）：门控靠 sessionKey 形态通过，文本走 || 降级
    const w = mount(ApprovalCard, {
      props: { approval: { ...card, agentId: '', sessionKey: 'agent:main:subagent:abc-123' }, disconnected: false },
    })
    const badge = w.find('[data-test="approval-source"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toEqual('subagent')
  })

  it('main 会话审批（agentId 空且非 subagent 形态）→ 无徽标', () => {
    const w = mount(ApprovalCard, { props: { approval: card, disconnected: false } })
    expect(w.find('[data-test="approval-source"]').exists()).toBe(false)
  })
})

describe('ApprovalDock', () => {
  it('固定渲染在独立审批区并转发批准、拒绝和详情事件', async () => {
    const approval = { ...card }
    const w = mount(ApprovalDock, { props: { approvals: [approval], disconnected: false } })

    expect(w.find('[data-test="approval-dock"]').exists()).toBe(true)
    await w.get('[data-test="approve-a1"]').trigger('click')
    await w.get('[data-test="deny-a1"]').trigger('click')
    await w.get('[data-test="detail-a1"]').trigger('click')

    expect(w.emitted('resolve')?.[0]).toEqual([approval, 'allow-once'])
    expect(w.emitted('resolve')?.[1]).toEqual([approval, 'deny'])
    expect(w.emitted('toggleDetail')?.[0]).toEqual([approval])
  })

  it('没有待处理请求时不占用输入区上方空间', () => {
    const w = mount(ApprovalDock, { props: { approvals: [], disconnected: false } })
    expect(w.find('[data-test="approval-dock"]').exists()).toBe(false)
  })

  it('多条请求显示数量并限制在可滚动列表中', () => {
    const w = mount(ApprovalDock, {
      props: {
        approvals: [{ ...card }, { ...card, id: 'a2', seq: 2 }],
        disconnected: false,
      },
    })
    expect(w.find('.dock-count').text()).toBe('2 项')
    expect(w.findAll('.approval-list .approval')).toHaveLength(2)
  })
})

describe('ChatStream 自动滚动（ADR 0009 / #400 范式 B + rAF 节流）', () => {
  // 假滚动容器：jsdom 无布局引擎，scrollHeight/clientHeight 是只读 getter、scrollTop setter 是
  // noop（读写恒 0）——用 defineProperty stub 滚动几何 + 自定义存取器记录 scrollTop 赋值，
  // scroll 事件用原生 dispatchEvent 驱动 onScroll（jsdom 的 scrollTop setter 不触发事件）。
  // rAF 在 jsdom 基于 setTimeout(16ms) 实现——fake timers + advanceTimersByTime 推进一帧。
  let stream: HTMLElement
  let rafSpy: ReturnType<typeof vi.spyOn>
  let scrollTopValue = 0
  let maxScroll = 0

  function mountStream(props: Record<string, unknown> = {}) {
    const w = mount(ChatStream, {
      props: {
        messages: [],
        historyHasMore: false,
        historyLoading: false,
        ...props,
      },
      slots: { 'msg-item': `<div data-test="msg"></div>` },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    // 可控 scrollTop：自定义存取器（记录组件内赋值，jsdom 默认 setter 是 noop）；
    // 真实浏览器会 clamp 到 [0, scrollHeight-clientHeight]，这里模拟该语义（maxScroll 为外层
    // describe 变量，mount 后由 stubGeometry 更新）
    Object.defineProperty(stream, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = Math.min(Math.max(v, 0), maxScroll)
      },
    })
    return w
  }

  // 设滚动几何：scrollHeight=1000、clientHeight=100（距底 = 900 - scrollTop）
  function stubGeometry(height = 1000) {
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: height })
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: 100 })
    maxScroll = height - 100
  }

  // 模拟用户滚动到某位置：设置 scrollTop + 派发 scroll 事件（驱动组件内 onScroll 更新 stickyBottom）
  function userScrollTo(top: number) {
    scrollTopValue = top
    stream.dispatchEvent(new Event('scroll'))
  }

  // 推进一帧：fake timers 下 flush Vue 更新（onUpdated 调度 rAF）→ 推进 16ms（rAF 回调执行）
  async function tick() {
    await nextTick()
    vi.advanceTimersByTime(20)
  }

  afterEach(() => {
    rafSpy?.mockRestore()
    vi.useRealTimers()
  })

  // spy 观测 rAF 调度次数（回调照常执行，不改变语义）
  function spyRaf() {
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
  }

  it('停留底部 → 新内容追加自动滚到底（rAF 帧内调度）', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(892) // 距底 8 = 阈值 → stickyBottom
    spyRaf()
    await w.setProps({ messages: [newMsg('assistant', '新回答')] })
    expect(rafSpy).toHaveBeenCalledTimes(1)
    await tick() // rAF 帧执行
    expect(stream.scrollTop).toBe(900) // 滚到底 = scrollHeight - clientHeight（浏览器 clamp 后真实位置） // 自动滚到底
  })

  it('流式逐字追加（原地 mutation）→ 自动滚到底（#400 验收①第三场景）', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(892)
    const m = reactive(newMsg('assistant')) // 流式占位：reactive 包装贴近真实 store（Pinia 内消息是 reactive 对象）
    await w.setProps({ messages: [m] }) // 初始渲染
    await tick()
    spyRaf()
    m.raw += '你' // 等价 handleText 的 last.raw 原地追加（对象身份不变，raw 字段变化）
    m.text = m.raw
    await nextTick() // layoutWatch 快照变化 → 调度 rAF
    expect(rafSpy).toHaveBeenCalledTimes(1)
    await tick()
    expect(stream.scrollTop).toBe(900) // 流式增量也滚到底
  })

  it('一帧内多次增量合并滚一次（rAF 节流不抖动）', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(892)
    const m = reactive(newMsg('assistant'))
    await w.setProps({ messages: [m] })
    await tick()
    spyRaf()
    // 同帧三次原地追加（等价流式逐字 delta 高频到达）
    m.raw += 'a'
    m.text = m.raw
    await nextTick()
    m.raw += 'b'
    m.text = m.raw
    await nextTick()
    m.raw += 'c'
    m.text = m.raw
    await nextTick()
    expect(rafSpy).toHaveBeenCalledTimes(1) // 一帧只调度一次
    await tick()
    expect(stream.scrollTop).toBe(900)
  })

  it('正文等长替换不创建完整文本快照或触发滚动', async () => {
    vi.useFakeTimers()
    const m = reactive(newMsg('assistant', '旧字'))
    const w = mountStream({ messages: [m] })
    stubGeometry()
    userScrollTo(892)
    await tick()
    spyRaf()
    m.raw = '新字'
    m.text = m.raw
    await nextTick()
    expect(rafSpy).not.toHaveBeenCalled()
    w.unmount()
  })

  it('上滚离开底部 → 新内容不抢滚动条', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(892) // 底部 → 跟随
    await tick() // 初始在底部，无内容变化不滚动
    userScrollTo(500) // 上滚回看历史（距底 400 > 阈值）→ stickyBottom=false
    spyRaf()
    await w.setProps({ messages: [newMsg('assistant', '新回答')] })
    expect(rafSpy).not.toHaveBeenCalled() // 不调度滚动
    await tick()
    expect(stream.scrollTop).toBe(500) // 滚动条不被抢走
  })

  it('#517: 上滚后非消息状态更新不误报“有新消息”', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(500)
    // 非消息内容的状态更新（历史加载态翻转）——不改变 messages，不应触发「有新消息」
    await w.setProps({ historyLoading: true })
    await tick()
    expect(w.find('[data-test="jump-bottom"]').text()).toBe('回到底部')
  })

  it('回到底部后恢复自动跟随', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    stubGeometry()
    userScrollTo(892)
    await tick()
    userScrollTo(500) // 上滚 → 不抢
    await w.setProps({ messages: [newMsg('assistant', '回看')] })
    await tick()
    userScrollTo(892) // 回到底部 → 恢复跟随
    spyRaf()
    await w.setProps({ messages: [newMsg('assistant', '继续')] })
    await tick()
    expect(stream.scrollTop).toBe(900) // 滚到底 = scrollHeight - clientHeight（浏览器 clamp 后真实位置）
  })

  it('内容不足一屏（无滚动余地）→ 始终跟随', async () => {
    vi.useFakeTimers()
    const w = mountStream()
    // 真实浏览器 scrollHeight ≥ clientHeight 恒成立：内容不足一屏时 scrollHeight=clientHeight
    stubGeometry(100) // scrollHeight = clientHeight = 100（无可滚空间）
    userScrollTo(0) // 距底 0 < 阈值 → 跟随
    spyRaf()
    await w.setProps({ messages: [newMsg('assistant', '短内容')] })
    expect(rafSpy).toHaveBeenCalledTimes(1)
    await tick()
    expect(stream.scrollTop).toBe(0) // 无内容可滚，scrollTop 恒 0（赋值被浏览器 clamp）
  })
})

// ---- 消息锚点导航（issue #669 / #667 spec）：AnchorRail 刻度轨哑组件 ----
describe('AnchorRail（锚点刻度轨，props-in/emits-out 哑组件）', () => {
  const anchors = [
    { index: 0, ratio: 0, summary: '第一条输入' },
    { index: 2, ratio: 0.5, summary: '中间那条输入，比较长会被截断…' },
    { index: 5, ratio: 1, summary: '[图片]' },
  ]
  const baseProps = { anchors, activeIndex: -1, railHeight: 400 }

  it('刻度数 = anchors 数；top 按比例分布；aria-label 带摘要', () => {
    const w = mount(AnchorRail, { props: baseProps })
    const dots = w.findAll('[data-test^="anchor-dot-"]')
    expect(dots).toHaveLength(3)
    expect(dots[0].attributes('style')).toContain('top: 0%')
    expect(dots[1].attributes('style')).toContain('top: 50%')
    expect(dots[2].attributes('style')).toContain('top: 100%')
    expect(dots[0].attributes('aria-label')).toBe('第一条输入')
  })

  it('轨高 = 宿主注入的 railHeight（sticky 0 高占位包含块不可用 %，须显式 px）', () => {
    const w = mount(AnchorRail, { props: { ...baseProps, railHeight: 480 } })
    expect(w.get('[data-test="anchor-rail"]').attributes('style')).toContain('height: 480px')
  })

  it('hover 刻度 → 显示摘要 tooltip；移出 → 隐藏', async () => {
    const w = mount(AnchorRail, { props: baseProps })
    expect(w.find('[data-test="anchor-tip-5"]').exists()).toBe(false)
    await w.find('[data-test="anchor-dot-5"]').trigger('mouseenter')
    expect(w.find('[data-test="anchor-tip-5"]').text()).toBe('[图片]')
    await w.find('[data-test="anchor-dot-5"]').trigger('mouseleave')
    expect(w.find('[data-test="anchor-tip-5"]').exists()).toBe(false)
  })

  it('点击刻度 → emits jump 带锚定消息下标', async () => {
    const w = mount(AnchorRail, { props: baseProps })
    await w.find('[data-test="anchor-dot-5"]').trigger('click')
    expect(w.emitted('jump')?.[0]).toEqual([5])
  })

  it('activeIndex 匹配的刻度有 active 态（scrollspy 指示）', () => {
    const w = mount(AnchorRail, { props: { ...baseProps, activeIndex: 1 } })
    expect(w.find('[data-test="anchor-dot-0"]').classes()).not.toContain('active')
    expect(w.find('[data-test="anchor-dot-2"]').classes()).toContain('active')
    expect(w.find('[data-test="anchor-dot-5"]').classes()).not.toContain('active')
  })

  it('无锚点 → 轨不渲染', () => {
    const w = mount(AnchorRail, { props: { ...baseProps, anchors: [] } })
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(false)
  })
})

// ---- 消息锚点导航（issue #669 / #667 spec）：ChatStream 宿主接线（DOM 度量注入）----
describe('ChatStream 锚点导航接线（issue #669）', () => {
  // jsdom 无布局：stream 滚动几何 + 每条消息 offsetTop 全部 stub 注入（贴上方范式 B 测试模式）。
  let stream: HTMLElement
  let maxScroll = 0
  let scrollTopValue = 0

  function stubStreamGeometry(height = 1000, clientHeight = 100) {
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: height })
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: clientHeight })
    maxScroll = height - clientHeight
    Object.defineProperty(stream, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = Math.min(Math.max(v, 0), maxScroll)
        stream.dispatchEvent(new Event('scroll')) // 真实浏览器赋值触发 scroll 事件
      },
    })
  }

  // stub 指定消息下标的 offsetTop（度量为相对滚动文档顶部的布局位置）
  function stubMsgOffsets(w: Awaited<ReturnType<typeof mount>>, offsets: Record<number, number>) {
    for (const [index, top] of Object.entries(offsets)) {
      const node = w.get(`[data-index="${index}"]`).element as HTMLElement
      Object.defineProperty(node, 'offsetTop', { configurable: true, value: top })
    }
  }

  const U = (text: string) => newMsg('user', text)
  const A = (text: string) => {
    const m = newMsg('assistant', text)
    m.streaming = false
    return m
  }

  it('刻度数 = user 消息数（assistant 不进轨）；轨挂在 stream 内', async () => {
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry()
    await w.setProps({ messages: [U('一'), A('答'), U('二'), A('答'), U('三')] })
    await nextTick()
    // 刻度按消息下标命名（anchor-dot-<msgIndex>）：1、3 缺席 = assistant 不进轨
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-0"]').exists()).toBe(true)
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-1"]').exists()).toBe(false)
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-2"]').exists()).toBe(true)
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-3"]').exists()).toBe(false)
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-4"]').exists()).toBe(true)
  })

  it('无 user 消息 → 轨不渲染', async () => {
    const w = mount(ChatStream, {
      props: { messages: [A('只有回答')], historyHasMore: false, historyLoading: false },
    })
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(false)
  })

  it('刻度按消息 offsetTop 比例分布（DOM 度量注入）', async () => {
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry() // maxScroll = 900
    const msgs = [U('顶'), A('长回答'), U('中'), A('长回答'), U('底')]
    await w.setProps({ messages: msgs })
    await nextTick()
    stubMsgOffsets(w, { 0: 0, 2: 450, 4: 900 })
    await w.setProps({ messages: [...msgs] }) // 新引用触发重测
    await nextTick()
    expect(w.get('[data-test="anchor-dot-0"]').attributes('style')).toContain('top: 0%')
    expect(w.get('[data-test="anchor-dot-2"]').attributes('style')).toContain('top: 50%')
    expect(w.get('[data-test="anchor-dot-4"]').attributes('style')).toContain('top: 100%')
  })

  it('hover 刻度 → 摘要文本（前几十字截断 / 纯媒体占位）', async () => {
    const long = '长'.repeat(50)
    const media = U('')
    media.media.push({ type: 'image', mimeType: 'image/png', src: 'AA==' })
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry()
    await w.setProps({ messages: [U(long), A('答'), media] })
    await nextTick()
    await w.find('[data-test="anchor-dot-0"]').trigger('mouseenter')
    expect(w.get('[data-test="anchor-tip-0"]').text()).toBe('长'.repeat(40) + '…')
    await w.find('[data-test="anchor-dot-2"]').trigger('mouseenter')
    expect(w.get('[data-test="anchor-tip-2"]').text()).toBe('[图片]')
  })

  it('点击刻度 → 滚动定位到目标消息 + 目标高亮渐隐', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatStream, {
        props: { messages: [], historyHasMore: false, historyLoading: false },
      })
      stream = w.get('[data-test="stream"]').element as HTMLElement
      stubStreamGeometry()
      const msgs = [U('一'), A('答'), U('二')]
      await w.setProps({ messages: msgs })
      await nextTick()
      stubMsgOffsets(w, { 0: 0, 2: 900 })
      await w.setProps({ messages: [...msgs] })
      await nextTick()
      scrollTopValue = 0
      await w.get('[data-test="anchor-dot-2"]').trigger('click')
      // 程序性滚动定位到目标消息 offsetTop（经 scroll 事件自然落范式 B 语义）
      expect(scrollTopValue).toBe(900)
      // 目标消息高亮
      expect(w.get('[data-index="2"]').classes()).toContain('anchor-flash')
      // 1–2s 渐隐：class 移除
      vi.advanceTimersByTime(2_100)
      await nextTick()
      expect(w.find('[data-index="2"]').classes()).not.toContain('anchor-flash')
    } finally {
      vi.useRealTimers()
    }
  })

  // 范式 B 语义保持（#667）：跳转到中部锚点属程序性滚动，经 scroll 事件自然落 stickyBottom=false
  // → 后续流式追加不抢滚动条（上滚让位），无须新逻辑。
  it('跳转到中部锚点 → 上滚让位：流式追加不抢滚动条', async () => {
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry() // scrollHeight=1000、clientHeight=100（maxScroll=900）
    const msgs = [U('顶'), A('长回答'), U('中')]
    await w.setProps({ messages: msgs })
    await nextTick()
    stubMsgOffsets(w, { 0: 0, 2: 450 })
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    scrollTopValue = 900 // 从底部起跳（stickyBottom=true）
    stream.dispatchEvent(new Event('scroll'))
    await w.get('[data-test="anchor-dot-2"]').trigger('click')
    expect(scrollTopValue).toBe(450) // 定位到中部锚点
    expect(scrollTopValue - maxScroll).toBe(-450) // 距底 450 > 阈值
    // 追加流式新消息（底部有新内容）→ 范式 B 让位：不自动滚底
    await w.setProps({ messages: [...msgs, A('新回答')] })
    await nextTick()
    expect(scrollTopValue).toBe(450)
  })

  it('内容不足一屏（无滚动空间）→ 轨隐藏', async () => {
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry(400, 800) // scrollHeight < clientHeight：一屏全见，无需导航
    await w.setProps({ messages: [U('短内容'), A('答')] })
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(false)
  })

  it('scrollspy：滚动时刻度指示当前位置（active 刻度）', async () => {
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry() // maxScroll=900；刻度 [0, .5, 1]
    const msgs = [U('顶'), A('答'), U('中'), A('答'), U('底')]
    await w.setProps({ messages: msgs })
    await nextTick()
    stubMsgOffsets(w, { 0: 0, 2: 450, 4: 900 })
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    scrollTopValue = 810 // indicator = .9 → 最近刻度 1（index=4 消息）
    stream.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(w.get('[data-test="anchor-dot-4"]').classes()).toContain('active')
    scrollTopValue = 90 // indicator = .1 → 最近刻度 0（index=0 消息）
    stream.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(w.get('[data-test="anchor-dot-0"]').classes()).toContain('active')
    expect(w.get('[data-test="anchor-dot-4"]').classes()).not.toContain('active')
  })

  it('「加载更多」后锚点增长（prepend 消息 → 刻度重测）', async () => {
    const initial = [U('已有'), A('答')]
    const w = mount(ChatStream, {
      props: { messages: initial, historyHasMore: true, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry()
    await w.setProps({ messages: [...initial] }) // 新引用触发重测（jsdom 度量注入后）
    await nextTick()
    expect(w.find('[data-test="anchor-dot-0"]').exists()).toBe(true)
    expect(w.find('[data-test="anchor-dot-2"]').exists()).toBe(false)
    // 加载更多：更旧消息 prepend 到头部
    await w.setProps({ messages: [U('更旧'), U('旧'), A('答'), U('已有'), A('答')] })
    await nextTick()
    expect(w.find('[data-test="anchor-dot-0"]').exists()).toBe(true)
    expect(w.find('[data-test="anchor-dot-1"]').exists()).toBe(true)
    expect(w.find('[data-test="anchor-dot-3"]').exists()).toBe(true)
  })

  it('切会话/容器（messages 清空）→ 轨重置消失', async () => {
    const initial = [U('一'), A('答')]
    const w = mount(ChatStream, {
      props: { messages: initial, historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry()
    await w.setProps({ messages: [...initial] }) // 新引用触发重测（jsdom 度量注入后）
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(true)
    await w.setProps({ messages: [] })
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(false)
  })
})

// ---- #667 收口：容器尺寸变化（面板拖宽/折叠/弹出、窗口 resize）后锚点几何重测 ----
describe('ChatStream 锚点导航 —— 容器尺寸变化重测（#667 收口）', () => {
  // jsdom 无 ResizeObserver：注入可控替身，手动派发尺寸变化（真浏览器由布局驱动）。
  class StubResizeObserver {
    static instances: StubResizeObserver[] = []
    observed: Element[] = []
    disconnected = false
    private readonly callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      StubResizeObserver.instances.push(this)
    }
    observe(el: Element): void { this.observed.push(el) }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true }
    fire(): void {
      this.callback([], this as unknown as ResizeObserver)
    }
  }

  let stream: HTMLElement
  let scrollTopValue = 0

  function stubStreamGeometry(height: number, clientHeight: number) {
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: height })
    Object.defineProperty(stream, 'clientHeight', { configurable: true, value: clientHeight })
    Object.defineProperty(stream, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (v: number) => { scrollTopValue = v },
    })
  }

  function stubMsgOffsets(w: Awaited<ReturnType<typeof mount>>, offsets: Record<number, number>) {
    for (const [index, top] of Object.entries(offsets)) {
      const node = w.get(`[data-index="${index}"]`).element as HTMLElement
      Object.defineProperty(node, 'offsetTop', { configurable: true, value: top })
    }
  }

  const U = (text: string) => newMsg('user', text)
  const A = (text: string) => {
    const m = newMsg('assistant', text)
    m.streaming = false
    return m
  }

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    StubResizeObserver.instances = []
    window.innerWidth = 1024
  })

  it('拖宽/弹出改变容器尺寸 → 锚点比例与 railHeight 重测（不经 messages 变化）', async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    const msgs = [U('顶'), A('答'), U('中'), A('答'), U('底')]
    const w = mount(ChatStream, {
      props: { messages: [], historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry(1000, 100)
    await w.setProps({ messages: msgs })
    await nextTick()
    stubMsgOffsets(w, { 0: 0, 2: 450, 4: 900 })
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    expect(w.get('[data-test="anchor-dot-2"]').attributes('style')).toContain('top: 50%')

    const ro = StubResizeObserver.instances[0]
    expect(ro.observed).toHaveLength(1) // 观察的是 .stream 滚动容器

    // 面板拖宽 → 消息换行重排：容器与消息布局位置全变，但 messages 引用不变（无 props 更新）
    // （比例分母是可滚距离 scrollHeight-clientHeight = 1600，非 scrollHeight）
    stubStreamGeometry(2000, 400)
    stubMsgOffsets(w, { 0: 0, 2: 800, 4: 1600 })
    ro.fire()
    await nextTick()
    expect(w.get('[data-test="anchor-dot-0"]').attributes('style')).toContain('top: 0%')
    expect(w.get('[data-test="anchor-dot-2"]').attributes('style')).toContain('top: 50%') // 800/1600
    expect(w.get('[data-test="anchor-dot-4"]').attributes('style')).toContain('top: 100%') // 1600/1600
  })

  it('容器缩到不可滚（弹出浮层压窄等）→ 轨随重测隐藏', async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    const msgs = [U('一'), A('答')]
    const w = mount(ChatStream, {
      props: { messages: msgs, historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry(1000, 100)
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(true)

    stubStreamGeometry(400, 800) // scrollHeight < clientHeight：一屏全见
    StubResizeObserver.instances[0].fire()
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(false)
  })

  it('卸载时断开观察，不留残留监听', async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    const w = mount(ChatStream, {
      props: { messages: [U('一')], historyHasMore: false, historyLoading: false },
    })
    const ro = StubResizeObserver.instances[0]
    expect(ro.disconnected).toBe(false)
    w.unmount()
    expect(ro.disconnected).toBe(true)
  })

  it('环境无 ResizeObserver（jsdom 默认）时不抛，锚点导航照常工作', async () => {
    const msgs = [U('一'), A('答')]
    const w = mount(ChatStream, {
      props: { messages: msgs, historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry(1000, 100)
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    expect(w.find('[data-test="anchor-rail"]').exists()).toBe(true)
  })

  it('窄屏 (<720px) 三态禁用但锚点轨照常保留（#667：窄屏不降级导航）', async () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    window.innerWidth = 500
    const msgs = [U('一'), A('答'), U('二')]
    const w = mount(ChatStream, {
      props: { messages: msgs, historyHasMore: false, historyLoading: false },
    })
    stream = w.get('[data-test="stream"]').element as HTMLElement
    stubStreamGeometry(1000, 100)
    await w.setProps({ messages: [...msgs] })
    await nextTick()
    expect(w.find('[data-test="stream"] [data-test="anchor-rail"]').exists()).toBe(true)
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-0"]').exists()).toBe(true)
  })
})
