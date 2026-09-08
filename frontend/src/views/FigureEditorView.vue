<script setup lang="ts">
// Figure Editor shell（F1，docs/figure-editor/reconnaissance.md）。
// Path A V1：researcher-service 内置图片/图表编辑正式模块。本页是占位壳——编辑器工作台
// （same-origin SVG-Edit iframe）由 F2/F3 引入；本轮不接入任何 AutoFigure-Edit 资产/API。
// 视觉沿用仓库 Element Plus 设计 token + scoped style（AutoFigureView 同款约束），不引上游 CSS。
</script>

<template>
  <div class="figure-editor-view" data-test="figure-editor-view">
    <div class="figure-editor-head">
      <h1>Figure Editor</h1>
      <p class="figure-editor-lead">在 researcher-service 内编辑图片 / 图表（Vue 原生模块）。</p>
    </div>

    <div class="figure-editor-placeholder" data-test="figure-editor-placeholder">
      <p class="figure-editor-placeholder-title">Editor integration coming next</p>
      <p class="figure-editor-placeholder-detail">
        F2/F3 将把 SVG-Edit 编辑器工作台接入本页；V1 范围不含 AutoFigure-Edit 的生成流水线。
      </p>
    </div>
  </div>
</template>

<style scoped>
.figure-editor-view {
  padding: 20px;
  max-width: 760px;
}
.figure-editor-head h1 {
  margin: 0 0 8px;
  font-size: 20px;
}
.figure-editor-lead {
  margin: 0 0 20px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}
.figure-editor-placeholder {
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  padding: 32px 20px;
  text-align: center;
}
.figure-editor-placeholder-title {
  margin: 0 0 8px;
  color: var(--el-color-primary);
  font-weight: 600;
  font-size: 15px;
}
.figure-editor-placeholder-detail {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
