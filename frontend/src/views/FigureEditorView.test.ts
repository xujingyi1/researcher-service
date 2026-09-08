// seam: FigureEditorView —— F1 shell 占位页（docs/figure-editor/reconnaissance.md）。
// 覆盖：渲染标题、简介与占位提示；不依赖 store/router/Element Plus 组件（纯 scoped 样式），
// 故可直接 mount 而无须 stub——与 NotFoundView.test.ts 同一档。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import FigureEditorView from '@/views/FigureEditorView.vue'

describe('FigureEditorView', () => {
  it('renders the shell title and lead', () => {
    const wrapper = mount(FigureEditorView)
    expect(wrapper.find('[data-test="figure-editor-view"]').exists()).toBe(true)
    expect(wrapper.get('h1').text()).toBe('Figure Editor')
    expect(wrapper.text()).toContain('在 researcher-service 内编辑图片 / 图表')
  })

  it('shows the placeholder (editor not yet wired)', () => {
    const wrapper = mount(FigureEditorView)
    expect(wrapper.get('[data-test="figure-editor-placeholder"]').text()).toContain(
      'Editor integration coming next',
    )
  })
})
