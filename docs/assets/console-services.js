/* 控制台的本机服务启动按钮：只接受后端下发的随机协议名。 */
(function (global) {
  "use strict";

  function create(options) {
    const opts = options || {};
    const buttons = Array.prototype.slice.call(
      opts.buttons || document.querySelectorAll('[data-role="ffs-start"]')
    );
    const navigate = opts.navigate || function (url) { global.location.href = url; };
    let protocolName = "";

    function setProtocolName(value) {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        protocolName = value;
      }
    }

    function update(services) {
      buttons.forEach(function (button) {
        const action = button.dataset.action;
        const alive = services ? (action === "backend" ? true : !!services[action]) : false;
        button.classList.toggle("alive", alive);
        button.disabled = !protocolName;
      });
    }

    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (!protocolName) return;
        navigate(protocolName + "://start/" + button.dataset.action);
      });
    });

    return {
      setProtocolName: setProtocolName,
      update: update,
    };
  }

  global.FlitFancyConsoleServices = { create: create };
})(window);
