# 网站图片目录

日记页、足迹页的配图放在这里，通过 `assets/images/` 引用。

## 图片准备建议（保证清晰 + 加载快）

1. **照片**转 WebP（质量 82 左右）；**截图/图纸**用 PNG（文字更锐利）；
2. 同一张图导出三档宽度，用于不同屏幕：
   - `-640.webp`：手机 1x
   - `-1280.webp`：手机 2x / 平板
   - `-1920.webp`：桌面 / Retina
3. 长边建议不超过 2000px，单张尽量 < 500KB；
4. 引用示例：

```html
<figure class="figure">
  <img src="assets/images/photo-1280.webp"
       srcset="assets/images/photo-640.webp 640w,
               assets/images/photo-1280.webp 1280w,
               assets/images/photo-1920.webp 1920w"
       sizes="(max-width: 860px) 100vw, 860px"
       alt="图片描述" loading="lazy">
  <figcaption>配图说明</figcaption>
</figure>
```

批量压缩 WebP：可用网页工具（如 Squoosh）或命令行 `cwebp`。
