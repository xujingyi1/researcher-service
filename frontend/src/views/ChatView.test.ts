// seam: ChatView 对话页 —— issue #41 前端（spec §9.4）+ #369 M5 隧道接线。
// 覆盖：mount 拉容器 → bootstrap-token → 建 GatewayChat → listSessions/history、发送后流式逐字 +
// 光标 + done 收尾、error 帧错误条、断线提示、审批卡、工具行、thinking 剥离、历史分页、4401 刷新重建。
// mock @/chat/gatewayChat（createGatewayChat → 可控 MockGatewayChat），触发 onReady/onFrame/onClose。

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({ listInstances: vi.fn() }))
vi.mock('@/api/chat', () => ({ getBootstrapToken: vi.fn() }))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

type MockHandlers = {
  onReady: () => void
  onFrame: (frame: unknown) => void
  onClose: (code: number, reason: string, retry: boolean, pairingRequired?: boolean) => void
  onError: (message: string) => void
}

const { MockGatewayChat } = vi.hoisted(() => {
  class MockGatewayChat {
    static last: MockGatewayChat | null = null
    static instances: MockGatewayChat[] = []
    handlers: MockHandlers
    listSessions = vi.fn()
    createSession = vi.fn()
    deleteSession = vi.fn()
    getHistory = vi.fn()
    send = vi.fn()
    listCommands = vi.fn()
    resolveApproval = vi.fn()
    listPendingApprovals = vi.fn() // B0: 审批补拉（切页/断线恢复）
    start = vi.fn()
    stop = vi.fn()
    closeSocket = vi.fn() // P1-5: 连接期超时兜底主动关隧道
    constructor(handlers: MockHandlers) {
      this.handlers = handlers
      MockGatewayChat.instances.push(this)
      MockGatewayChat.last = this
    }
    fireReady(): void {
      this.handlers.onReady()
    }
    fireFrame(frame: unknown): void {
      this.handlers.onFrame(frame)
    }
    fireClose(code: number, reason = '', retry = true, pairingRequired?: boolean): void {
      this.handlers.onClose(code, reason, retry, pairingRequired)
    }
    fireError(message: string): void {
      this.handlers.onError(message)
    }
  }
  return { MockGatewayChat }
})

vi.mock('@/chat/gatewayChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/chat/gatewayChat')>()
  return {
    ...actual, // #564: createRequestId 保留真实实现（useChatConnection 生成 outbox 幂等 id 用）
    createGatewayChat: vi.fn(),
  }
})

// #459-T2 #463：mock 采集层（压缩/文件转换）——真实压缩由 chat/attachments.test.ts 覆盖，
// 本 seam 只断言「采集结果 → 预览条 → buildAttachments 校验 → chat.send payload」的宿主编排。
// compressImageFile/fileToRawAttachment 返回固定 RawAttachment；buildAttachments 用真实实现（纯函数）。
vi.mock('@/chat/attachments', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    compressImageFile: vi.fn(),
    fileToRawAttachment: vi.fn(),
  }
})

import ChatView from '@/views/ChatView.vue'
import { listInstances } from '@/api/containers'
import { getBootstrapToken } from '@/api/chat'
import { createGatewayChat } from '@/chat/gatewayChat'
import { compressImageFile, fileToRawAttachment, MAX_ATTACHMENT_BYTES } from '@/chat/attachments'
import { createOutboxStore, OUTBOX_STORAGE_KEY_PREFIX } from '@/chat/outboxStore'
import { useChatStore } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/client'
import { ElMessage, ElMessageBox } from 'element-plus'

const INSTANCE = {
  name: 'demo', port: 19000, status: 'running', health: 'healthy',
  image: 'i', container_id: 'c', created_at: '', pairing: { status: 'unpaired' },
}
const OTHER_INSTANCE = {
  name: 'other', port: 19001, status: 'running', health: 'healthy',
  image: 'i', container_id: 'd', created_at: '', pairing: { status: 'unpaired' },
}
const SESSION = { session_key: 'sk-1', title: '文献综述', updated_at: '' }

// 挂载 ChatView 并完成首连：listInstances → selectContainer → bootstrap-token → createGatewayChat →
// fireReady（openGateway 就绪）→ listSessions → loadHistory。返回当前 gateway 供触发事件。
async function mountReady() {
  const w = mount(ChatView)
  await flushPromises() // listInstances → selectContainer → getBootstrapToken → createGatewayChat + start
  const gw = MockGatewayChat.last!
  gw.listSessions.mockResolvedValue([SESSION])
  gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
  gw.createSession.mockResolvedValue('sk-new')
  gw.listCommands.mockResolvedValue([])
  gw.send.mockResolvedValue(undefined)
  gw.deleteSession.mockResolvedValue(undefined)
  gw.resolveApproval.mockResolvedValue(undefined)
  gw.listPendingApprovals.mockResolvedValue([]) // B0: 缺省无待补拉审批
  gw.fireReady() // openGateway 连接就绪
  await flushPromises() // selectContainer 续 listSessions + loadHistory
  return { w, gw }
}

