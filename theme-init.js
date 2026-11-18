(function () {
  'use strict';
  var theme = 'dark';
  try {
    if (localStorage.getItem('np.theme') === 'light') theme = 'light';
  } catch (e) {
    /* storage unavailable: keep default */
  }
  document.documentElement.dataset.theme = theme;
})();
