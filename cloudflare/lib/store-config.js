/** Helpers for GET /api/config (cloudflare/api/config.js). */

// Empty CONFIG.BACKGROUND entries use the copies deployed with the site (public/assets/).
const LOCAL_BACKGROUND = {
  desktop: 'assets/background-desktop.gif',
  mobile: 'assets/background-mobile.gif',
  desktopStatic: 'assets/background-desktop-static.jpg',
  mobileStatic: 'assets/background-mobile-static.jpg'
};

export function configScript(config) {
  // "<" escaped so the JSON cannot close a <script> element.
  return 'window.STORE_CONFIG = ' + JSON.stringify(config).replace(/</g, '\\u003c') + ';\n';
}

export function withLocalBackground(config) {
  const background = Object.assign({}, config.background);
  Object.keys(LOCAL_BACKGROUND).forEach((k) => { if (!background[k]) background[k] = LOCAL_BACKGROUND[k]; });
  return Object.assign({}, config, { background });
}
