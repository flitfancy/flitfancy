(function () {
  "use strict";
  const form = document.querySelector('[data-flitime="form"]');
  if (!form) return;
  const input = document.querySelector('[data-flitime="ip"]');
  const message = document.querySelector('[data-flitime="message"]');
  const key = "flitfancy-flitime-local-ip";
  try { input.value = window.localStorage.getItem(key) || ""; } catch (error) { /* Optional. */ }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const address = input.value.trim();
    const parts = address.split(".");
    const valid = parts.length === 4 && parts.every(function (part) {
      return /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255;
    });
    if (!valid) {
      message.textContent = "请输入 Flitime 屏幕上的 IP 地址。";
      return;
    }
    try { window.localStorage.setItem(key, address); } catch (error) { /* Optional. */ }
    message.textContent = "";
    window.open("http://" + address + "/update", "_blank", "noopener,noreferrer");
  });
})();