describe('ChatView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockGatewayChat.instances = []
    MockGatewayChat.last = null
    vi.clearAllMocks()
    useAuthStore().$patch({ token: 'jwt-test' })
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([INSTANCE, OTHER_INSTANCE])
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockResolvedValue('boot-1')
    ;(createGatewayChat as ReturnType<typeof vi.fn>).mockImplementation(
      (params: { handlers: MockHandlers }) => new MockGatewayChat(params.handlers),
    )
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    // #459-T2 #463：采集 mock 默认——图片压缩回固定小附件（dataURL content），文件转换回 dataURL。
    ;(compressImageFile as ReturnType<typeof vi.fn>).mockImplementation(async (f: File) => ({
      type: 'image',
      mimeType: 'image/jpeg',
      fileName: f.name,
      content: 'data:image/jpeg;base64,compressed',
      sizeBytes: 100,
      width: 1280,
      height: 720,
    }))
    ;(fileToRawAttachment as ReturnType<typeof vi.fn>).mockImplementation(async (f: File) => ({
      type: f.type.split('/')[0],
      mimeType: f.type,
      fileName: f.name,
      content: `data:${f.type};base64,raw`,
      sizeBytes: f.size,
    }))
    // #564: outbox 走真实 sessionStorage（不 mock）——各用例残留的待发项互不串扰
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mount 拉容器 → bootstrap-token → 建隧道 gateway → listSessions 渲染会话', async () => {
    const { w, gw } = await mountReady()
    expect(getBootstrapToken).toHaveBeenCalledWith('demo')
    expect(createGatewayChat).toHaveBeenCalledTimes(1)
    const params = (createGatewayChat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.container).toBe('demo')
    expect(params.jwt).toBe('jwt-test')
    expect(params.bootstrapToken).toBe('boot-1')
    expect(gw.listSessions).toHaveBeenCalled()
    expect(gw.start).toHaveBeenCalledTimes(1)
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('发送消息 → 流式 text 逐字 + 光标 → done 收尾', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('你好')
    await w.find('[data-test="send"]').trigger('click')
    // #564: send 第 4 参 = outbox 幂等 id（32-hex，兼作重发去重 key）
    expect(gw.send).toHaveBeenCalledWith('sk-1', '你好', undefined, expect.any(String))
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    expect(w.find('.cursor').exists()).toBe(true)
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false)
  })

  it('输入法组词 Enter 不发送；Safari 229 不发送；Shift+Enter 换行；普通 Enter 仍发送', async () => {
    const { w, gw } = await mountReady()
    const input = w.find('[data-test="input"]')
    await input.setValue('你好')

    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 })
    expect(gw.send).not.toHaveBeenCalled()

    await input.trigger('keydown', { key: 'Enter' })
    expect(gw.send).toHaveBeenCalledWith('sk-1', '你好', undefined, expect.any(String))
  })

  it('斜杠菜单开启时，输入法组词 Enter 不选择命令也不发送', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listCommands.mockResolvedValue([
      { name: 'model', description: '切换模型', aliases: ['/model'] },
    ])
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()

    const input = w.find('[data-test="input"]')
    await input.setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)

    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect((input.element as HTMLTextAreaElement).value).toBe('/m')
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
    expect(gw.send).not.toHaveBeenCalled()
  })

  it('error 帧（消费者级，无 runId）→ 错误条', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'error', message: '模型超时' })
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('模型超时')
  })

  it('F8: 空闲时外来 run 的 error 不显示、不动占位（防误伤用户 run）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来 run 失败' })
    await nextTick()
    expect(w.find('[data-test="error-bar"]').exists()).toBe(false)
    // 用户发送正常：占位不受影响
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回复')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('F8: pendingSend 期间外来 run 的 error 不终结占位/清 flag（用户 run 首帧仍正常）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 在途（pendingSend=true，首帧未到）：外来 run 的 error → 只显示错误，不终结占位
    gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来 run 失败' })
    await nextTick()
    // 用户 run 首帧到达 → 正常 claim 并 append（若 flag 被清/占位被终结，此处会丢）
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('真实回复')
    expect(streamText).toContain('我的问题')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false) // done 收尾，光标消失
  })

  it('F7: 空闲期外来 run 首帧被记录，其续帧（用户 send 后）不劫持用户 run', async () => {
    const { w, gw } = await mountReady()
    // 空闲：外来 run 首帧 → 不渲染、runId 被记录
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '外来文本' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('外来文本')
    // 用户发送 → 在途
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来 run 续帧先到（用户 run 首帧之前）→ 按 runId 丢弃，不抢占 activeRunId
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '（外来追加）' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('（外来追加）')
    // 用户 run 首帧 → 正常 claim
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('真实回复')
    expect(streamText).toContain('我的问题')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  // ---- #569: 外来可见 final 局部插入 history（非整段重拉）----
  it('#569: 外来 run 可见 final → 尾部局部插入一条助手消息（不调 loadHistory）', async () => {
    const { w, gw } = await mountReady()
    // 空闲期外来 run 首帧 → foreignRunIds 记录
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await nextTick()
    // 外来 run 可见 final（带权威 message）→ 局部插入助手消息（尾部 push，不重拉历史）
    gw.fireFrame({
      type: 'done',
      runId: 'foreign-1',
      message: { role: 'assistant', content: [{ type: 'text', text: '子代理结果' }] },
    })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('子代理结果')
    // 不重拉 history：getHistory 仅首连 loadHistory 被调一次（historyGen 不自增、无二次 RPC）
    expect(gw.getHistory).toHaveBeenCalledTimes(1)
    // 在途 turn 不受影响：用户发送正常渲染（外来插入是独立一条，不占用/不污染 active 气泡）
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('真实回复')
    expect(streamText).toContain('我的问题')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('#569: 外来 run 空 final（无实质内容）→ 维持丢弃（不插入空气泡）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await nextTick()
    const before = w.find('[data-test="stream"]').text()
    gw.fireFrame({ type: 'done', runId: 'foreign-1', message: { role: 'assistant', content: [] } })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toBe(before)
    // 无 message（现状 done 帧形状）同样维持丢弃
    gw.fireFrame({ type: 'text', runId: 'foreign-2', delta: '' })
    gw.fireFrame({ type: 'done', runId: 'foreign-2' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toBe(before)
  })

  // #569 §3 网 2: 重放只插一次——foreignRunIds 终态清理的天然一次性（同一外来 runId 的 done 二次
  // 到达：首次插入后记录已删，二次走不到 foreign 分支，不重复插入）。跨事件重放（resume 重放）
  // 由翻译层 #560 isReplayedFinal 网 1 拦截（gatewayChat.test.ts 接线实证），composable 层无法
  // 模拟（mock seam 无翻译层），本用例实证网 2 兜底。
  it('#569: 同一外来 run 的 done 二次到达（重放）→ 只插入一次', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await nextTick()
    const msg = { role: 'assistant', content: [{ type: 'text', text: '子代理结果' }] }
    gw.fireFrame({ type: 'done', runId: 'foreign-1', message: msg })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('子代理结果')
    // 二次 done（同一 runId，重放）→ 记录已删，不再插入（text 不重复）
    gw.fireFrame({ type: 'done', runId: 'foreign-1', message: msg })
    await nextTick()
    expect(w.find('[data-test="stream"]').text().match(/子代理结果/g)?.length ?? 0).toBe(1)
  })

  it('#569: 外来 run 先记录、用户 send 后在途，其可见 final 到达 → 流式 turn 继续正常收尾', async () => {
    const { w, gw } = await mountReady()
    // 空闲期外来 run 首帧 → foreignRunIds 记录
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await nextTick()
    // 用户发送 → 在途流式
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '流式回复' })
    await nextTick()
    // 在途期间外来 final 到达 → 插入独立消息（不抢占/不污染 activeRunId 气泡）
    gw.fireFrame({
      type: 'done',
      runId: 'foreign-1',
      message: { role: 'assistant', content: [{ type: 'text', text: '并行子代理结果' }] },
    })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('并行子代理结果')
    // 用户 run 继续流式收尾（未被外来插入中断）
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '继续' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('流式回复继续')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(false) // done 收尾，光标消失
  })

  it('F3: send RPC 失败 → pendingSend 复位（切会话不产生 phantom orphan，下次首帧不被吞）', async () => {
    const { w, gw } = await mountReady()
    gw.send.mockRejectedValueOnce(new Error('未配对'))
    await w.find('[data-test="input"]').setValue('第一条')
    await w.find('[data-test="send"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="error-bar"]').text()).toContain('未配对')
    // 切到新会话（abandonActiveRun）
    gw.createSession.mockResolvedValueOnce('sk-2')
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    // 第二次发送（新会话）→ 首帧不被 pendingAbandonCount 吞
    await w.find('[data-test="input"]').setValue('第二条')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r2', delta: '第二条回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('第二条回复')
  })

  it('意外断线（非 4401）→ disconnected 提示 + 禁发', async () => {
    const { w, gw } = await mountReady()
    gw.fireClose(1006)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined()
  })

  // #542 意图回归：执行状态行只报「正在干活」瞬时态，连接态归横幅独享——两行不重复同一文案。
  it('正在连接：横幅显示「正在连接…」，执行状态行不重复显示', async () => {
    const w = mount(ChatView)
    await flushPromises() // selectContainer → openGateway：connecting=true，尚未 fireReady
    expect(w.find('[data-test="connection-banner"]').exists()).toBe(true)
    expect(w.find('[data-test="connection-banner"]').text()).toContain('正在连接')
    expect(w.find('[data-test="execution-status"]').exists()).toBe(false)
    w.unmount()
  })

  it('断线：reconnect 横幅显示「连接已断开」，执行状态行不重复显示', async () => {
    const { w, gw } = await mountReady()
    gw.fireClose(1006)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').text()).toContain('连接已断开')
    expect(w.find('[data-test="execution-status"]').exists()).toBe(false)
    w.unmount()
  })

  it('新建会话 → gateway.createSession + 列表追加', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    expect(gw.createSession).toHaveBeenCalled()
    expect(w.find('[data-test="session-sk-new"]').exists()).toBe(true)
  })

  it('assistant 流式中禁用发送（防止并发 send 卡住旧消息）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: 'x' })
    await nextTick()
    expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined()
  })

  it('切容器后旧 gateway 的迟到帧不污染新会话（stale guard）', async () => {
    const { w } = await mountReady()
    const first = MockGatewayChat.last!
    // 切到另一容器：selectContainer → openGateway → 新 gateway 实例
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const second = MockGatewayChat.last!
    expect(second).not.toBe(first) // 新 gateway
    second.listSessions.mockResolvedValue([])
    second.createSession.mockResolvedValue('sk-other')
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.send.mockResolvedValue(undefined)
    second.fireReady() // 新容器连接就绪 → listSessions([]) → newSession(sk-other)
    await flushPromises()
    // 旧 gateway 的迟到 text 帧 → stale guard 丢弃（gateway !== myGw）
    first.fireFrame({ type: 'text', runId: 'old-run', delta: '旧回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('旧回答')
    first.stop()
  })

  it('切会话（newSession）后旧 run 的迟到 delta 丢弃（runId 路由）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '第一段' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('第一段')
    // 新建会话 → abandonActiveRun 标记 r1 + 清空消息
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '迟到' }) // 旧 run 迟到帧
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).not.toContain('迟到')
  })

  it('审批卡：requested → 渲染；resolve → RPC + 回执权威落定', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(true)
    await w.find('[data-test="approve-ap-1"]').trigger('click')
    expect(gw.resolveApproval).toHaveBeenCalledWith('ap-1', 'exec', 'allow-once')
    gw.fireFrame({ type: 'approvalResolved', id: 'ap-1', decision: 'allow-once' })
    await nextTick()
    // ADR 0014：resolved 卡不留痕——落定即从界面消失（dock 不再显示该卡）
    expect(w.find('[data-test="approval-ap-1"]').exists()).toBe(false)
  })

  it('审批卡未知权威 decision → 卡按终态消失（ADR 0014 不渲染「未知」标签）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-2', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    gw.fireFrame({ type: 'approvalResolved', id: 'ap-2', decision: 'expired' })
    await nextTick()
    // ADR 0014：resolved 卡不留痕——无论 decision 是否已知，落定即消失（不渲染「未知」标签）
    expect(w.find('[data-test="approval-ap-2"]').exists()).toBe(false)
  })

  it('#405-T1: subagent 审批卡唯一家在 main——subagent 会话恒空、切回 main 可见（留存不变量）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    // 会话列表初始即含 subagent 会话（#394 实测形态，sidebar 渲染 + pickSession 切会话）
    gw.listSessions.mockResolvedValue([
      SESSION,
      { session_key: 'agent:sub-agent-1:subagent:child-1', title: '', updated_at: '' },
    ])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises() // 选中 sk-1（main）+ loadHistory(空)
    // subagent 发起的审批（agentId 标识 + 归属 subagent 会话形态）
    gw.fireFrame({
      type: 'approval', id: 'ap-sub', kind: 'exec', command: 'rm -rf /tmp/x',
      sessionKey: 'agent:sub-agent-1:subagent:child-1', agentId: 'sub-1',
    })
    await nextTick()
    // main 会话选中时：subagent 卡可见（可回覆）
    expect(w.find('[data-test="approval-ap-sub"]').exists()).toBe(true)
    // 切到 subagent 会话：审批区恒空（任何卡不显示）
    await w.find('[data-test="session-agent:sub-agent-1:subagent:child-1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="approval-ap-sub"]').exists()).toBe(false)
    // 切回 main 会话：卡原位可见（留存不变量——被过滤仅渲染层隐藏）
    await w.find('[data-test="session-sk-1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="approval-ap-sub"]').exists()).toBe(true)
  })

  it('resolve RPC 失败 → 恢复该卡为 pending 可重试', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-3', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    gw.resolveApproval.mockRejectedValue(new Error('gateway down'))
    await w.find('[data-test="approve-ap-3"]').trigger('click')
    await flushPromises()
    // 恢复 pending：批准按钮重新可用
    expect(w.find('[data-test="approve-ap-3"]').attributes('disabled')).toBeUndefined()
  })

  // B0: 登出后再登录（unmount→remount）→ 重建隧道连接 + 补拉待处理审批卡。
  // 生命周期对齐 KeepAlive（App.vue）：登录态下切页走 activated/deactivated、连接保持、不 unmount；
  // 仅登出才把 ChatView 剔除缓存并 unmount → dispose 断网关。故本用例手动 w.unmount() 模拟的是
  // 「登出后再登录」的 remount——gateway 已死、store 残留 selectedContainer，必须重建连接。
  // 场景（生产实测）：exec 审批卡无人处理 → 卡 330s → 网关 stuck-session recovery abort。
  // 断连期间 WS 已断，网关 push 的 exec.approval.requested 收不到 → remount 后必须补拉，否则
  // 审批卡永远不出现、agent 卡死。
  it('B0: 登出后再登录（unmount→remount）→ 重建隧道连接 + 补拉待处理审批卡', async () => {
    const { w, gw } = await mountReady()
    // 流式中断连：发送后 agent 卡在 exec 审批（实时卡在断连前出现，unmount 后消失）
    await w.find('[data-test="input"]').setValue('录入论文')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'approval', id: 'ap-page', kind: 'exec', command: 'curl -L arxiv.pdf', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-page"]').exists()).toBe(true)
    // 登出后剔除缓存 = unmount → onBeforeUnmount dispose → gateway.stop()（网关侧断链）
    w.unmount()
    // 再登录 = remount：store 残留 selectedContainer='demo' → 必须重建连接（而非残留死连接）
    const w2 = mount(ChatView)
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    // 断言 1：连接已重建（新 GatewayChat 实例），而非残留 gw 的死连接
    expect(gw2).not.toBe(gw)
    expect(MockGatewayChat.instances).toHaveLength(2)
    // 断言 2：remount 后补拉待处理审批（断连期间网关 push 的事件收不到）
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.listPendingApprovals.mockResolvedValue([
      { type: 'approval', id: 'ap-page', kind: 'exec', command: 'curl -L arxiv.pdf', sessionKey: null },
    ])
    gw2.fireReady()
    await flushPromises()
    expect(gw2.listPendingApprovals).toHaveBeenCalled()
    // 审批卡恢复渲染（幂等去重后仍有一张可回）
    expect(w2.find('[data-test="approval-ap-page"]').exists()).toBe(true)
    w2.unmount()
  })

  // #492: 断线重连后，恢复出的待确认审批卡点击确认无响应。
  // 复现：审批卡 pending → 断线 → 手动重连（新 GatewayChat）→ 补拉恢复卡 → 点批准。
  it('#492: 断线重连后待确认审批卡可点击并正常 resolve', async () => {
    const { w, gw } = await mountReady()
    // 1. 触发工具调用确认（审批卡 pending）
    gw.fireFrame({ type: 'approval', id: 'ap-r1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-r1"]').exists()).toBe(true)
    // 2. 确认前断线
    gw.fireClose(1006, 'network', true)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    // 3. 手动重连（「重新连接」→ connect → openGateway 新建 GatewayChat）
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw)
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.resolveApproval.mockResolvedValue(undefined)
    // 4. 断线期间网关 push 的 requested 事件收不到 → 重连补拉恢复审批卡
    gw2.listPendingApprovals.mockResolvedValue([
      { type: 'approval', id: 'ap-r1', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null },
    ])
    gw2.fireReady()
    await flushPromises()
    expect(w.find('[data-test="approval-ap-r1"]').exists()).toBe(true)
    // 5. 点击确认 → 应发出 RPC 且卡落定（不得「点击无响应」）
    await w.find('[data-test="approve-ap-r1"]').trigger('click')
    expect(gw2.resolveApproval).toHaveBeenCalledWith('ap-r1', 'exec', 'allow-once')
    await flushPromises()
    gw2.fireFrame({ type: 'approvalResolved', id: 'ap-r1', decision: 'allow-once' })
    await nextTick()
    // ADR 0014：resolved 卡不留痕——落定即从界面消失
    expect(w.find('[data-test="approval-ap-r1"]').exists()).toBe(false)
    w.unmount()
  })

  // #492 变体 A：重连恢复的审批卡在断线瞬间处于 resolving（已点击、等回执）——
  // 断线后 resolved 回执事件在断线窗口丢失 → 重连后卡卡死在 resolving（按钮 disabled）。
  // 用户看到的正是「点击无响应」：卡看似 pending，但底层状态已是 resolving。
  it('#492-A: 断线时处于 resolving 的审批卡重连后不得卡死（应复位 pending 可重试）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-r2', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    // 用户点击批准 → resolving（RPC 在途未回，promise 挂起不落定——断线时 onClose 的
    // recoverPendingApprovals() 负责复位，无需 reject 句柄）
    gw.resolveApproval.mockReturnValueOnce(new Promise<void>(() => {}))
    await w.find('[data-test="approve-ap-r2"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="approve-ap-r2"]').attributes('disabled')).toBeDefined() // resolving：按钮禁用
    // 断线：回执丢失，RPC 被 stop flush-reject
    gw.fireClose(1006, 'network', true)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    // 重连 + 补拉（网关侧审批仍 pending，同 id 幂等去重）
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.resolveApproval.mockResolvedValue(undefined)
    gw2.listPendingApprovals.mockResolvedValue([
      { type: 'approval', id: 'ap-r2', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null },
    ])
    gw2.fireReady()
    await flushPromises()
    // 卡应已复位为 pending（可重试）——断线时 resolving 卡复位（onClose recoverPendingApprovals）
    expect(w.find('[data-test="approve-ap-r2"]').attributes('disabled')).toBeUndefined()
    // 再次点击 → RPC 发出 + 落定
    await w.find('[data-test="approve-ap-r2"]').trigger('click')
    expect(gw2.resolveApproval).toHaveBeenCalledWith('ap-r2', 'exec', 'allow-once')
    gw2.fireFrame({ type: 'approvalResolved', id: 'ap-r2', decision: 'allow-once' })
    await nextTick()
    // ADR 0014：resolved 卡不留痕——落定即从界面消失
    expect(w.find('[data-test="approval-ap-r2"]').exists()).toBe(false)
    w.unmount()
  })

  // #492 变体 B：断线期间审批在网关侧过期/被回收（补拉返回空），前端旧卡仍显示 pending。
  // 点击 → RPC 失败（网关 APPROVAL_NOT_FOUND 终态）→ 卡落定「已失效」+ 错误提示（不得静默无响应）。
  it('#492-B: 网关侧审批已过期（APPROVAL_NOT_FOUND）→ 卡落定失效态并提示，不再静默无响应', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-r3', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    // 断线 → 重连：审批在断线期间被网关回收（过期/他端处理）→ 补拉返回空
    gw.fireClose(1006, 'network', true)
    await nextTick()
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.listPendingApprovals.mockResolvedValue([]) // 网关侧已无此审批（过期/被处理）
    gw2.fireReady()
    await flushPromises()
    // 旧卡仍在（store 从未清除）且显示 pending 可点
    expect(w.find('[data-test="approval-ap-r3"]').exists()).toBe(true)
    expect(w.find('[data-test="approve-ap-r3"]').attributes('disabled')).toBeUndefined()
    // 点击 → RPC 被网关拒绝（审批不存在，终态错误码）
    const gwErr = new Error('approval not found')
    ;(gwErr as { code?: string }).code = 'APPROVAL_NOT_FOUND'
    gw2.resolveApproval.mockRejectedValue(gwErr)
    await w.find('[data-test="approve-ap-r3"]').trigger('click')
    await flushPromises()
    // ADR 0014：expired 卡不留痕——落定即从界面消失；错误条提示保留（不再静默无响应）
    expect(w.find('[data-test="approval-expired"]').exists()).toBe(false)
    expect(w.find('[data-test="approve-ap-r3"]').exists()).toBe(false)
    expect(w.find('[data-test="error-bar"]').text()).toContain('已失效')
    w.unmount()
  })

  // #492 根因 A：手动重连时 openGateway 失败（bootstrap-token 网络错误）——
  // openGateway 开头无条件 disconnected=false，失败路径不恢复 → UI 假活（断线条消失、按钮可点）
  // 但 gateway=null → 点击审批卡 resolveApproval 静默 no-op（`if (!gateway) return`）→「按钮无响应」。
  it('#492-C: 重连失败（bootstrap-token 错误）→ UI 保持断开态，审批卡不可点（不得假活）', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-r4', kind: 'exec', command: 'rm -rf /tmp/x', sessionKey: null })
    await nextTick()
    // 断线
    gw.fireClose(1006, 'network', true)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    // 手动重连 → bootstrap-token fetch 网络失败（Load failed）
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Load failed'))
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    // 错误条显示 Load failed
    expect(w.find('[data-test="error-bar"]').text()).toContain('Load failed')
    // 修复前：disconnected 残留 false → 断线条消失（假活）、审批按钮可点但点击静默 no-op
    // 修复后：disconnected=true → 断线条保持、审批按钮禁用（明确断开态）
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    expect(w.find('[data-test="approve-ap-r4"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('切容器清空审批卡', async () => {
    const { w, gw } = await mountReady()
    gw.fireFrame({ type: 'approval', id: 'ap-9', kind: 'exec', command: 'x', sessionKey: null })
    await nextTick()
    expect(w.find('[data-test="approval-ap-9"]').exists()).toBe(true)
    // 切到另一容器 → approvals 清空
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const second = MockGatewayChat.last!
    second.listSessions.mockResolvedValue([])
    second.createSession.mockResolvedValue('sk-other')
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.fireReady()
    await flushPromises()
    expect(w.find('[data-test="approval-ap-9"]').exists()).toBe(false)
  })

  it('工具行：start → running 行；result → done 状态', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('搜资料')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running', id: 'call-1', title: null, input: { query: '对比' }, result: null })
    await nextTick()
    expect(w.find('[data-test="tool-line"]').text()).toContain('wiki.search')
    expect(w.find('[data-test="tool-line"]').text()).toContain('⟳')
    gw.fireFrame({ type: 'tool', runId: 'r1', name: 'wiki.search', state: 'done', id: 'call-1', title: null, input: null, result: { count: 3 } })
    await nextTick()
    expect(w.find('[data-test="tool-line"]').text()).toContain('✓')
  })

  it('thinking 剥离：<thinking> 折叠卡 + 正文不含标签', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '<thinking>内心独白</thinking>回答' })
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    expect(w.find('[data-test="stream"]').text()).not.toContain('<thinking>')
  })

  // #565: 结构化 thinking 块（新版网关 message.content[] 的 type==='thinking' 块）——流式路最小覆盖：
  // 结构化块只在 replace 快照/final 的 content[] 出现，翻译层提取随 text 帧携带（thinking 字段），
  // handleText 以 ?? 覆盖内联剥离结果。思考卡流式渲染；#664 起完成轮自动折叠——done 后展开
  // 折叠条仍见思考卡（done 收尾不冲掉结构化思考：terminal 重解析只作用于内联路）。
  it('#565: 流式 replace 快照含结构化 thinking 块 → 思考卡渲染（结构化块权威覆盖）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答', replace: true, thinking: '推理过程' })
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('推理过程')
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
    // done 收尾不冲掉结构化思考：自动折叠（#664）后展开折叠条，思考卡仍在
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 已收进折叠条
    await w.find('[data-test="trace-fold"]').trigger('click') // 手动展开
    expect(w.find('[data-test="cot-card"]').text()).toContain('推理过程')
    await w.find('[data-test="trace-fold"]').trigger('click') // 再点收起（单层开合可逆）
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 轨迹收回
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true) // 条面仍在
  })

  // #565: 结构化思考跨帧存活——replace 快照帧带思考后，普通 delta 增量帧（无 thinking 字段，
  // 纯文本增量）不把思考清空（对齐内联 <thinking> 标签靠 raw 累积跨帧存活的持久性）
  it('#565: 流式 replace 快照带思考 → 后续 delta 增量帧思考保留（不被动清空）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答', replace: true, thinking: '推理' })
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '继续' }) // 普通增量：thinking=undefined
    await nextTick()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('推理')
    expect(w.find('[data-test="stream"]').text()).toContain('回答继续')
  })

  // #565: 思考只在 final 的 content[] 出现（流式 deltaText 无思考信息）→ final 文本与已发相等，
  // 翻译层经 done 帧独立通道携带思考（不经 handleText 的 raw 逻辑）；#664 起完成轮自动折叠——
  // 展开折叠条仍见思考卡（思考数据终态存活）。
  it('#565: 流式文本发完后 final 才带思考（相等场景）→ done 帧思考卡渲染', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答' }) // deltaText 流式（无思考信息）
    gw.fireFrame({ type: 'done', runId: 'r1', thinking: '最终思考' }) // final 相等 → done 帧带思考
    await nextTick()
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true) // done 自动折叠（#664）
    await w.find('[data-test="trace-fold"]').trigger('click')
    expect(w.find('[data-test="cot-card"]').text()).toContain('最终思考')
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
  })

  it('#565: 流式内联 <thinking> 标签（无结构化块）→ thinking 仍来自 splitThinking（回归逐字节不变）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('hi')
    await w.find('[data-test="send"]').trigger('click')
    // 内联标签路照旧：thinking 来自 splitThinking 剥离（无 thinking 字段的帧不覆盖）
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '<thinking>内心</thinking>回答' })
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    expect(w.find('[data-test="trace-fold"]').exists()).toBe(true) // done 自动折叠（#664）
    await w.find('[data-test="trace-fold"]').trigger('click')
    expect(w.find('[data-test="cot-card"]').text()).toContain('内心')
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
  })

  it('会话历史加载：首次与切换会话使用固定页大小并渲染历史', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION, { session_key: 'sk-2', title: '', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises() // 选中 sk-1 + loadHistory(空)
    expect(gw.getHistory).toHaveBeenLastCalledWith('sk-1', 50)
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'assistant', text: '历史回答' }],
      hasMore: false,
      nextOffset: null,
    })
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await flushPromises()
    expect(gw.getHistory).toHaveBeenLastCalledWith('sk-2', 50)
    expect(w.find('[data-test="stream"]').text()).toContain('历史回答')
  })

  it('历史分页：loadHistory 拉全后按钮不再出现；中途失败降级留 hasMore，load-more 用锚点续拉', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    // issue #535：loadHistory 现自动循环拉全——手动「加载更多」的可达入口只剩中途失败降级
    //（catch 保留已拉页 + hasMore=true）。mock：首页成功 → 第二页失败 → 续拉恢复。
    gw.getHistory
      .mockResolvedValueOnce({ messages: [{ role: 'user', text: '旧页' }], hasMore: true, nextOffset: 10 })
      .mockRejectedValueOnce(new Error('网关抖动'))
      .mockResolvedValueOnce({ messages: [{ role: 'user', text: '更旧页' }], hasMore: false, nextOffset: null })
    gw.fireReady()
    await flushPromises() // loadHistory：首页成功 + 第二页失败 → 降级铺底
    expect(w.find('[data-test="stream"]').text()).toContain('旧页') // 已拉到的页不空白
    expect(w.find('[data-test="load-more"]').exists()).toBe(true) // 降级留 hasMore → 按钮可续拉
    await w.find('[data-test="load-more"]').trigger('click')
    await flushPromises()
    expect(gw.getHistory).toHaveBeenLastCalledWith('sk-1', undefined, 10) // Codex #678 P1：锚点保留 number 类型（offset），不再 String 化
    expect(w.find('[data-test="stream"]').text()).toContain('更旧页')
  })

  it('删除会话：确认后 gateway.deleteSession + 列表移除 + 成功 toast + 空态（不自动新建）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(gw.deleteSession).toHaveBeenCalledWith('sk-1')
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(false)
    expect(ElMessage.success).toHaveBeenCalled() // 删除成功 → 醒目成功反馈（toast）
    // #461：删除当前会话（无剩余）→ 停留空聊天区（空态视图），不自动新建会话
    expect(w.find('[data-test="empty-state"]').exists()).toBe(true)
    expect(gw.createSession).not.toHaveBeenCalled()
  })

  it('删除确认文案明示「删除后不可恢复」，不含归档字样（#461）', async () => {
    const { w } = await mountReady()
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    const msg = (ElMessageBox.confirm as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toContain('不可恢复') // 明示不可恢复
    expect(msg).not.toContain('归档') // 全文无「归档」表述
    expect(msg).not.toMatch(/会先归档（可恢复）再删除/) // 旧留档误导文案已清除
  })

  it('删除失败 → 醒目错误 toast + 会话保留在列表（#461）', async () => {
    const { w, gw } = await mountReady()
    gw.deleteSession.mockRejectedValue(new Error('scope denied'))
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalled() // 失败 → 醒目 toast（替换/叠加顶部小字 bar）
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true) // 会话未被移除
  })

  it('删除当前会话（列表仍有其他会话）→ 停留空聊天区，不自动切换（#461）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION, { session_key: 'sk-2', title: '另一个', updated_at: '' }])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.deleteSession.mockResolvedValue(undefined)
    gw.resolveApproval.mockResolvedValue(undefined)
    gw.listPendingApprovals.mockResolvedValue([])
    gw.fireReady()
    await flushPromises()
    expect(w.find('[data-test="session-sk-2"]').exists()).toBe(true) // 列表有 2 个会话，选中 sk-1
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="empty-state"]').exists()).toBe(true) // 停留空聊天区
    expect(w.find('[data-test="session-sk-2"]').exists()).toBe(true) // 其他会话仍在列表
    expect(w.find('[data-test="session-sk-2"]').classes()).not.toContain('active') // 未被自动选中
    expect(gw.createSession).not.toHaveBeenCalled()
    w.unmount()
  })

  it('取消删除确认 → 不调 deleteSession、无反馈 toast', async () => {
    const { w, gw } = await mountReady()
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    await w.find('[data-test="delete-session-sk-1"]').trigger('click')
    await flushPromises()
    expect(gw.deleteSession).not.toHaveBeenCalled()
    expect(ElMessage.success).not.toHaveBeenCalled()
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('4401 close → forceRefresh 成功 → 新 token 重建 gateway', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const first = MockGatewayChat.last!
    first.listSessions.mockResolvedValue([SESSION])
    first.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    first.listCommands.mockResolvedValue([])
    first.send.mockResolvedValue(undefined)
    const auth = useAuthStore()
    vi.spyOn(auth, 'forceRefresh').mockImplementation(async () => {
      auth.token = 'jwt-refreshed'
      auth.refreshExhausted = false
    })
    first.fireReady()
    await flushPromises()
    first.fireClose(4401) // JWT 过期
    await flushPromises() // forceRefresh + openGateway
    expect(auth.forceRefresh).toHaveBeenCalled()
    expect(MockGatewayChat.last).not.toBe(first) // 已重建 gateway
    const second = MockGatewayChat.last!
    expect(second.handlers).toBeTruthy()
    // 重建后的 token 参数
    const params = (createGatewayChat as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(params.jwt).toBe('jwt-refreshed')
    // F5: 重建后 fireReady → onReady 会 syncSessions 补拉会话，需配置 mock
    second.listSessions.mockResolvedValue([SESSION])
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.send.mockResolvedValue(undefined)
    second.fireReady()
    await flushPromises()
    expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    w.unmount()
  })

  it('4401 close → refreshExhausted → 清会话跳登录，不重建', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const first = MockGatewayChat.last!
    first.listSessions.mockResolvedValue([SESSION])
    first.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    first.listCommands.mockResolvedValue([])
    first.send.mockResolvedValue(undefined)
    const auth = useAuthStore()
    vi.spyOn(auth, 'forceRefresh').mockImplementation(async () => {
      auth.refreshExhausted = true
    })
    first.fireReady()
    await flushPromises()
    const before = MockGatewayChat.instances.length
    first.fireClose(4401)
    await flushPromises()
    expect(MockGatewayChat.instances.length).toBe(before) // 未重建
    w.unmount()
  })

  it('bootstrap-token 20040（容器归属拒绝）→ 容器不可访问，不建 gateway', async () => {
    // P0 回归：真实生产路径是 apiJson 抛 ApiError(code:20040, status:200)（信封错误恒 HTTP 200）
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(20040, 'denied', 20040))
    const w = mount(ChatView)
    await flushPromises()
    expect(createGatewayChat).not.toHaveBeenCalled()
    expect(w.find('[data-test="error-bar"]').text()).toContain('容器不可访问')
  })

  it('bootstrap-token 20046（容器非 running，#13）→ 提示未运行，不建 gateway', async () => {
    ;(getBootstrapToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(200, '容器未运行', 20046),
    )
    const w = mount(ChatView)
    await flushPromises()
    expect(createGatewayChat).not.toHaveBeenCalled()
    expect(w.find('[data-test="error-bar"]').text()).toContain('未运行')
  })

  it('协议机重连成功（everConnected 后再 onReady）→ loadHistory 恢复投影', async () => {
    const { w, gw } = await mountReady()
    gw.getHistory.mockResolvedValue({
      messages: [{ role: 'assistant', text: '恢复后的历史' }],
      hasMore: false,
      nextOffset: null,
    })
    gw.fireReady() // 第二次 onReady（协议机重连成功）
    await flushPromises()
    expect(gw.getHistory).toHaveBeenCalled()
    expect(w.find('[data-test="stream"]').text()).toContain('恢复后的历史')
  })

  it('F5: 首连失败（onClose before onReady）→ 协议机重连成功 onReady → 补拉会话', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw1 = MockGatewayChat.last!
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw1.send.mockResolvedValue(undefined)
    // 首连失败：onClose(4402) 于 onReady 之前 → openGateway 决议 false、selectContainer return
    gw1.fireClose(4402)
    await flushPromises()
    expect(gw1.listSessions).not.toHaveBeenCalled() // selectContainer 未续 listSessions
    // 协议机自动重连成功：同一实例再次 onReady（everConnected=false 分支）→ 补拉会话
    gw1.fireReady()
    await flushPromises()
    expect(gw1.listSessions).toHaveBeenCalled() // F5: 重连成功补拉会话（会话加载与首连解耦）
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('F6: 首连未就绪时切容器 → 旧 openGateway 等待方被决议、新容器正常', async () => {
    const w = mount(ChatView)
    await flushPromises() // selectContainer('demo') → openGateway 挂起（未 fireReady）
    const gw1 = MockGatewayChat.last!
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    // 未 fireReady（pendingConnect 挂起）时切另一容器 → 第二次 openGateway 替换
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw1)
    expect(gw1.stop).toHaveBeenCalled() // 旧连接被替换
    // 新容器首连就绪
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
  })

  it('F12: 切容器后旧 gateway 的 listCommands 迟到 reject 不覆盖新容器命令（gen 守卫）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw1 = MockGatewayChat.last!
    let rejectOld!: (e: Error) => void
    gw1.listCommands.mockImplementation(() => new Promise((_, rej) => { rejectOld = rej }))
    gw1.listSessions.mockResolvedValue([SESSION])
    gw1.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw1.send.mockResolvedValue(undefined)
    gw1.fireReady() // 首连：loadCommands 发起（在途，未 resolve）
    await flushPromises()
    // 切到另一容器：commands 清空 → 新容器命令填充
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([{ name: 'model', description: '切换模型', aliases: ['/model'] }])
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    // 旧 gateway 的 in-flight listCommands 迟到 reject（模拟 stop flush）→ F12 守卫应丢弃
    rejectOld(new Error('gateway client stopped'))
    await flushPromises()
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-item"]').text()).toContain('/model') // 新容器命令保留
    expect(w.find('[data-test="slash-item"]').text()).not.toContain('/old')
  })

  it('命令清单：onReady 首连拉取；输入 / 弹补全菜单', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listCommands.mockResolvedValue([
      { name: 'model', description: '切换模型', aliases: ['/model', '/m'] },
    ])
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.send.mockResolvedValue(undefined)
    gw.fireReady() // 首连就绪 → loadCommands
    await flushPromises()
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-menu"]').exists()).toBe(true)
    expect(w.find('[data-test="slash-item"]').text()).toContain('/model')
  })

  it('卸载 → stop gateway', async () => {
    const { w, gw } = await mountReady()
    w.unmount()
    expect(gw.stop).toHaveBeenCalled()
  })

  // ---- 第二轮 review（B1-B5 / C1-C2 / D1-D2 / E1-E2）回归 ----

  it('B1: 切容器时 pendingAbandonCount 清零，新容器首个 run 首帧不被吞', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('问题')
    await w.find('[data-test="send"]').trigger('click')
    // 切到另一容器：abandonActiveRun() 若 pendingSend 会 ++，但 selectContainer/openGateway 清零
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw)
    gw2.listSessions.mockResolvedValue([])
    gw2.createSession.mockResolvedValue('sk-other')
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    // 新容器发送 → 首个 run 首帧不被 stale pendingAbandonCount 当孤儿吞
    await w.find('[data-test="input"]').setValue('新容器问题')
    await w.find('[data-test="send"]').trigger('click')
    gw2.fireFrame({ type: 'text', runId: 'r-new', delta: '新回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('新回复')
    gw2.fireFrame({ type: 'done', runId: 'r-new' })
  })

  it('B6: 切走再切回后，旧容器在途 run 首帧不抢新 run（未认领孤儿 → 回复不丢）', async () => {
    // 评论 #53 真实场景：demo 发送（pendingSend=true，首帧未到）→ 切 other（abandonActiveRun
    // pendingAbandonCount++，但 openGateway 清零）→ 切回 demo（新连接）→ 发送 →
    // 旧 demo run 首帧（带文本）经新连接迟到到达 → 首帧认领（!activeRunId）无 abandonedRunIds
    // 检查 → 抢走 activeRunId → 用户 B run 首帧因 claimedEmpty=false 被静默丢弃
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('A 问题')
    await w.find('[data-test="send"]').trigger('click') // pendingSend=true，首帧未到
    // 切 other（abandonActiveRun：pendingSend → pendingAbandonCount++）
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gwOther = MockGatewayChat.last!
    gwOther.listSessions.mockResolvedValue([])
    gwOther.createSession.mockResolvedValue('sk-other')
    gwOther.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gwOther.listCommands.mockResolvedValue([])
    gwOther.send.mockResolvedValue(undefined)
    gwOther.fireReady()
    await flushPromises()
    // 切回 demo：新连接（pendingAbandonCount 清零）
    await w.find('[data-test="container-demo"]').trigger('click')
    await flushPromises()
    const gwDemo2 = MockGatewayChat.last!
    expect(gwDemo2).not.toBe(gw)
    gwDemo2.listSessions.mockResolvedValue([SESSION])
    gwDemo2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gwDemo2.listCommands.mockResolvedValue([])
    gwDemo2.send.mockResolvedValue(undefined)
    gwDemo2.fireReady()
    await flushPromises()
    // demo 新发送 → pendingSend=true（新 run 语境）。send mock 返回 ack runId（#53 判别信号）
    gwDemo2.send.mockResolvedValueOnce('rB')
    await w.find('[data-test="input"]').setValue('B 问题')
    await w.find('[data-test="send"]').trigger('click')
    await flushPromises() // ack 已回 → myRunId='rB'
    // 旧 demo run 首帧（带文本）经新连接迟到到达 → runId≠ack → 外来，不得抢占 activeRunId
    gwDemo2.fireFrame({ type: 'text', runId: 'rOld', delta: '旧回复' })
    await nextTick()
    // 用户 B run 首帧 → 正常认领渲染（修复前被旧 run 抢占 → 静默丢弃）
    gwDemo2.fireFrame({ type: 'text', runId: 'rB', delta: 'B 回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('B 回复')
    gwDemo2.fireFrame({ type: 'done', runId: 'rB' })
  })

  it('B2: pendingSend 期间外来空 run 首帧先到 → 用户 run 后到切换认领（回复不丢）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来 run 首帧先到（空 delta，认领后占位仍空——如 status 预热）
    gw.fireFrame({ type: 'text', runId: 'foreign-1', delta: '' })
    await nextTick()
    // 用户 run 首帧后到 → 切换认领（先到空 run 降级外来），真实回复渲染
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('真实回复')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('B3: pendingSend 时外来 done-first 不终结用户空占位（用户 run 仍正常渲染）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来 run 首帧即终态 done（无 delta）→ 不终结占位/不清 pendingSend
    gw.fireFrame({ type: 'done', runId: 'foreign-1' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(true) // 占位仍 streaming
    // 用户 run 首帧 → 正常认领渲染（原 bug：占位被终结 + pendingSend 被清 → 首帧被当 foreign 丢）
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('真实回复')
    gw.fireFrame({ type: 'done', runId: 'user-run' })
  })

  it('B4: 宽限 fire 后迟到首帧仍认领（graceExpired，不 foreign 丢弃；F8 定时器反噬修复）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      await w.find('[data-test="input"]').setValue('问题')
      await w.find('[data-test="send"]').trigger('click')
      // 外来 error 武装宽限定时器
      gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来失败' })
      await nextTick()
      // 超宽限（8s）→ 占位落定 + graceExpired
      vi.advanceTimersByTime(8_001)
      await nextTick()
      // 慢速用户 run 首帧 >宽限才到 → 仍走认领路径渲染（原 bug：pendingSend 被清 → 当 foreign 丢）
      gw.fireFrame({ type: 'text', runId: 'user-run', delta: '慢回复' })
      await nextTick()
      expect(w.find('[data-test="stream"]').text()).toContain('慢回复')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('B4: 宽限 fire 后切会话再发送 → 无 phantom orphan（graceExpired 不清 pendingSend，首帧不被吞）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      await w.find('[data-test="input"]').setValue('问题')
      await w.find('[data-test="send"]').trigger('click')
      gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来失败' })
      await nextTick()
      vi.advanceTimersByTime(8_001) // 宽限 fire：pendingSend 清 + graceExpired
      await nextTick()
      // 切会话（abandonActiveRun：pendingSend 已清 → 不 ++）
      gw.createSession.mockResolvedValueOnce('sk-2')
      await w.find('[data-test="new-session"]').trigger('click')
      await flushPromises()
      // 新会话发送 → 首个 run 首帧不被 stale 计数吞
      await w.find('[data-test="input"]').setValue('第二条')
      await w.find('[data-test="send"]').trigger('click')
      gw.fireFrame({ type: 'text', runId: 'r2', delta: '第二条回复' })
      await nextTick()
      expect(w.find('[data-test="stream"]').text()).toContain('第二条回复')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('B5: 断线时在途 run → 重连 onReady 保留占位等 resume 续帧（不 loadHistory 清空重建）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '部分回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('部分回答')
    // 意外断线 → 记录 resumeRun（占位保留，不 abandon）
    gw.getHistory.mockClear()
    gw.fireClose(1006, 'network', true)
    await nextTick()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    // 重连成功 onReady → resumeRun 消费：不 loadHistory 清空，等续帧
    gw.fireReady()
    await flushPromises()
    expect(gw.getHistory).not.toHaveBeenCalled()
    // resume 续帧 → 继续渲染（占位复活追加）
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '续帧' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('部分回答续帧')
    gw.fireFrame({ type: 'done', runId: 'r1' })
    w.unmount()
  })

  it('B5: resume 等待超时（网关未 resume）→ 恢复为历史重建（占位清空不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      // 发送 + 首帧 → 在途流式
      await w.find('[data-test="input"]').setValue('问题')
      await w.find('[data-test="send"]').trigger('click')
      gw.fireFrame({ type: 'text', runId: 'r1', delta: '部分回答' })
      await nextTick()
      // 断线 → resumeRun 记录
      gw.getHistory.mockClear()
      gw.fireClose(1006, 'net', true)
      await nextTick()
      gw.fireReady() // onReady → armResumeWait（30s）
      await flushPromises()
      expect(gw.getHistory).not.toHaveBeenCalled()
      // 超过 resume 等待 30s → loadHistory 重建（清占位）
      gw.getHistory.mockResolvedValue({
        messages: [{ role: 'assistant', text: '历史重建' }],
        hasMore: false,
        nextOffset: null,
      })
      vi.advanceTimersByTime(30_001)
      await flushPromises()
      expect(gw.getHistory).toHaveBeenCalled()
      expect(w.find('[data-test="stream"]').text()).toContain('历史重建')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('C1: 重连后保留原选中会话（不踢回 session[0]、不丢当前 transcript）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw1 = MockGatewayChat.last!
    gw1.listSessions.mockResolvedValue([SESSION, { session_key: 'sk-2', title: '', updated_at: '' }])
    gw1.getHistory.mockResolvedValue({ messages: [{ role: 'user', text: 'sk1 历史' }], hasMore: false, nextOffset: null })
    gw1.listCommands.mockResolvedValue([])
    gw1.send.mockResolvedValue(undefined)
    gw1.fireReady()
    await flushPromises()
    // 切到 sk-2
    gw1.getHistory.mockResolvedValue({ messages: [{ role: 'user', text: 'sk2 历史' }], hasMore: false, nextOffset: null })
    await w.find('[data-test="session-sk-2"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="stream"]').text()).toContain('sk2 历史')
    // 断开 + 手动重连（openGateway 重建）
    gw1.fireClose(1006, 'net', true)
    await nextTick()
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw1)
    gw2.listSessions.mockResolvedValue([SESSION, { session_key: 'sk-2', title: '', updated_at: '' }])
    gw2.getHistory.mockImplementation(async (key: string) => ({
      messages: [{ role: 'assistant', text: `${key} 恢复` }],
      hasMore: false,
      nextOffset: null,
    }))
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    // C1: 保留 sk-2（而非踢回 sk-1）→ 恢复 sk-2 历史
    expect(w.find('[data-test="stream"]').text()).toContain('sk-2 恢复')
    expect(w.find('[data-test="stream"]').text()).not.toContain('sk1 历史')
  })

  it('C2: syncSessions 首连瞬败后自动重连 onReady 补拉会话与命令（不永久空）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.send.mockResolvedValue(undefined)
    // 首连 onReady：syncSessions 发起但 listSessions RPC 瞬败（链路断）→ 列表空
    gw.listSessions.mockRejectedValueOnce(new Error('gateway not connected'))
    gw.fireReady()
    await flushPromises()
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(false)
    // 自动重连成功（everConnected=true 分支）→ C2 补拉会话 + 命令
    gw.listSessions.mockResolvedValue([SESSION])
    gw.listCommands.mockResolvedValue([{ name: 'model', description: '切换模型', aliases: ['/model'] }])
    gw.fireReady()
    await flushPromises()
    expect(w.find('[data-test="session-sk-1"]').exists()).toBe(true)
    await w.find('[data-test="input"]').setValue('/m')
    await nextTick()
    expect(w.find('[data-test="slash-item"]').text()).toContain('/model')
  })

  it('D1: 4403 改密门 → 独立「修改密码」文案（非误导切换容器）', async () => {
    const { w, gw } = await mountReady()
    gw.fireClose(4403, 'must change password', false)
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('修改密码')
    expect(w.find('[data-test="error-bar"]').text()).not.toContain('切换容器')
  })

  it('D2: retry:false（协议机已停重连）→ 如实提示手动重连；retry:true → 自动重连中', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    gw.fireClose(1006, 'net', false) // 协议机 give-up / 未配对
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('自动重连已停止')
    expect(w.find('[data-test="error-bar"]').text()).toContain('手动重连')
    gw.fireClose(1006, 'net', true) // 退避重连中
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('自动重连中')
  })

  it('E1: 历史 assistant 消息 content 数组（ADR 0003 多态）→ 渲染文本而非空泡', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: '我的问题' },
        { role: 'assistant', content: [{ type: 'thinking', text: '内心' }, { type: 'text', text: '回答内容' }] },
      ],
      hasMore: false,
      nextOffset: null,
    })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('我的问题') // user string content
    expect(streamText).toContain('回答内容') // assistant 数组 content → 复用 extractMessageText
    expect(streamText).not.toContain('内心') // thinking 块不渲染为正文
  })

  // #565: 历史路全量覆盖——网关 history 下发完整消息，content[] 的 type==='thinking' 结构化块
  //（thinking 字段）经 extractThinking 提取填 Msg.thinking → 思考折叠卡渲染（thinking 不进正文）。
  // #666 T3：有轨迹的历史消息默认折叠——思考卡收进折叠条（条面步骤计数无「已执行」），
  // 展开折叠条后思考卡仍在（提取数据不丢）。
  it('#565: 历史 assistant 消息含结构化 thinking 块（thinking 字段）→ 思考卡渲染', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: '我的问题' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '历史推理' }, { type: 'text', text: '历史回答' }],
        },
      ],
      hasMore: false,
      nextOffset: null,
    })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    // T3（#666）：有轨迹历史轮默认折叠——条面计数「执行过程 · 思考」（无时长），正文恒在折叠外
    expect(w.get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 思考')
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 思考卡默认收进折叠条
    expect(w.find('[data-test="stream"]').text()).toContain('历史回答')
    // 展开折叠条：思考只出现在折叠卡（data-test="cot-card"），正文（stream）为提取出的 text 内容
    await w.find('[data-test="trace-fold"]').trigger('click')
    expect(w.find('[data-test="cot-card"]').exists()).toBe(true)
    expect(w.find('[data-test="cot-card"]').text()).toContain('历史推理')
  })

  // #565 回归：历史消息无结构化 thinking 块（仅 text 字段的旧 shape）→ 思考卡不出现（thinking ''，
  // 现状逐字节不变；不读 text 字段兜底——官方 extractThinking 只读 thinking 字段）
  it('#565: 历史消息无 thinking 字段的结构化块 → 不渲染思考卡（回归无差）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: '问题' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', text: '内心' }, { type: 'text', text: '回答' }],
        },
      ],
      hasMore: false,
      nextOffset: null,
    })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    expect(w.find('[data-test="cot-card"]').exists()).toBe(false) // 无思考卡（现状）
    expect(w.find('[data-test="stream"]').text()).toContain('回答')
  })

  // E1b: abort 固化的 toolCall-only assistant 消息（生产实测：exec 审批卡无人处理 → 网关
  // stuck-session recovery abort run → 最后一条 assistant content=[thinking,toolCall×3] 无 text
  // 块）→ 不得渲染空白气泡（user 消息下出现空 assistant 气泡，用户误以为回复丢失）。
  // #666 T3：有轨迹历史轮默认折叠——气泡渲染折叠条（非空白），展开后工具行（done 态）逐行可见。
  //（thinking 块用 text 字段、非官方 thinking 字段 → 不提取（#565 回归语义），计数无「思考」段）
  it('E1b: 历史 toolCall-only assistant 消息（abort 固化）→ 不渲染空白气泡', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: '能不能帮我录入一下这篇论文 https://arxiv.org/pdf/2605.20834' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '好的，我需要先下载 PDF' },
            { type: 'toolCall', id: 'call_1', name: 'wiki_search', arguments: { query: '2605.20834' } },
            { type: 'toolCall', id: 'call_2', name: 'exec', arguments: { command: 'curl -L arxiv.pdf' } },
            { type: 'toolCall', id: 'call_3', name: 'read', arguments: { path: '~/skills/ingest/SKILL.md' } },
          ],
        },
      ],
      hasMore: false,
      nextOffset: null,
    })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    const streamText = w.find('[data-test="stream"]').text()
    expect(streamText).toContain('录入一下这篇论文') // user 消息正常渲染
    // 不得渲染空白气泡：toolCall-only 消息渲染折叠条（T3 默认折叠），条面步骤计数可见
    const bubbles = w.findAll('.msg.assistant')
    expect(bubbles.length).toBe(1) // 只有一个 assistant 消息（该 toolCall-only 消息）
    expect(bubbles[0].text().trim()).not.toBe('') // 不得是空白气泡
    expect(bubbles[0].get('[data-test="trace-fold-label"]').text()).toBe('执行过程 · 3 次工具')
    expect(bubbles[0].find('[data-test="tool-line"]').exists()).toBe(false) // 工具行默认收进折叠条
    // 展开折叠条：渲染为工具行（done 态），工具名可见（agent 实际调过什么）
    await bubbles[0].find('[data-test="trace-fold"]').trigger('click')
    expect(bubbles[0].findAll('[data-test="tool-line"]')).toHaveLength(3)
    expect(bubbles[0].text()).toContain('wiki_search')
  })

  it('E2: 断线时新建会话被守卫（不裸错误、不清 transcript）', async () => {
    const w = mount(ChatView)
    await flushPromises()
    const gw = MockGatewayChat.last!
    gw.listSessions.mockResolvedValue([SESSION])
    gw.getHistory.mockResolvedValue({ messages: [{ role: 'user', text: '既有历史' }], hasMore: false, nextOffset: null })
    gw.listCommands.mockResolvedValue([])
    gw.send.mockResolvedValue(undefined)
    gw.fireReady()
    await flushPromises()
    expect(w.find('[data-test="stream"]').text()).toContain('既有历史')
    // 断线（give-up，retry:false → 不自动重连）
    gw.fireClose(1006, 'net', false)
    await nextTick()
    expect(MockGatewayChat.last).toBe(gw) // 未重建
    // 断线时新建会话 → E2 守卫：不调 createSession、transcript 保留
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    expect(gw.createSession).not.toHaveBeenCalled()
    expect(w.find('[data-test="stream"]').text()).toContain('既有历史')
  })

  it('#14: 初始连接黑洞（socket 永不 open，无 onReady/onClose 信号）→ 连接期超时解锁 UI', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises() // selectContainer → openGateway 挂起（pendingConnect 未决议）
      // 不 fireReady：黑洞连接无任何信号，openGateway 的 await ready 挂起
      await w.find('[data-test="input"]').setValue('x')
      expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined() // connecting 中禁发
      // 超过连接期超时 15s → 决议 false + 显示断开态（重新连接入口），composer 保持禁用。
      // #492：超时是建连失败出口，恢复断开态防「UI 假活可点但无响应」——重试路径是重新连接按钮
      // （旧行为解锁 composer 但发送必失败，属伪解锁）。
      vi.advanceTimersByTime(15_001)
      await flushPromises()
      expect(w.find('[data-test="error-bar"]').text()).toContain('连接建立超时')
      expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true) // 断开条：重新连接入口
      expect(w.find('[data-test="send"]').attributes('disabled')).toBeDefined() // 断开态禁发（不假活）
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- 三轮 code-review 回归（P0/P1/P2）----

  it('P1-5: 连接期超时主动关隧道触发协议机重连（不再留 CONNECTING 静默丢消息窗口）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      // 黑洞：不 fireReady。15s 超时 → 主动 closeSocket 让协议机走退避重连
      vi.advanceTimersByTime(15_001)
      await flushPromises()
      expect(gw.closeSocket).toHaveBeenCalledWith(1000, 'connect timeout')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('P1-1: 授权门 close（4401）落定流式占位（不再永久闪烁）+ 清 activeRunId（残留 runId 不吞用户回复）', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '部分' }) // 流式中
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(true) // 占位流式（闪烁光标）
    gw.fireClose(4401) // 授权门（token 过期）
    await nextTick()
    // P1-1: 授权门同样落定占位 → 光标消失（旧实现跳过 finalizeLast → 永久闪烁 + composer 禁发）
    expect(w.find('.cursor').exists()).toBe(false)
    // 重连 onReady → 用户再发送 → 首帧正常渲染（授权门已清 activeRunId，残留 runId 不吞帧）
    gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw.fireReady()
    await flushPromises()
    await w.find('[data-test="input"]').setValue('新问题')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r2', delta: '新回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('新回答')
    w.unmount()
  })

  it('P1-2: send() 的 RPC catch 有 stale-gateway 守卫（切容器后旧 gateway reject 不污染新容器）', async () => {
    const { w, gw } = await mountReady()
    // 构造 A 容器 send 在途 → 切 B 容器 → A 的 send reject → 不得对 B state finalizeLast/写错误
    const sendReject = gw.send.mockRejectedValue(new Error('old connection stopped'))
    await w.find('[data-test="input"]').setValue('hello')
    await w.find('[data-test="send"]').trigger('click')
    // 切到 other 容器（new gateway）
    await w.find('[data-test="container-other"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.fireReady()
    await flushPromises()
    // 旧 send 的 catch 触发
    await sendReject
    await nextTick()
    // B 容器 errorMsg 不得出现旧连接错误
    expect(w.find('[data-test="error-bar"]').exists()).toBe(false)
    w.unmount()
  })

  it('P1-3: 首帧未到（pendingSend 空 runId）断线 → 不武装 resume 等待（30s 后无额外 loadHistory）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      await w.find('[data-test="input"]').setValue('问题')
      await w.find('[data-test="send"]').trigger('click') // pendingSend=true, 首帧未到
      gw.getHistory.mockClear()
      gw.fireClose(1006, 'net', true) // 断线：首帧未到 → 不记录 resumeRun（P1-3）
      await flushPromises()
      expect(w.find('.cursor').exists()).toBe(false) // 孤儿占位落定（光标不闪烁）
      gw.fireReady() // 重连 onReady：无 resumeRun → 走 syncSessions（非 armResumeWait）
      await flushPromises()
      const callsAfterReady = gw.getHistory.mock.calls.length
      // 30s 后：未武装 resume 等待 → 不再触发额外 loadHistory（旧实现 {runId:''} 匹配 → 30s 后
      // 又清空一次 + 期间占位挂空）
      vi.advanceTimersByTime(30_001)
      await flushPromises()
      expect(gw.getHistory.mock.calls.length).toBe(callsAfterReady)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("P1-4: 半截 <thinking 残片（视觉空白但 raw 非空）不阻挡切换认领——用户 run 首帧不丢", async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来预热 run 首帧是截断的 <thinking 增量（splitThinking 视觉空白，raw!==''）
    gw.fireFrame({ type: 'text', runId: 'warm', delta: '<thi' })
    await nextTick()
    // 用户 run 首帧 → claimedEmpty 应按可见内容判定（text/thinking/tools 全空）→ 切换认领
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '回答' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('回答') // 不被静默丢弃
    w.unmount()
  })

  it('P1-7: 未配对容器（PAIRING_REQUIRED）→ 提示先完成配对（非通用 give-up 文案）', async () => {
    const { w } = await mountReady()
    // onClose 第四参 pairingRequired=true（gatewayChat resolveClose 从 connectFailure 详情判定）
    const gw = MockGatewayChat.last!
    gw.fireClose(4402, 'gateway down', false, true)
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('配对')
    w.unmount()
  })

  it('#376: 4402 预算超限（retry:false）→ 提示「容器网关不可用」；手动重连新建实例 → 预算内再断显示自动重连中', async () => {
    const { w, gw } = await mountReady()
    // 预算内：4402 退避重连 → UI「自动重连中…」
    gw.fireClose(4402, 'gateway down', true)
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('自动重连中')
    // 超预算 give-up（retry:false）→ 专属「容器网关不可用」提示 + 手动重连入口（区别于通用「已停止」）
    gw.fireClose(4402, 'gateway down', false)
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('容器网关不可用')
    expect(w.find('[data-test="error-bar"]').text()).not.toContain('自动重连已停止')
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true) // disconnected 条：手动重连入口
    // 手动重连（重新连接）→ openGateway 新建 GatewayChat（全新闭包 → 4402 预算重置）
    await w.find('[data-test="reconnect"]').trigger('click')
    await flushPromises()
    const gw2 = MockGatewayChat.last!
    expect(gw2).not.toBe(gw)
    gw2.listSessions.mockResolvedValue([SESSION])
    gw2.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    gw2.listCommands.mockResolvedValue([])
    gw2.send.mockResolvedValue(undefined)
    gw2.fireReady()
    await flushPromises()
    // 新实例预算内 4402 → 协议机退避重连 → 「自动重连中…」（非「不可用」）
    gw2.fireClose(4402, 'gateway down', true)
    await nextTick()
    expect(w.find('[data-test="error-bar"]').text()).toContain('自动重连中')
    w.unmount()
  })

  // ---- PR #370 第四轮 run 状态机修复（R4-5/6/7/8 + #11）----

  it('R4-8: pendingSend 期间工具优先的外来 run 首帧（tool）后，用户 run 首帧仍切换认领', async () => {
    const { w, gw } = await mountReady()
    await w.find('[data-test="input"]').setValue('我的问题')
    await w.find('[data-test="send"]').trigger('click')
    // 外来 run 首帧是 tool（agent 先调工具）→ claim 进占位，留 tool 行（无正文）
    gw.fireFrame({ type: 'tool', runId: 'foreign-1', name: 'wiki.search', state: 'running', id: 'c1', title: null, input: {}, result: null })
    await nextTick()
    // 用户 run 首帧 → 占位已有 tool 行但无正文 → claimedEmpty 应 true（不要求 tools.length===0）→ 切换认领
    gw.fireFrame({ type: 'text', runId: 'user-run', delta: '真实回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('真实回复')
    w.unmount()
  })

  it('R4-5: send RPC 超时但 run 已在流 → 不 finalize 占位（续帧不污染下次 send）', async () => {
    const { w, gw } = await mountReady()
    let rejectSend!: (e: Error) => void
    gw.send.mockReturnValueOnce(new Promise<void>((_, rej) => { rejectSend = rej }))
    await w.find('[data-test="input"]').setValue('A')
    await w.find('[data-test="send"]').trigger('click')
    // A 首帧到 → claim，A 流式（光标在）
    gw.fireFrame({ type: 'text', runId: 'rA', delta: 'A 回复' })
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(true)
    // send RPC 超时 reject（run 仍在流）→ 修复前 finalize 占位（cursor 消失）；修复后 activeRunId 非空不 finalize
    rejectSend(new Error('RPC 超时'))
    await flushPromises()
    await nextTick()
    expect(w.find('.cursor').exists()).toBe(true) // A 仍在流，不应落定
    w.unmount()
  })

  it('R4-7: 4401 断线 onClose 清 pendingSend，重连后切会话首帧不被 phantom 吞', async () => {
    const { w, gw } = await mountReady()
    const auth = useAuthStore()
    vi.spyOn(auth, 'forceRefresh').mockImplementation(async () => {
      auth.token = 'jwt-refreshed'
      auth.refreshExhausted = false
    })
    await w.find('[data-test="input"]').setValue('A')
    await w.find('[data-test="send"]').trigger('click') // 首帧未到 → pendingSend=true
    gw.fireClose(4401) // JWT 过期断线
    await flushPromises() // recoverUnauthorized → openGateway（second）
    const second = MockGatewayChat.last!
    expect(second).not.toBe(gw)
    second.listSessions.mockResolvedValue([SESSION])
    second.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
    second.listCommands.mockResolvedValue([])
    second.send.mockResolvedValue(undefined)
    second.fireReady()
    await flushPromises()
    // 重连后切新会话 → abandonActiveRun（修复前 pendingSend 泄漏 → pendingAbandonCount++）
    second.createSession.mockResolvedValueOnce('sk-2')
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    // 新会话发送首帧 → 不被 phantom pendingAbandonCount 吞
    await w.find('[data-test="input"]').setValue('B')
    await w.find('[data-test="send"]').trigger('click')
    second.fireFrame({ type: 'text', runId: 'rB', delta: 'B 回复' })
    await nextTick()
    expect(w.find('[data-test="stream"]').text()).toContain('B 回复')
    w.unmount()
  })

  it('R4-6: resume 等待超时清 activeRunId，死 run 迟到续帧不污染历史 assistant', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      await w.find('[data-test="input"]').setValue('A')
      await w.find('[data-test="send"]').trigger('click')
      gw.fireFrame({ type: 'text', runId: 'rA', delta: 'A 流式' })
      await nextTick()
      gw.fireClose(1006) // 断线 → resumeRun={runId:rA}（activeRunId 非空）
      await nextTick()
      gw.fireReady() // 重连 → armResumeWait(rA)
      await nextTick()
      // 超时 fire → loadHistory 重建（含历史 assistant）
      gw.getHistory.mockResolvedValueOnce({ messages: [{ role: 'assistant', text: '历史回复' }], hasMore: false, nextOffset: null })
      vi.advanceTimersByTime(30_001)
      await flushPromises()
      // rA 迟到续帧：修复前 activeRunId=rA 残留 → append 进历史 assistant；修复后 activeRunId 清 → foreign 丢弃
      gw.fireFrame({ type: 'text', runId: 'rA', delta: '（续）' })
      await nextTick()
      expect(w.find('[data-test="stream"]').text()).not.toContain('（续）')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('#524: 空输入框用方向键浏览当前会话历史输入并返回草稿', async () => {
    const { w, gw } = await mountReady()
    const input = w.find<HTMLTextAreaElement>('[data-test="input"]')
    await input.setValue('第一条')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回复一' })
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    await input.setValue('第二条')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r2', delta: '回复二' })
    gw.fireFrame({ type: 'done', runId: 'r2' })
    await nextTick()

    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(input.element.value).toBe('第二条')
    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(input.element.value).toBe('第一条')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.element.value).toBe('第二条')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.element.value).toBe('')
    w.unmount()
  })

  it('#11: 宽限 fire 后断线重连，首个自主 run 不被当迟到用户 run 认领（graceExpired 连接边界重置）', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      await w.find('[data-test="input"]').setValue('A')
      await w.find('[data-test="send"]').trigger('click')
      gw.fireFrame({ type: 'error', runId: 'foreign-1', message: '外来失败' }) // 武装宽限
      await nextTick()
      vi.advanceTimersByTime(8_001) // 宽限 fire：占位落定 + graceExpired=true + pendingSend=false
      await nextTick()
      gw.fireClose(1006) // 断线
      await nextTick()
      // 重连 → loadHistory 重建（含历史 assistant）；修复前 graceExpired 残留
      gw.getHistory.mockResolvedValueOnce({ messages: [{ role: 'assistant', text: '历史回复' }], hasMore: false, nextOffset: null })
      gw.fireReady()
      await flushPromises()
      // 空闲自主 run 首帧：修复前 lateClaim（!pendingSend && graceExpired）→ 复活历史 assistant + append；
      // 修复后 graceExpired 重置 → foreign 不认领
      gw.fireFrame({ type: 'text', runId: 'rAuto', delta: '自主' })
      await nextTick()
      expect(w.find('[data-test="stream"]').text()).not.toContain('自主')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- #459-T2 #463：附件采集（三通道）+ 预览条 + 发送 ----
  describe('附件采集/预览/发送（#459-T2 #463）', () => {
    // 触发粘贴（剪贴板文件）：jsdom 无 ClipboardEvent，构造 paste Event 挂 clipboardData。
    async function pasteFiles(w: Awaited<ReturnType<typeof mountReady>>['w'], files: File[]) {
      const evt = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'clipboardData', { value: { files } })
      w.find('[data-test="composer"]').element.dispatchEvent(evt)
      await flushPromises()
      await nextTick()
    }
    // 触发拖拽释放：jsdom 无 DragEvent/DataTransfer，构造 drop Event 挂 dataTransfer。
    async function dropFiles(w: Awaited<ReturnType<typeof mountReady>>['w'], files: File[]) {
      const evt = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'dataTransfer', { value: { files } })
      w.find('[data-test="composer"]').element.dispatchEvent(evt)
      await flushPromises()
      await nextTick()
    }
    // 文件选择按钮：直接驱动隐藏 file-input 的 change。
    async function chooseFiles(w: Awaited<ReturnType<typeof mountReady>>['w'], files: File[]) {
      const input = w.find('[data-test="file-input"]')
      Object.defineProperty(input.element, 'files', { value: files, configurable: true })
      await input.trigger('change')
      await flushPromises()
      await nextTick()
    }

    it('粘贴图片 → 预览条出现缩略项 + 合计状态', async () => {
      const { w } = await mountReady()
      expect(w.find('[data-test="preview-strip"]').exists()).toBe(false)
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      expect(compressImageFile).toHaveBeenCalled()
      expect(w.find('[data-test="preview-strip"]').exists()).toBe(true)
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(1)
      expect(w.find('[data-test="attach-count"]').text()).toContain('1')
    })

    it('拖拽文件到输入区 → 预览条列出（图片压缩、非图片直接转换）', async () => {
      const { w } = await mountReady()
      await dropFiles(w, [
        new File(['x'], 'shot.png', { type: 'image/png' }),
        new File(['y'], 'clip.mp4', { type: 'video/mp4' }),
      ])
      expect(compressImageFile).toHaveBeenCalledTimes(1)
      expect(fileToRawAttachment).toHaveBeenCalledTimes(1)
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(2)
      expect(w.find('[data-test="attach-count"]').text()).toContain('2')
    })

    it('文件选择按钮 → 预览条列出所选附件', async () => {
      const { w } = await mountReady()
      await chooseFiles(w, [new File(['y'], 'song.mp3', { type: 'audio/mpeg' })])
      expect(fileToRawAttachment).toHaveBeenCalled()
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(1)
    })

    it('预览条可逐个移除附件', async () => {
      const { w } = await mountReady()
      await pasteFiles(w, [
        new File(['x'], 'a.png', { type: 'image/png' }),
        new File(['x'], 'b.png', { type: 'image/png' }),
      ])
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(2)
      await w.findAll('[data-test="preview-remove"]')[0].trigger('click')
      await nextTick()
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(1)
    })

    it('发送附件消息 → chat.send payload 含 attachments 数组；发送成功后预览条清空', async () => {
      const { w, gw } = await mountReady()
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      expect(gw.send).toHaveBeenCalledWith('sk-1', '', [
        expect.objectContaining({ fileName: 'shot.png', mimeType: 'image/jpeg', type: 'image' }),
      ], expect.any(String))
      await nextTick()
      expect(w.find('[data-test="preview-strip"]').exists()).toBe(false)
    })

    it('纯图片消息（无文本）可正常发送（不依赖文本非空）', async () => {
      const { w, gw } = await mountReady()
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      // 不输入任何文本，直接发送
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      expect(gw.send).toHaveBeenCalled()
      const [, message, attachments] = gw.send.mock.calls[0]
      expect(message).toBe('')
      expect(Array.isArray(attachments)).toBe(true)
      expect(attachments.length).toBe(1)
    })

    it('非图片附件 >700KB 拒发 → 提示「文件过大」，不进 payload', async () => {
      const { w, gw } = await mountReady()
      // fileToRawAttachment 回真实大小（超 MAX_ATTACHMENT_BYTES）→ buildAttachments 拒发
      ;(fileToRawAttachment as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: 'video',
        mimeType: 'video/mp4',
        fileName: 'big.mp4',
        content: 'data:video/mp4;base64,raw',
        sizeBytes: MAX_ATTACHMENT_BYTES + 1,
      })
      await dropFiles(w, [new File(['y'], 'big.mp4', { type: 'video/mp4' })])
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      expect(gw.send).not.toHaveBeenCalled()
      expect((ElMessage.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('文件过大'),
      )
    })

    it('文本 + 附件一起发送 → payload 同帧携带 message 与 attachments', async () => {
      const { w, gw } = await mountReady()
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      await w.find('[data-test="input"]').setValue('看这张图')
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      expect(gw.send).toHaveBeenCalledWith('sk-1', '看这张图', [
        expect.objectContaining({ fileName: 'shot.png' }),
      ], expect.any(String))
    })

    it('#1 Enter 键发送也走附件管道（不绕开）：payload 含 attachments + 预览条清空', async () => {
      const { w, gw } = await mountReady()
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      await w.find('[data-test="input"]').setValue('看这张图')
      // Enter 发送（非按钮点击）——onComposerKeydown 路径
      await w.find('[data-test="input"]').trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(gw.send).toHaveBeenCalledWith('sk-1', '看这张图', [
        expect.objectContaining({ fileName: 'shot.png' }),
      ], expect.any(String))
      await nextTick()
      expect(w.find('[data-test="preview-strip"]').exists()).toBe(false)
    })

    it('#2 无选中会话时发送：附件不丢失（preview strip 保留），不静默清空', async () => {
      const { w, gw } = await mountReady()
      // 模拟「删除当前会话后停留在空聊天区」：选中会话置空（无会话可发）
      useChatStore().setSelectedSession('')
      await nextTick()
      await pasteFiles(w, [new File(['x'], 'shot.png', { type: 'image/png' })])
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      // 无会话 → 未发送，且附件不应被清空
      expect(gw.send).not.toHaveBeenCalled()
      expect(w.find('[data-test="preview-strip"]').exists()).toBe(true)
      expect(w.findAll('[data-test="preview-item"]')).toHaveLength(1)
    })
  })

  // ---- #459-T3 #464：附件渲染——历史/流式消息 image/audio/video 内容块 ----
  describe('附件媒体渲染（#459-T3 #464）', () => {
    // 挂载并在 fireReady 前注入历史消息（mountReady 内部 history 恒为空数组，无法注入媒体块）。
    async function mountWithHistory(messages: Array<Record<string, unknown>>) {
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.listSessions.mockResolvedValue([SESSION])
      gw.getHistory.mockResolvedValue({ messages, hasMore: false, nextOffset: null })
      gw.listCommands.mockResolvedValue([])
      gw.listPendingApprovals.mockResolvedValue([])
      gw.fireReady() // onReady → syncSessions → loadHistory（消费上面的 history mock）
      await flushPromises()
      await nextTick()
      return { w, gw }
    }

    it('历史消息 image/audio/video 块 → 渲染 img/audio/video 标签', async () => {
      const { w } = await mountWithHistory([
        { role: 'user', content: '看这个' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', mimeType: 'image/png', content: 'iVBORw0KGgo=' },
            { type: 'audio', mimeType: 'audio/mpeg', content: 'QUJD' },
            { type: 'video', mimeType: 'video/mp4', content: 'REVG' },
          ],
        },
      ])
      const img = w.find('[data-test="media-image"]')
      expect(img.exists()).toBe(true)
      expect(img.attributes('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
      expect(w.find('[data-test="media-audio"]').exists()).toBe(true)
      expect(w.find('[data-test="media-audio"]').attributes('src')).toBe('data:audio/mpeg;base64,QUJD')
      expect(w.find('[data-test="media-video"]').exists()).toBe(true)
      expect(w.find('[data-test="media-video"]').attributes('src')).toBe('data:video/mp4;base64,REVG')
      expect(w.find('[data-test="stream"]').text()).toContain('截图如下') // 文本块照常渲染
    })

    it('历史纯图片消息（无文本）→ 渲染出图片，不渲染空泡', async () => {
      const { w } = await mountWithHistory([
        { role: 'user', content: '发张图' },
        { role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', content: 'AAA' }] },
      ])
      expect(w.find('[data-test="media-image"]').exists()).toBe(true)
      expect(w.find('[data-test="media-image"]').attributes('src')).toBe('data:image/png;base64,AAA')
    })

    it('流式 AI 回复含 image 块（browser 截图）→ final 后渲染 img', async () => {
      const { w, gw } = await mountReady()
      await w.find('[data-test="input"]').setValue('截图给我')
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      gw.fireFrame({ type: 'text', runId: 'r1', delta: '截图如下' })
      await nextTick()
      // final 帧由 eventTranslate 产出 attachment 帧（含 image 块）→ ChatView 经 handleAttachment 渲染
      gw.fireFrame({ type: 'attachment', runId: 'r1', media: [{ type: 'image', mimeType: 'image/png', src: 'iVBOR' }] })
      gw.fireFrame({ type: 'done', runId: 'r1' })
      await nextTick()
      const img = w.find('[data-test="media-image"]')
      expect(img.exists()).toBe(true)
      expect(img.attributes('src')).toBe('data:image/png;base64,iVBOR')
      expect(w.find('[data-test="stream"]').text()).toContain('截图如下') // 文本与图片共存
    })

    it('发送附件消息 → user echo 立即渲染出附件（img/audio）', async () => {
      const { w, gw } = await mountReady()
      const pasteEvt = (files: File[]) => {
        const evt = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(evt, 'clipboardData', { value: { files } })
        w.find('[data-test="composer"]').element.dispatchEvent(evt)
      }
      // 图片（mock 压缩回 dataURL content）+ 音频（mock 转换回 dataURL content）
      pasteEvt([
        new File(['x'], 'shot.png', { type: 'image/png' }),
        new File(['y'], 'song.mp3', { type: 'audio/mpeg' }),
      ])
      await flushPromises()
      await nextTick()
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      await nextTick()
      expect(gw.send).toHaveBeenCalled()
      // user echo 消息渲染出自己发送的图片 + 音频
      expect(w.find('[data-test="media-image"]').exists()).toBe(true)
      expect(w.find('[data-test="media-audio"]').exists()).toBe(true)
    })
  })

  describe('#564 outbox 离线待发（窄窗落盘 + loadHistory 后重发 + 幂等去重）', () => {
    it('发送未回执 → 入队 sessionStorage（含幂等 id）；ack 回执 → 删队（在线正常路径零残留）', async () => {
      const { w, gw } = await mountReady()
      // ack 未回（deferred）：模拟真实网关慢 ack，窄窗内落盘可见
      let resolveSend!: (v?: unknown) => void
      gw.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res }))
      await w.find('[data-test="input"]').setValue('你好')
      await w.find('[data-test="send"]').trigger('click')
      // gateway.send 已调、ack 未回：窄窗落盘
      const raw = JSON.parse(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)!)
      expect(raw.sessions['sk-1']).toHaveLength(1)
      expect(raw.sessions['sk-1'][0].text).toBe('你好')
      const id = raw.sessions['sk-1'][0].id
      expect(id).toMatch(/^[a-z0-9]{32}$/)
      // 幂等 key 外注：send 第 4 参 = outbox id（重发复用同一 id 经网关幂等去重）
      expect(gw.send).toHaveBeenCalledWith('sk-1', '你好', undefined, id)
      // ack 返回 → 删队（键整体清除）
      resolveSend('r1')
      await flushPromises()
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull()
    })

    it('带附件消息 → 不入队（附件 File/dataUrl 不可持久化，规格 §九 纯文本外暂不覆盖）', async () => {
      const { w, gw } = await mountReady()
      const evt = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'clipboardData', { value: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } })
      w.find('[data-test="composer"]').element.dispatchEvent(evt)
      await flushPromises()
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      expect(gw.send).toHaveBeenCalled()
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull()
    })

    it('catch 且 activeRunId 空（run 未起来）→ 留队待重发（下次重连/刷新自动重发）', async () => {
      const { w, gw } = await mountReady()
      gw.send.mockRejectedValueOnce(new Error('网关拒绝'))
      await w.find('[data-test="input"]').setValue('没送出去的')
      await w.find('[data-test="send"]').trigger('click')
      await flushPromises()
      const raw = JSON.parse(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)!)
      expect(raw.sessions['sk-1']).toHaveLength(1)
      expect(raw.sessions['sk-1'][0].text).toBe('没送出去的')
    })

    it('catch 且 activeRunId 非空（网关已受理在续流）→ 删队（ack 慢而已，规格 §三.2）', async () => {
      const { w, gw } = await mountReady()
      let rejectSend!: (e: Error) => void
      gw.send.mockImplementationOnce(() => new Promise((_, rej) => { rejectSend = rej }))
      await w.find('[data-test="input"]').setValue('已在流')
      await w.find('[data-test="send"]').trigger('click')
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).not.toBeNull()
      gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答' }) // 首帧到达：网关已受理
      await nextTick()
      rejectSend(new Error('timeout'))
      await flushPromises()
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull()
    })

    it('断线期间输入 → 禁发不排队（输入留输入框，storage 无新项，规格 §三.1）', async () => {
      const { w, gw } = await mountReady()
      gw.fireClose(1006, 'net', true)
      await nextTick()
      await w.find('[data-test="input"]').setValue('断线想发的话')
      await w.find('[data-test="send"]').trigger('click')
      expect(gw.send).not.toHaveBeenCalled() // 禁发（既有行为）
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull() // 不排队
    })

    it('断线重连 → syncSessions 选定 + loadHistory 后自动重发（复用原幂等 id、ack 后清队）', async () => {
      const { w, gw } = await mountReady()
      let resolveSend!: (v?: unknown) => void
      gw.send.mockImplementationOnce(() => new Promise((res) => { resolveSend = res }))
      await w.find('[data-test="input"]').setValue('断线前的话')
      await w.find('[data-test="send"]').trigger('click')
      const id = gw.send.mock.calls[0][3] as string
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).not.toBeNull()
      // ack 未回即断线 → 协议机自动重连成功（everConnected 分支）→ syncSessions → loadHistory → resendOutbox
      gw.fireClose(1006, 'net', true)
      await nextTick()
      gw.fireReady()
      await flushPromises()
      // 重发：复用原幂等 id（网关幂等去重防转录双跑），纯文本无附件
      expect(gw.send).toHaveBeenCalledTimes(2)
      expect(gw.send.mock.calls[1]).toEqual(['sk-1', '断线前的话', undefined, id])
      // 重发的乐观消息渲染在 loadHistory 铺底之后（正确位置）
      expect(w.find('[data-test="stream"]').text()).toContain('断线前的话')
      // 重发 ack 回执 → 清队
      await flushPromises()
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull()
      // 第一次 send 的迟到回执（网关实际已受理）：已被幂等去重路径覆盖，不产生第三次发送
      resolveSend('r1')
      await flushPromises()
      expect(gw.send).toHaveBeenCalledTimes(2)
    })

    it('整页刷新（新 tab 重建）→ 残留自动重发（首连 syncSessions 同一触发点，消息回到正确会话）', async () => {
      createOutboxStore().addPending('demo', 'sk-1', { id: 'id-refresh', text: '刷新前的消息', createdAt: 1 })
      mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listSessions.mockResolvedValue([SESSION])
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      expect(gw.send).toHaveBeenCalledWith('sk-1', '刷新前的消息', undefined, 'id-refresh')
      await flushPromises()
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull() // ack 后清队
    })

    it('残留文本已在历史（网关已受理 ack 丢）→ loadHistory 内容去重：不重发、清队（防 UI 双条）', async () => {
      createOutboxStore().addPending('demo', 'sk-1', { id: 'id-dup', text: '已受理的消息', createdAt: 1 })
      const w = mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.getHistory.mockResolvedValue({
        messages: [
          { role: 'user', text: '已受理的消息' },
          { role: 'assistant', text: '回复' },
        ],
        hasMore: false,
        nextOffset: null,
      })
      gw.listSessions.mockResolvedValue([SESSION])
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      expect(gw.send).not.toHaveBeenCalled() // 内容去重：不重发
      expect(sessionStorage.getItem(`${OUTBOX_STORAGE_KEY_PREFIX}demo`)).toBeNull() // 确认点达成清队
      expect(w.find('[data-test="stream"]').text()).toContain('已受理的消息') // 历史正常渲染
    })

    it('scope 隔离：仅重发当前容器的残留（A 容器待发不被 B 读走重发）', async () => {
      const outbox = createOutboxStore()
      outbox.addPending('demo', 'sk-1', { id: 'id-demo', text: 'demo 的', createdAt: 1 })
      outbox.addPending('other', 'sk-1', { id: 'id-other', text: 'other 的', createdAt: 1 })
      mount(ChatView)
      await flushPromises()
      const gw = MockGatewayChat.last!
      gw.getHistory.mockResolvedValue({ messages: [], hasMore: false, nextOffset: null })
      gw.listSessions.mockResolvedValue([SESSION])
      gw.listCommands.mockResolvedValue([])
      gw.send.mockResolvedValue(undefined)
      gw.fireReady()
      await flushPromises()
      expect(gw.send).toHaveBeenCalledTimes(1)
      expect(gw.send).toHaveBeenCalledWith('sk-1', 'demo 的', undefined, 'id-demo')
      expect(outbox.takePending('other', 'sk-1')).toHaveLength(1) // other 容器的残留不动
    })
  })

  // ---- 消息锚点导航（issue #669）view 接线断言（行为覆盖在 chatComponents/anchorNav 测试）----
  it('#669: 锚点轨接线——user 消息入流后 stream 内出现刻度，切会话重置消失', async () => {
    const { w, gw } = await mountReady()
    expect(w.find('[data-test="stream"] [data-test="anchor-rail"]').exists()).toBe(false)
    // jsdom 无布局（scrollHeight=clientHeight=0 → 轨隐藏）：stub 滚动几何放行轨渲染
    const streamEl = w.get('[data-test="stream"]').element as HTMLElement
    Object.defineProperty(streamEl, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(streamEl, 'clientHeight', { configurable: true, value: 100 })
    await w.find('[data-test="input"]').setValue('第一条输入')
    await w.find('[data-test="send"]').trigger('click')
    gw.fireFrame({ type: 'text', runId: 'r1', delta: '回答' })
    gw.fireFrame({ type: 'done', runId: 'r1' })
    await nextTick()
    // 轨挂在 stream 内，刻度按消息下标锚定（user 消息 = 下标 0）
    expect(w.find('[data-test="stream"] [data-test="anchor-dot-0"]').exists()).toBe(true)
    // 切新会话 → messages 清空 → 轨重置消失
    gw.createSession.mockResolvedValueOnce('sk-2')
    await w.find('[data-test="new-session"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="stream"] [data-test="anchor-rail"]').exists()).toBe(false)
  })

  // ---- 面板三态（issue #671 左栏 / #672 右侧文件预览）----
  describe('#671 面板三态接线（chat 左栏）', () => {
    // 视口宽是全局状态：每个用例后复位，防窄屏用例失败时向后续用例泄漏
    beforeEach(() => {
      window.innerWidth = 1024
      globalThis.localStorage.clear()
    })
    afterEach(() => {
      window.innerWidth = 1024
      globalThis.localStorage.clear()
    })

    // owner 段 = tokenOwner(auth.token)：畸形 token 回落到 token 本身（WikiView 未登录态则是
    // 'signed-out'），故此处用测试注入的 'jwt-test'——key 隔离语义由 panelWidth.test.ts 直测。
    const SIDEBAR_KEY = 'researcher:panel:jwt-test:chat:sidebar:width'
    const SIDEBAR_POPPED_KEY = 'researcher:panel:jwt-test:chat:sidebar:popped-width'

    it('左栏被三态包装接管（panel 根 + 恒 inline + 贴左缘 + 默认 220px）', async () => {
      const { w } = await mountReady()
      const panel = w.find('[data-test="panel"][data-side="left"]')
      expect(panel.exists()).toBe(true)
      expect(panel.attributes('data-state')).toBe('inline') // 态不持久化：每次进页恒 inline
      expect(panel.attributes('style')).toContain('width: 220px') // 沿用原固定宽
      expect(panel.element.contains(w.find('[data-test="side-seg"]').element)).toBe(true)
      expect(w.find('[data-test="drag-handle"]').exists()).toBe(true)
      expect(w.find('[data-test="collapse-btn"]').exists()).toBe(true)
    })

    it('左栏宽度经 localStorage 恢复（key 按 chat/sidebar 隔离）', async () => {
      globalThis.localStorage.setItem(SIDEBAR_KEY, '400')
      const { w } = await mountReady()
      expect(w.find('[data-test="panel"][data-side="left"]').attributes('style')).toContain('width: 400px')
    })

    it('折叠 → 弹出 → 收回 全链路；收回后「会话｜文件」分段态原样恢复', async () => {
      const { w } = await mountReady()
      const panel = () => w.find('[data-test="panel"][data-side="left"]')
      expect(w.find('[data-test="side-seg"]').exists()).toBe(true)
      await panel().find('[data-test="collapse-btn"]').trigger('click')
      expect(panel().attributes('data-state')).toBe('collapsed')
      // 折叠态只剩窄条（slot 内容不渲染，与 inline/popped 互斥的形态）
      expect(w.find('[data-test="side-seg"]').exists()).toBe(false)
      await panel().find('[data-test="rail"]').trigger('click')
      expect(panel().attributes('data-state')).toBe('popped')
      expect(w.find('[data-test="side-seg"]').exists()).toBe(true)
      await panel().find('[data-test="restore-btn"]').trigger('click')
      expect(panel().attributes('data-state')).toBe('inline')
      // 分段态归本组件（sidebarTab），与呈现态正交——收回后仍是会话分段
      expect(w.find('[data-test="side-tab-sessions"]').attributes('aria-selected')).toBe('true')
    })

    it('切到「文件」分段仍按原逻辑拉树（三态包装不改分段行为）', async () => {
      const { w } = await mountReady()
      await w.find('[data-test="side-tab-files"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-test="side-tab-files"]').attributes('aria-selected')).toBe('true')
    })

    it('US26 左栏浮层宽度拖拽结束落独立 key（inline 宽度不被污染）', async () => {
      window.innerWidth = 1000
      const { w } = await mountReady()
      const panel = () => w.find('[data-test="panel"][data-side="left"]')
      await panel().find('[data-test="collapse-btn"]').trigger('click')
      await panel().find('[data-test="rail"]').trigger('click')
      // 贴左缘浮层：手柄在右缘，右拖变宽（起始 500px = 50vw → 拖到 700px = 70vw）
      const handle = panel().find('[data-test="pop-handle"]')
      handle.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
      expect(globalThis.localStorage.getItem(SIDEBAR_POPPED_KEY)).toBe('70')
      expect(globalThis.localStorage.getItem(SIDEBAR_KEY)).toBeNull()
    })

    it('窄屏 (<720px) 三态整体禁用：无手柄无按钮，左栏与分段控件照常渲染', async () => {
      window.innerWidth = 500
      const { w } = await mountReady()
      const panel = w.find('[data-test="panel"][data-side="left"]')
      expect(panel.attributes('data-state')).toBe('disabled')
      expect(panel.find('[data-test="drag-handle"]').exists()).toBe(false)
      expect(panel.find('[data-test="collapse-btn"]').exists()).toBe(false)
      expect(panel.element.contains(w.find('[data-test="side-seg"]').element)).toBe(true)
      expect(w.find('[data-test="container-demo"]').exists()).toBe(true)
    })
  })

  describe('#672 面板三态接线（chat 右侧文件预览 + 同页互斥）', () => {
    beforeEach(() => {
      window.innerWidth = 1024
      globalThis.localStorage.clear()
    })
    afterEach(() => {
      window.innerWidth = 1024
      globalThis.localStorage.clear()
    })

    const FILE_KEY = 'researcher:panel:jwt-test:chat:file-preview:width'
    const FILE_POPPED_KEY = 'researcher:panel:jwt-test:chat:file-preview:popped-width'

    // 开一个只读文件 tab 并激活（等价于树点击/agent 工具事件开路——tab 数据面归 store）
    async function openTab(): Promise<void> {
      useFileTabsStore().$patch({
        tabs: [{
          path: 'docs/a.md', state: 'loaded', content: '# A',
          lineMarks: [], binary: false, oversized: false,
        }],
        activePath: 'docs/a.md',
      })
      await nextTick()
    }

    const left = (w: ReturnType<typeof mount>) => w.find('[data-test="panel"][data-side="left"]')
    const right = (w: ReturnType<typeof mount>) => w.find('[data-test="panel"][data-side="right"]')

    it('无 tab 时连三态包装一起不渲染（无幽灵手柄/浮层入口）', async () => {
      const { w } = await mountReady()
      expect(w.find('[data-test="file-tabs-panel"]').exists()).toBe(false)
      expect(right(w).exists()).toBe(false)
      // 页面上只有左栏一个三态面板：右缘不残留任何三态控件
      expect(w.findAll('[data-test="panel"]')).toHaveLength(1)
      expect(w.findAll('[data-test="collapse-btn"]')).toHaveLength(1)
      expect(w.findAll('[data-test="rail"]')).toHaveLength(0)
    })

    it('有 tab → 三态包装接管（恒 inline 起步 + 贴右缘 + 默认 360px）', async () => {
      const { w } = await mountReady()
      await openTab()
      expect(right(w).exists()).toBe(true)
      expect(right(w).attributes('data-state')).toBe('inline') // 态不持久化：每次进页恒 inline
      expect(right(w).attributes('style')).toContain('width: 360px') // 沿用原固定宽
      expect(right(w).element.contains(w.find('[data-test="file-tabs-panel"]').element)).toBe(true)
      expect(right(w).find('[data-test="drag-handle"]').exists()).toBe(true)
    })

    it('宽度经 localStorage 恢复（key 按 chat/file-preview 独立于左栏）', async () => {
      globalThis.localStorage.setItem(FILE_KEY, '600')
      const { w } = await mountReady()
      await openTab()
      expect(right(w).attributes('style')).toContain('width: 600px')
      expect(left(w).attributes('style')).toContain('width: 220px') // 左栏不共用 key
    })

    it('关掉全部 tab → 三态包装随之消失（不留空壳浮层）', async () => {
      const { w } = await mountReady()
      await openTab()
      expect(right(w).exists()).toBe(true)
      await w.find('[data-test="tabs-closeall"]').trigger('click')
      await nextTick()
      expect(right(w).exists()).toBe(false)
      expect(w.find('[data-test="file-tabs-panel"]').exists()).toBe(false)
      expect(w.findAll('[data-test="panel"]')).toHaveLength(1)
    })

    it('折叠 → 弹出 → 收回 全链路（右侧镜像箭头）', async () => {
      const { w } = await mountReady()
      await openTab()
      await right(w).find('[data-test="collapse-btn"]').trigger('click')
      expect(right(w).attributes('data-state')).toBe('collapsed')
      await right(w).find('[data-test="rail"]').trigger('click')
      expect(right(w).attributes('data-state')).toBe('popped')
      await right(w).find('[data-test="restore-btn"]').trigger('click')
      expect(right(w).attributes('data-state')).toBe('inline')
    })

    it('US25 同页互斥：弹右预览自动收回已弹出的左栏（与 wiki 页机制同源）', async () => {
      const { w } = await mountReady()
      await openTab()
      await left(w).find('[data-test="collapse-btn"]').trigger('click')
      await left(w).find('[data-test="rail"]').trigger('click')
      expect(left(w).attributes('data-state')).toBe('popped')
      await right(w).find('[data-test="collapse-btn"]').trigger('click')
      await right(w).find('[data-test="rail"]').trigger('click')
      expect(right(w).attributes('data-state')).toBe('popped')
      expect(left(w).attributes('data-state')).toBe('inline')
    })

    it('US25 互斥反向同样成立（弹左栏收右预览）', async () => {
      const { w } = await mountReady()
      await openTab()
      await right(w).find('[data-test="collapse-btn"]').trigger('click')
      await right(w).find('[data-test="rail"]').trigger('click')
      expect(right(w).attributes('data-state')).toBe('popped')
      await left(w).find('[data-test="collapse-btn"]').trigger('click')
      await left(w).find('[data-test="rail"]').trigger('click')
      expect(left(w).attributes('data-state')).toBe('popped')
      expect(right(w).attributes('data-state')).toBe('inline')
    })

    it('US26 右侧浮层宽度拖拽结束落独立 key（inline 宽度不被污染）', async () => {
      window.innerWidth = 1000
      const { w } = await mountReady()
      await openTab()
      await right(w).find('[data-test="collapse-btn"]').trigger('click')
      await right(w).find('[data-test="rail"]').trigger('click')
      // 贴右缘浮层：手柄在左缘，左拖变宽（起始 500px = 50vw → 拖到 700px = 70vw）
      const handle = right(w).find('[data-test="pop-handle"]')
      handle.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
      expect(globalThis.localStorage.getItem(FILE_POPPED_KEY)).toBe('70')
      expect(globalThis.localStorage.getItem(FILE_KEY)).toBeNull()
    })

    it('窄屏 (<720px) 三态禁用：无控件，预览面板照常渲染（退回本页响应式布局）', async () => {
      window.innerWidth = 500
      const { w } = await mountReady()
      await openTab()
      expect(right(w).attributes('data-state')).toBe('disabled')
      expect(right(w).find('[data-test="collapse-btn"]').exists()).toBe(false)
      expect(right(w).find('[data-test="drag-handle"]').exists()).toBe(false)
      expect(w.find('[data-test="file-tabs-panel"]').exists()).toBe(true)
      expect(left(w).attributes('data-state')).toBe('disabled')
    })
  })
})
