/**
 * Config.gs — store-wide settings.
 *
 * Branding, currency and limits live here (safe to expose to the browser).
 * Anything private (notification email, spreadsheet ID, webhook secret) lives in
 * Script Properties: Project Settings → Script Properties. See README.md.
 */

var CONFIG = {
  STORE_NAME: 'The Red',
  STORE_TAGLINE: 'Everyday clothing, made to last',


  FAVICON_URL: 'https://i.postimg.cc/m233D6DB/favicon.png',
 
   CONTACT: {
    PHONE: '',       // e.g. '+20 10 1234 5678'
    WHATSAPP: '',    // number with country code, e.g. '+20 10 1234 5678'
    EMAIL: 'theeeredddd@gmail.com',       // public email for customers (orders still go to NOTIFICATION_EMAIL)
    INSTAGRAM: 'https://www.instagram.com/thered.clothes?xtok=b245c2p4NXVnMXB0',   // e.g. 'https://www.instagram.com/yourshop'
    FACEBOOK: '',
    TIKTOK: 'https://www.tiktok.com/@thered.clothes?_r=1&_t=ZS-9BQmzgGyRMX',
    ADDRESS: ''      // shop address or working hours; use \n for a new line
  },

  CURRENCY: 'EGP',
  LOCALE: 'en-EG',

  // Filter checkboxes shown in the sidebar (matched case-insensitively against
  // the "Category" column; "T-Shirts", "tshirts" and "Tshirts" all match "Tshirts").
  CATEGORIES: ['Hoodie', 'Round Shirt', 'Pants', 'Suits', 'Socks', 'Printed HOODIES ', 'Basic Hoodies', 'Printed CREW NECK', 'Basic CREW NECK', 'Double Zipper Box Fit ', 'Full Suite', 'Sweatpants'
],

  NAV_LINKS: [
    { label: 'Home', href: '#top' },
    { label: 'Shop', href: '#shop' },
    { label: 'About', href: '#about' },
    { label: 'Contact', href: '#contact' }
  ],

  THEME: {
    background: '#121212',
    textPrimary: '#F5F5F5',
    textSecondary: '#777777',
    border: '#e5e5e5',
    accent: '#ed2f2f',
    accentHover: '#873b8c'
  },

  // Animated page background. Apps Script can't serve files from the project, so on
  // the live site these must be full https:// links to where the files are hosted
  // (see README "Animated background"). Empty = use the plain THEME.background colour.
  // The local preview fills empty entries with the files in assets/.
  BACKGROUND: {
    DESKTOP_GIF: '',
    MOBILE_GIF: '',
    DESKTOP_STATIC: '',     // still image: shown while the GIF loads and for reduced-motion visitors
    MOBILE_STATIC: '',
    MOBILE_BREAKPOINT: 768  // px; at this width or narrower the mobile images are used
  },

  SHEETS: {
    PRODUCTS: 'Products',
    ORDERS: 'Orders'
  },

  PRODUCT_HEADERS: ['Name', 'Price', 'Image Link', 'Description', 'Category', 'Sizes Available', 'In Stock'],
  ORDER_HEADERS: ['Timestamp', 'Order ID', 'Customer Name', 'Phone', 'Email', 'Shipping Address',
    'Cart Items', 'Total Price', 'Order Status'],

  DEFAULT_ORDER_STATUS: 'Pending',

  LIMITS: {
    NAME_MIN: 2,
    NAME_MAX: 100,
    PHONE_MAX: 25,
    PHONE_DIGITS_MIN: 7,
    PHONE_DIGITS_MAX: 15,
    EMAIL_MAX: 254,
    ADDRESS_MIN: 10,
    ADDRESS_MAX: 500,
    MAX_LINES: 20,            // distinct product/size lines per order
    MAX_QTY_PER_LINE: 10,
    MAX_UNITS_PER_ORDER: 50,
    PRODUCT_NAME_MAX: 150,
    SIZE_MAX: 20
  },

  // Abuse protection (best effort — see README "Spam and abuse").
  RATE_LIMITS: {
    ORDERS_PER_EMAIL_PER_HOUR: 5,
    ORDERS_PER_HOUR_TOTAL: 60
  },

  IDEMPOTENCY_TTL_SECONDS: 21600, // 6 hours, the CacheService maximum
  LOCK_TIMEOUT_MS: 30000
};

/** Script Property names. */
var PROPS = {
  SPREADSHEET_ID: 'SPREADSHEET_ID',           // optional when the script is bound to the spreadsheet
  NOTIFICATION_EMAIL: 'NOTIFICATION_EMAIL',   // where order emails go (defaults to the script owner)
  WEBHOOK_SECRET: 'WEBHOOK_SECRET'            // optional; when set, doPost requires it
};

function getProp_(name) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(name);
    return value ? String(value).trim() : '';
  } catch (err) {
    return '';
  }
}

/** The subset of configuration the browser is allowed to see. */
function getPublicConfig_() {
  return {
    storeName: CONFIG.STORE_NAME,
    tagline: CONFIG.STORE_TAGLINE,
    currency: CONFIG.CURRENCY,
    locale: CONFIG.LOCALE,
    categories: CONFIG.CATEGORIES.slice(),
    navLinks: CONFIG.NAV_LINKS.slice(),
    theme: CONFIG.THEME,
    background: {
      desktop: assetUrl_(CONFIG.BACKGROUND.DESKTOP_GIF),
      mobile: assetUrl_(CONFIG.BACKGROUND.MOBILE_GIF),
      desktopStatic: assetUrl_(CONFIG.BACKGROUND.DESKTOP_STATIC),
      mobileStatic: assetUrl_(CONFIG.BACKGROUND.MOBILE_STATIC),
      mobileBreakpoint: Math.max(0, Math.round(Number(CONFIG.BACKGROUND.MOBILE_BREAKPOINT) || 768))
    },
    contact: publicContact_(CONFIG.CONTACT || {}),
    limits: CONFIG.LIMITS
  };
}
/** CONFIG.CONTACT cleaned for the browser: plain text trimmed, links https:// only. */
function publicContact_(c) {
  var text = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };
  var link = function (v) { var url = assetUrl_(v); return /^https:\/\//i.test(url) ? url : ''; };
  var email = text(c.EMAIL, 254);
  var whatsappDigits = text(c.WHATSAPP, 30).replace(/\D/g, '');
  return {
    phone: text(c.PHONE, 30),
    whatsapp: whatsappDigits.length >= 7 && whatsappDigits.length <= 15 ? whatsappDigits : '',
    email: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : '',
    instagram: link(c.INSTAGRAM),
    facebook: link(c.FACEBOOK),
    tiktok: link(c.TIKTOK),
    address: text(c.ADDRESS, 300)
  };
}
/**
 * An https:// link or a plain relative path (local preview), else ''. Quotes,
 * brackets, spaces and other schemes are refused so the value is safe inside CSS url("…").
 */
function assetUrl_(value) {
  var url = String(value == null ? '' : value).trim();
  if (/^https:\/\/[^\s"'()<>\\]+$/i.test(url)) return url;
  if (/^[\w.\-]+(\/[\w.\-]+)*$/.test(url)) return url;
  return '';
}

