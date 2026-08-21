/* 云萤 · flitfancy —— 轻量访问上报：图片像素方式，兼容性最好。 */
(function () {
  /* 上报前清洗 referrer：去掉 query 里的敏感参数，只保留 协议+域名+路径 */
  function refClean(value) {
    const text = String(value || "").slice(0, 2000);
    if (!text) return "";
    try {
      const u = new URL(text);
      return (u.origin + u.pathname).slice(0, 500);
    } catch (e) {
      return text.slice(0, 500);
    }
  }
  try {
    var url = "https://api.flitfancy.com/track?p=" +
      encodeURIComponent(location.pathname || "/") +
      "&r=" + encodeURIComponent(refClean(document.referrer)) +
      "&w=" + (screen.width || 0) +
      "&h=" + (screen.height || 0);
    var img = new Image();
    img.src = url;
  } catch (e) {
    /* 上报失败不影响页面 */
  }
})();
