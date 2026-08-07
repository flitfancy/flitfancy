(function () {
  if (!window.flitfancy) return;
  var meteorEl = document.querySelector('[data-key="meteor"]');
  var fireflyEl = document.querySelector('[data-key="firefly"]');
  var mc = 0, fc = 0, mTimer = null, fTimer = null;

  function mReset() {
    mc = 0;
    clearTimeout(mTimer);
    if (meteorEl) meteorEl.classList.remove("lit");
  }
  function fReset() {
    fc = 0;
    clearTimeout(fTimer);
    if (fireflyEl) fireflyEl.classList.remove("lit");
  }

  if (meteorEl) {
    meteorEl.addEventListener("click", function () {
      mc++;
      meteorEl.classList.add("lit");
      if (mc === 1) window.flitfancy.meteor();
      if (mc === 2) {
        window.flitfancy.meteor();
        window.flitfancy.meteor();
      }
      if (mc >= 3) {
        window.flitfancy.meteorBurst();
        setTimeout(mReset, 1500);
        return;
      }
      clearTimeout(mTimer);
      mTimer = setTimeout(mReset, 3000);
    });
  }

  if (fireflyEl) {
    fireflyEl.addEventListener("click", function () {
      fc++;
      fireflyEl.classList.add("lit");
      if (fc === 1) window.flitfancy.fireflyBright();
      if (fc === 2) window.flitfancy.fireflyBright();
      if (fc >= 3) {
        window.flitfancy.fireflyBurst();
        setTimeout(fReset, 1500);
        return;
      }
      clearTimeout(fTimer);
      fTimer = setTimeout(fReset, 6000);
    });
  }
})();
