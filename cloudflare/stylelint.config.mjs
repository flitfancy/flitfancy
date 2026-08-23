/* stylelint 防线（v1.0）：只开高价值规则，零噪音。
   - no-duplicate-selectors：同名选择器机器报警，级联顺序事故不再可能
   - block-no-empty：空规则块即死代码
   - declaration-block-no-duplicate-properties：同块重复声明（允许相邻覆盖模式）
   - declaration-property-value-allowed-list：font-size 必须使用 --fs-* 令牌，
     防止字号体系退化回散落的字面量（新增令牌在 style.css 的 :root 定义）
   文件范围：docs/assets 下的四个 css（debug-firefly 的独立页面内联样式不在内）。 */
export default {
  rules: {
    "no-duplicate-selectors": true,
    "block-no-empty": true,
    "declaration-block-no-duplicate-properties": [
      true,
      { ignore: ["consecutive-duplicates-with-different-values"] },
    ],
    "declaration-property-value-allowed-list": {
      "/^font-size$/": ["/^var\\(--fs-/"],
    },
  },
};
