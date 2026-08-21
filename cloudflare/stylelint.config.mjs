/* stylelint 防线（v1.0）：只开三条高价值规则，零噪音。
   - no-duplicate-selectors：同名选择器机器报警，级联顺序事故不再可能
   - block-no-empty：空规则块即死代码
   - declaration-block-no-duplicate-properties：同块重复声明（允许相邻覆盖模式）
   文件范围：docs/assets 下的三个 css（debug-firefly 的独立页面内联样式不在内）。 */
export default {
  rules: {
    "no-duplicate-selectors": true,
    "block-no-empty": true,
    "declaration-block-no-duplicate-properties": [
      true,
      { ignore: ["consecutive-duplicates-with-different-values"] },
    ],
  },
};
