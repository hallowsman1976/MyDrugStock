
// --- GAS API WRAPPER (token-based external backend) ---
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyfRv0OyfGBbPc-oXjZ94LhsheLFLGMC2trMnQKsiC0a1FzAF6cYLnP0IIiY81RRhYH/exec";
const GAS_API_KEY     = "";                     // ตั้งให้ตรงกับ Script Property 'API_KEY' (เว้นว่างถ้าไม่ใช้)
const GAS_TOKEN_KEY   = "drugstore_api_token";

function gasGetToken()  { try { return localStorage.getItem(GAS_TOKEN_KEY) || ''; } catch (e) { return ''; } }
function gasSetToken(t) { try { t ? localStorage.setItem(GAS_TOKEN_KEY, t) : localStorage.removeItem(GAS_TOKEN_KEY); } catch (e) {} }

// ยิง 1 request ต่อ 1 call chain — ctx เป็นของแต่ละ chain (รองรับ nested/parallel calls)
function gasApiCall(propKey, args, ctx) {
  fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    body: JSON.stringify({ func: propKey, args: args, token: gasGetToken(), apiKey: GAS_API_KEY }),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
  })
  .then(function(res) { return res.json(); })
  .then(function(res) {
    var ok    = res.ok !== false && !res.error;
    var data  = ('result' in res) ? res.result : res;
    var error = res.error || (ok ? null : 'Unknown API error');
    if (!ok) {
      if (ctx.f) ctx.f(new Error(error)); else console.error("GAS API Error:", error);
    } else {
      if (propKey === 'loginUser'  && data && data.token) gasSetToken(data.token);
      if (propKey === 'logoutUser') gasSetToken('');
      if (ctx.s) ctx.s(data);
    }
  })
  .catch(function(err) { if (ctx.f) ctx.f(err); else console.error("GAS API Catch:", err); });
}

window.google = window.google || {};
if (!window.google.script) {
  window.google.script = {
    // getter: ทุกครั้งที่เข้าถึง .run จะได้ builder ใหม่ พร้อม ctx ของตัวเอง
    get run() {
      var ctx = { s: null, f: null };
      var builder = new Proxy({}, {
        get: function(_t, propKey) {
          if (propKey === 'withSuccessHandler') return function(h) { ctx.s = h; return builder; };
          if (propKey === 'withFailureHandler') return function(h) { ctx.f = h; return builder; };
          return function() { gasApiCall(propKey, Array.prototype.slice.call(arguments), ctx); return builder; };
        }
      });
      return builder;
    }
  };
}
// -----------------------
// ============================================================
// js.html - Global JavaScript (Complete Fixed Version)
// ============================================================

// ── Global State ─────────────────────────────────────────────
var currentUser               = null;
var currentPage               = '';
var scannerActive             = false;
var scannerStream             = null;
var scannerInstance           = null;
var _submitLock               = false;
var onBarcodeDetectedCallback = null;

// ── Scanner State ─────────────────────────────────────────────
var SCAN_BOX_W    = 280;
var SCAN_BOX_H    = 120;
var SCAN_INTERVAL = 150;
var _scanTimer    = null;
var _scanVideo    = null;
var _scanCanvas   = null;
var _scanCtx      = null;
var _scanReader   = null;
var _scanHints    = null;

// ============================================================
// SECTION 1: CORE UTILITIES (ปรับเป็น window.xxx ทั้งหมด)
// ============================================================

window.reExecuteScripts = function(container) {
  if (!container) return;
  var scripts = Array.from(container.querySelectorAll('script'));
  scripts.forEach(function(oldScript) {
    try {
      var newScript = document.createElement('script');
      if (oldScript.attributes) {
        for (var i = 0; i < oldScript.attributes.length; i++) {
          var attr = oldScript.attributes[i];
          try { newScript.setAttribute(attr.name, attr.value); } catch(e) {}
        }
      }
      if (oldScript.src) {
        newScript.src = oldScript.src;
        oldScript.parentNode.replaceChild(newScript, oldScript);
        return;
      }
      var code = oldScript.textContent || oldScript.innerText || '';
      newScript.appendChild(document.createTextNode(code));
      if (oldScript.parentNode) {
        oldScript.parentNode.replaceChild(newScript, oldScript);
      }
    } catch(err) { console.error('reExecuteScripts:', err); }
  });
};

window.escapeHtml = function(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
};

window.formatNumber = function(num) {
  var n = Number(num);
  if (isNaN(n)) return '0';
  try { return n.toLocaleString('th-TH'); }
  catch(e) { return String(n); }
};

// ============================================================
// PAGINATION - ตัวช่วยแบ่งหน้าใช้ร่วมกันทุกตาราง/ลิสต์ (ค่าเริ่มต้น 10 แถว/หน้า)
// ============================================================
window.PAGE_SIZE = 10;

// ตัดข้อมูลตามหน้า: คืน { pageData, page, totalPages }
window.paginateSlice = function(data, page, pageSize) {
  data = data || [];
  pageSize = pageSize || window.PAGE_SIZE;
  var totalPages = Math.max(1, Math.ceil(data.length / pageSize));
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  var start = (page - 1) * pageSize;
  return { pageData: data.slice(start, start + pageSize), page: page, totalPages: totalPages, start: start };
};

// วาดแถบ pagination ลงใน element id ที่ระบุ — gotoFnName คือชื่อฟังก์ชัน global ที่จะเรียกตอนคลิก เช่น 'stGotoPage'
window.renderPaginationBar = function(containerId, totalItems, currentPage, pageSize, gotoFnName) {
  var el = document.getElementById(containerId);
  if (!el) return;
  pageSize = pageSize || window.PAGE_SIZE;
  var totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;

  if (!totalItems || totalItems <= pageSize) { el.innerHTML = ''; return; }

  var startItem = (currentPage - 1) * pageSize + 1;
  var endItem   = Math.min(currentPage * pageSize, totalItems);

  var winSize = 5;
  var startP  = Math.max(1, currentPage - Math.floor(winSize / 2));
  var endP    = Math.min(totalPages, startP + winSize - 1);
  startP      = Math.max(1, endP - winSize + 1);
  var pages   = [];
  for (var p = startP; p <= endP; p++) pages.push(p);

  var html = '<div class="pg-bar">';
  html += '<span class="pg-info">' + startItem + '–' + endItem + ' จาก ' + totalItems + ' รายการ</span>';
  html += '<div class="pg-btns">';
  html += '<button class="pg-btn" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="' + gotoFnName + '(1)" title="หน้าแรก">&laquo;</button>';
  html += '<button class="pg-btn" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="' + gotoFnName + '(' + (currentPage - 1) + ')" title="ก่อนหน้า">&lsaquo;</button>';
  pages.forEach(function (p) {
    html += '<button class="pg-btn' + (p === currentPage ? ' active' : '') + '" onclick="' + gotoFnName + '(' + p + ')">' + p + '</button>';
  });
  html += '<button class="pg-btn" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="' + gotoFnName + '(' + (currentPage + 1) + ')" title="ถัดไป">&rsaquo;</button>';
  html += '<button class="pg-btn" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="' + gotoFnName + '(' + totalPages + ')" title="หน้าสุดท้าย">&raquo;</button>';
  html += '</div></div>';
  el.innerHTML = html;
};


// ============================================================
// DATE UTILITIES - ทั้งหมดเป็น window.xxx
// ============================================================

window.formatExpiryDisplay = function(dateStr) {
  if (!dateStr || String(dateStr).trim() === '' || dateStr === '-') return '-';
  return window.escapeHtml(String(dateStr).trim());
};

window.parseDisplayDate = function(dateStr) {
  if (!dateStr || dateStr === '-' || String(dateStr).trim() === '') return null;
  try {
    var s = String(dateStr).trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
      var parts = s.split('/');
      var d = new Date(
        parseInt(parts[2], 10),
        parseInt(parts[1], 10) - 1,
        parseInt(parts[0], 10)
      );
      return isNaN(d.getTime()) ? null : d;
    }
    var d2 = new Date(s);
    return isNaN(d2.getTime()) ? null : d2;
  } catch(e) { return null; }
};

window.getDaysLeft = function(dateStr) {
  var d = window.parseDisplayDate(dateStr);
  if (!d) return 9999;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.floor((d - today) / (1000 * 60 * 60 * 24));
};

window.getDaysLeftFromThaiDate = function(dateStr) {
  return window.getDaysLeft(dateStr);
};

window.formatDaysLeft = function(days) {
  if (days === 9999) return '';
  if (days < 0)      return 'หมดอายุแล้ว ' + Math.abs(days) + ' วัน';
  if (days === 0)    return 'หมดอายุวันนี้';
  if (days <= 90)    return 'อีก ' + days + ' วัน';
  return '';
};

window.getExpiryColorClass = function(days) {
  if (days === 9999) return 'text-gray-400';
  if (days < 0)      return 'text-red-600 font-bold';
  if (days === 0)    return 'text-red-600 font-bold';
  if (days <= 30)    return 'text-orange-600 font-semibold';
  if (days <= 90)    return 'text-yellow-600 font-medium';
  return 'text-gray-600';
};

window.getExpiryColorStyle = function(days) {
  if (days === 9999) return 'color:#9ca3af';
  if (days < 0)      return 'color:#dc2626;font-weight:700';
  if (days === 0)    return 'color:#dc2626;font-weight:700';
  if (days <= 30)    return 'color:#ea580c;font-weight:600';
  if (days <= 90)    return 'color:#d97706;font-weight:500';
  return 'color:#374151';
};


// ============================================================
// SECTION 2: LOADING / TOAST
// ============================================================

window.showLoading = function(text) {
  var overlay = document.getElementById('loadingOverlay');
  var label   = document.getElementById('loadingText');
  if (label)   label.textContent = text || 'กำลังโหลด...';
  if (overlay) overlay.classList.remove('hidden');
};

window.hideLoading = function() {
  var overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.add('hidden');
};

// ============================================================
// Animated Counter — วิ่งตัวเลขจาก 0 → ค่าจริง (easeOutCubic)
// ใช้กับ .stat-value ทุกตัวใน root ที่ส่งเข้ามา
// ============================================================
window.animateCounters = function(root, duration) {
  root = root || document;
  duration = duration || 900;
  var fmt = (typeof formatNumber === 'function') ? formatNumber : function(n){ return String(n); };
  var els = root.querySelectorAll('.stat-value');
  Array.prototype.forEach.call(els, function(el) {
    if (el.dataset.counted === '1') return;
    el.dataset.counted = '1';
    var target = parseFloat(String(el.textContent).replace(/[^0-9.\-]/g, '')) || 0;
    if (target <= 0) { el.textContent = fmt(target); return; }
    var start = null;
    el.textContent = fmt(0);
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = fmt(target);
    }
    requestAnimationFrame(step);
  });
};

window.showToast = function(message, type, duration) {
  type     = type     || 'info';
  duration = duration || 3000;

  var icons = {
    success: '<svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
    error:   '<svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
    warning: '<svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
    info:    '<svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
  };

  var toast       = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.innerHTML = (icons[type] || '') +
    '<span class="text-sm font-medium leading-snug">' +
    window.escapeHtml(message) + '</span>';

  var container = document.getElementById('toastContainer');
  if (!container) return;
  container.appendChild(toast);

  setTimeout(function() {
    toast.style.opacity    = '0';
    toast.style.transform  = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, duration);
};

// ============================================================
// SECTION 3: FORM HELPERS
// ============================================================

window.showFieldError = function(fieldId, message) {
  var field = document.getElementById(fieldId);
  var errEl = document.getElementById(fieldId + 'Error');
  if (field) field.classList.add('error');
  if (errEl) { errEl.textContent = message; errEl.classList.add('show'); }
};

window.clearFieldError = function(fieldId) {
  var field = document.getElementById(fieldId);
  var errEl = document.getElementById(fieldId + 'Error');
  if (field) field.classList.remove('error');
  if (errEl) errEl.classList.remove('show');
};

window.validateForm = function(fields) {
  var valid = true;
  fields.forEach(function(f) {
    var el = document.getElementById(f.id);
    if (!el) return;
    if (!el.value.trim()) {
      window.showFieldError(f.id, f.message || 'กรุณากรอกข้อมูล');
      valid = false;
    } else {
      window.clearFieldError(f.id);
    }
  });
  return valid;
};

// ============================================================
// SECTION 4: CHIP HELPERS
// ============================================================

window.getStockStatusChip = function(status) {
  var map = {
    'ปกติ':               '<span class="chip chip-green">ปกติ</span>',
    'ใกล้จุดสั่งซื้อ':    '<span class="chip chip-yellow">ใกล้จุดสั่งซื้อ</span>',
    'ต่ำกว่าจุดสั่งซื้อ': '<span class="chip chip-orange">ต่ำกว่าจุดสั่งซื้อ</span>',
    'หมด':                '<span class="chip chip-red">หมด</span>'
  };
  return map[status] ||
    '<span class="chip chip-gray">' + window.escapeHtml(status || '') + '</span>';
};

window.getExpiryStatusChip = function(status) {
  var map = {
    'ปกติ':          '<span class="chip chip-green">ปกติ</span>',
    'ใกล้หมดอายุ':   '<span class="chip chip-yellow">ใกล้หมดอายุ</span>',
    'หมดอายุแล้ว':   '<span class="chip chip-red">หมดอายุแล้ว</span>',
    'หมดอายุวันนี้': '<span class="chip chip-red">หมดอายุวันนี้</span>'
  };
  return map[status] ||
    '<span class="chip chip-gray">' + window.escapeHtml(status || '') + '</span>';
};

window.getTxnTypeChip = function(type) {
  var map = {
    'INITIAL':    '<span class="chip chip-blue">เริ่มต้น</span>',
    'IN':         '<span class="chip chip-green">รับเข้า</span>',
    'OUT':        '<span class="chip chip-red">เบิกออก</span>',
    'ADJUST_IN':  '<span class="chip chip-blue">ปรับเพิ่ม</span>',
    'ADJUST_OUT': '<span class="chip chip-orange">ปรับลด</span>'
  };
  return map[type] ||
    '<span class="chip chip-gray">' + window.escapeHtml(type || '') + '</span>';
};

// ============================================================
// SECTION 5: AUTH
// ============================================================

function setCurrentUser(user) {
  currentUser = user;
  try { sessionStorage.setItem('currentUser', JSON.stringify(user)); } catch(e) {}

  var roleLabels = {
    'Admin':      'ผู้ดูแลระบบ',
    'Staff':      'เจ้าหน้าที่',
    'Viewer':     'ผู้ชม',
    'Purchasing': 'ฝ่ายจัดซื้อ'
  };
  var roleLabel = roleLabels[user.role] || user.role;

  var navUserName  = document.getElementById('navUserName');
  var navUserRole  = document.getElementById('navUserRole');
  var sidebarName  = document.getElementById('sidebarUserName');
  var sidebarRole  = document.getElementById('sidebarUserRole');
  var adminSection = document.getElementById('adminMenuSection');

  if (navUserName)  navUserName.textContent  = user.fullName;
  if (navUserRole)  navUserRole.textContent  = roleLabel;
  if (sidebarName)  sidebarName.textContent  = user.fullName;
  if (sidebarRole)  sidebarRole.textContent  = roleLabel;

  if (adminSection) {
    if (user.role === 'Admin') adminSection.classList.remove('hidden');
    else                       adminSection.classList.add('hidden');
  }

  document.querySelectorAll('.sidebar-menu-item[data-roles]').forEach(function(btn) {
    var roles = (btn.dataset.roles || '').split(',');
    btn.style.display = roles.indexOf(user.role) !== -1 ? '' : 'none';
  });

  renderBottomNav();
}

function initApp() {
  showLoading('กำลังตรวจสอบสถานะ...');
  google.script.run
    .withSuccessHandler(function(result) {
      hideLoading();
      if (result && result.success && result.user) {
        setCurrentUser(result.user);
        switchPage('dashboard');
      } else {
        showLoginPage();
      }
    })
    .withFailureHandler(function() {
      hideLoading();
      showLoginPage();
    })
    .getSessionUser();
}

function showLoginPage() {
  currentUser = null;
  try { sessionStorage.removeItem('currentUser'); } catch(e) {}

  var topNav  = document.getElementById('topNav');
  var sidebar = document.getElementById('sidebar');
  var botNav  = document.getElementById('bottomNav');
  if (topNav)  topNav.classList.add('hidden');
  if (sidebar) sidebar.classList.add('-translate-x-full');
  if (botNav)  botNav.style.display = 'none';

  var container = document.getElementById('pageContainer');
  if (!container) return;
  container.style.paddingTop = '0';

  var tpl = document.getElementById('tpl-login');
  if (tpl) {
    container.innerHTML = tpl.innerHTML;
    reExecuteScripts(container);
  }
}

function handleLogin() {
  var usernameEl = document.getElementById('loginUsername');
  var passwordEl = document.getElementById('loginPassword');
  if (!usernameEl || !passwordEl) return;

  var username = usernameEl.value.trim();
  var password = passwordEl.value;
  var valid    = true;

  if (!username) { showFieldError('loginUsername', 'กรุณากรอก Username'); valid = false; }
  else             clearFieldError('loginUsername');
  if (!password) { showFieldError('loginPassword', 'กรุณากรอก Password'); valid = false; }
  else             clearFieldError('loginPassword');
  if (!valid) return;

  var btn = document.getElementById('loginBtn');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML =
      '<span style="display:inline-block;width:16px;height:16px;' +
      'border:2px solid #fff;border-top-color:transparent;border-radius:50%;' +
      'animation:spin 0.8s linear infinite;' +
      'margin-right:8px;vertical-align:middle;"></span>กำลังเข้าสู่ระบบ...';
  }

  showLoading('กำลังตรวจสอบสิทธิ์...');

  google.script.run
    .withSuccessHandler(function(result) {
      hideLoading();
      if (btn) { btn.disabled = false; btn.innerHTML = 'เข้าสู่ระบบ'; }

      if (result && result.success) {
        setCurrentUser(result.user);
        Swal.fire({
          icon: 'success', title: 'เข้าสู่ระบบสำเร็จ', text: result.message,
          timer: 1500, showConfirmButton: false, timerProgressBar: true
        }).then(function() { switchPage('dashboard'); });
      } else {
        Swal.fire({
          icon: 'error', title: 'เข้าสู่ระบบไม่สำเร็จ',
          text: result ? result.message : 'เกิดข้อผิดพลาด',
          confirmButtonText: 'ลองใหม่', confirmButtonColor: '#2563eb'
        });
      }
    })
    .withFailureHandler(function(err) {
      hideLoading();
      if (btn) { btn.disabled = false; btn.innerHTML = 'เข้าสู่ระบบ'; }
      Swal.fire({
        icon: 'error', title: 'เกิดข้อผิดพลาด',
        text: 'ไม่สามารถเชื่อมต่อระบบได้: ' + (err.message || ''),
        confirmButtonColor: '#2563eb'
      });
    })
    .loginUser(username, password);
}

function handleLogout() {
  Swal.fire({
    icon: 'question', title: 'ออกจากระบบ?', text: 'ต้องการออกจากระบบหรือไม่',
    showCancelButton: true,
    confirmButtonText: 'ออกจากระบบ', cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#ef4444', cancelButtonColor: '#6b7280'
  }).then(function(result) {
    if (!result.isConfirmed) return;
    stopScanner();
    showLoading('กำลังออกจากระบบ...');
    google.script.run
      .withSuccessHandler(function() {
        hideLoading();
        showLoginPage();
        showToast('ออกจากระบบสำเร็จ', 'success');
      })
      .withFailureHandler(function() {
        hideLoading();
        showLoginPage();
      })
      .logoutUser();
  });
}

// ============================================================
// SECTION 6: ROUTING
// ============================================================

function checkPermission(pageName) {
  if (!currentUser) return false;
  if (currentUser.role === 'Admin') return true;
  var permissions = {
    'dashboard':      ['Admin','Staff','Viewer','Purchasing'],
    'add-product':    ['Admin','Staff'],
    'initial-stock':  ['Admin','Staff'],
    'monthly-form':   ['Admin','Staff'],
    'stock-in':       ['Admin','Staff'],
    'stock-out':      ['Admin','Staff'],
    'stock-table':    ['Admin','Staff','Viewer','Purchasing'],
    'medical-supplies':['Admin','Staff','Viewer','Purchasing'],
    'supply-init':    ['Admin','Staff'],
    'history':        ['Admin','Staff','Viewer'],
    'admin-products': ['Admin'],
    'admin-users':    ['Admin'],
    'config':         ['Admin']
  };
  var allowed = permissions[pageName] || [];
  return allowed.indexOf(currentUser.role) !== -1;
}

function switchPage(pageName) {
  if (!currentUser)               { showLoginPage(); return; }
  if (!checkPermission(pageName)) {
    showToast('คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
    return;
  }

  stopScanner();
  closeCustomScanner();
  currentPage = pageName;

  var topNav    = document.getElementById('topNav');
  var container = document.getElementById('pageContainer');
  if (topNav)    topNav.classList.remove('hidden');
  if (container) container.style.paddingTop = '56px';

  var pageTitles = {
    'dashboard':      'แดชบอร์ด',
    'add-product':    'เพิ่มสินค้า',
    'initial-stock':  'ตั้งค่าสต็อกเริ่มต้น',
    'monthly-form':   'แบบฟอร์มเบิกยาประจำเดือน',
    'stock-in':       'รับของเข้า',
    'stock-out':      'เบิกออก',
    'stock-table':    'สต็อกคงเหลือ',
    'medical-supplies':'เวชภัณฑ์ที่มิใช่ยา',
    'supply-init':    'ตั้งค่าสต็อกเริ่มต้น (เวชภัณฑ์มิใช่ยา)',
    'history':        'ประวัติรายการ',
    'admin-products': 'จัดการสินค้า',
    'admin-users':    'จัดการผู้ใช้',
    'config':         'ตั้งค่าระบบ'
  };

  var navTitle = document.getElementById('navTitle');
  if (navTitle) navTitle.textContent = pageTitles[pageName] || 'คลังยา';

  closeSidebar();

  document.querySelectorAll('.sidebar-menu-item').forEach(function(item) {
    item.classList.remove('active');
    if (item.dataset.page === pageName) item.classList.add('active');
  });

  var tpl = document.getElementById('tpl-' + pageName);
  if (!tpl) {
    if (container) container.innerHTML =
      '<div class="empty-state"><p>ไม่พบหน้า: ' + escapeHtml(pageName) + '</p></div>';
    return;
  }

  if (container) {
    container.innerHTML = '<div class="page-content">' + tpl.innerHTML + '</div>';
    reExecuteScripts(container);
  }

  setTimeout(function() {
    var initMap = {
      'dashboard':      'loadDashboard',
      'initial-stock':  'loadInitialStock',
      'monthly-form':   'loadMonthlyForm',
      'stock-table':    'loadStockTable',
      'medical-supplies':'loadMedicalSupplies',
      'supply-init':    'loadSupplyInit',
      'history':        'loadHistory',
      'admin-products': 'loadAdminProducts',
      'admin-users':    'loadAdminUsers',
      'config':         'loadSystemConfig'
    };
    var fnName = initMap[pageName];
    if (fnName && typeof window[fnName] === 'function') window[fnName]();
  }, 50);

  updateBottomNavActive(pageName);
  window.scrollTo(0, 0);
}

// ============================================================
// SECTION 7: SIDEBAR / NAV
// ============================================================

function toggleSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');
  if (!sidebar) return;
  if (sidebar.classList.contains('-translate-x-full')) {
    sidebar.classList.remove('-translate-x-full');
    if (overlay) overlay.classList.remove('hidden');
  } else {
    closeSidebar();
  }
}

function closeSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');
  if (sidebar) sidebar.classList.add('-translate-x-full');
  if (overlay) overlay.classList.add('hidden');
}

function updateBottomNavActive(pageName) {
  document.querySelectorAll('.bottom-nav-item').forEach(function(item) {
    item.classList.remove('active');
    if (item.dataset.page === pageName) item.classList.add('active');
  });
}

function renderBottomNav() {
  var nav = document.getElementById('bottomNav');
  if (!nav || !currentUser) return;
  var role    = currentUser.role;
  var isStaff = (role === 'Admin' || role === 'Staff');

  nav.innerHTML =
    '<button class="bottom-nav-item" data-page="dashboard" ' +
        'onclick="switchPage(\'dashboard\')">' +
      '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
          'd="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>' +
      '</svg>หน้าหลัก' +
    '</button>' +

    (isStaff
      ? '<button class="bottom-nav-item" data-page="stock-in" ' +
            'onclick="switchPage(\'stock-in\')">' +
          '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
              'd="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/>' +
          '</svg>รับเข้า' +
        '</button>' +
        '<button class="bottom-nav-item" data-page="stock-out" ' +
            'onclick="switchPage(\'stock-out\')">' +
          '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
              'd="M17 8V20M17 20l4-4m-4 4l-4-4M7 4v12M7 4L3 8m4-4l4 4"/>' +
          '</svg>เบิกออก' +
        '</button>'
      : '') +

    '<button class="bottom-nav-item" data-page="stock-table" ' +
        'onclick="switchPage(\'stock-table\')">' +
      '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
          'd="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2' +
          'M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>' +
      '</svg>สต็อก' +
    '</button>' +

    '<button class="bottom-nav-item" data-page="history" ' +
        'onclick="switchPage(\'history\')">' +
      '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
          'd="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>' +
      '</svg>ประวัติ' +
    '</button>';

  nav.style.display = 'flex';
}

// ============================================================
// _initScanHints - ตรวจสอบ ZXing และกำหนด hints
// ============================================================
function _initScanHints() {
  // ตรวจสอบ ZXing พร้อมใช้งานและมี BarcodeFormat
  if (typeof ZXing === 'undefined')           return null;
  if (!ZXing.BarcodeFormat)                   return null;
  if (!ZXing.DecodeHintType)                  return null;

  try {
    var hints   = new Map();
    var formats = [
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.CODE_93,
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E,
      ZXing.BarcodeFormat.ITF,
      ZXing.BarcodeFormat.CODABAR
    ].filter(function(f) { return f !== undefined && f !== null; });

    if (formats.length > 0) {
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    }
    return hints.size > 0 ? hints : null;
  } catch(e) {
    console.warn('ZXing hints error:', e);
    return null;
  }
}

// ============================================================
// SECTION 8: SCANNER MODULE (1D Barcode)
// ============================================================

// ── _initScanHints ───────────────────────────────────────────
// function _initScanHints() {
//   if (typeof ZXing === 'undefined' || !ZXing.DecodeHintType) return null;
//   try {
//     var hints   = new Map();
//     var formats = [
//       ZXing.BarcodeFormat.CODE_128,
//       ZXing.BarcodeFormat.CODE_39,
//       ZXing.BarcodeFormat.CODE_93,
//       ZXing.BarcodeFormat.EAN_13,
//       ZXing.BarcodeFormat.EAN_8,
//       ZXing.BarcodeFormat.UPC_A,
//       ZXing.BarcodeFormat.UPC_E,
//       ZXing.BarcodeFormat.ITF,
//       ZXing.BarcodeFormat.CODABAR
//     ].filter(Boolean);

//     if (formats.length > 0) {
//       hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
//       hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
//     }
//     return hints;
//   } catch(e) {
//     return null;
//   }
// }

// ── startScanner ─────────────────────────────────────────────
// ============================================================
// startScanner - entry point พร้อม async ZXing check
// ============================================================
function startScanner(callback) {
  onBarcodeDetectedCallback = callback;

  // ตรวจสอบ ZXing พร้อมใช้งานหรือยัง
  if (typeof ZXing !== 'undefined') {
    // โหลดแล้ว → เปิดกล้องได้เลย
    _buildScannerModal();
    _startCamera();
    return;
  }

  // ยังโหลดไม่เสร็จ → รอ
  showLoading('กำลังโหลด Barcode Library...');
  var waited  = 0;
  var maxWait = 8000; // รอสูงสุด 8 วินาที
  var timer   = setInterval(function() {
    waited += 200;
    if (typeof ZXing !== 'undefined') {
      clearInterval(timer);
      hideLoading();
      _buildScannerModal();
      _startCamera();
    } else if (waited >= maxWait) {
      clearInterval(timer);
      hideLoading();
      // โหลดไม่ได้ → fallback กรอกเอง
      _showFallbackOptions();
    }
  }, 200);
}
// function startScanner(callback) {
//   onBarcodeDetectedCallback = callback;
//   if (typeof ZXing === 'undefined') {
//     _showManualInput('ไม่สามารถโหลด Barcode Library ได้');
//     return;
//   }
//   _buildScannerModal();
//   _startCamera();
// }

// ── _buildScannerModal ───────────────────────────────────────
function _buildScannerModal() {
  var old = document.getElementById('scannerUIModal');
  if (old) old.remove();

  var modal    = document.createElement('div');
  modal.id     = 'scannerUIModal';
  modal.style.cssText =
    'position:fixed;inset:0;z-index:10001;background:#000;' +
    'display:flex;flex-direction:column;align-items:center;' +
    'justify-content:flex-start;box-sizing:border-box;overflow:hidden;';

  modal.innerHTML =
    // Top Bar
    '<div style="width:100%;display:flex;align-items:center;justify-content:space-between;' +
         'padding:12px 16px;background:rgba(0,0,0,0.6);z-index:2;' +
         'flex-shrink:0;box-sizing:border-box;">' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div style="width:30px;height:30px;background:rgba(255,255,255,0.15);' +
             'border-radius:8px;display:flex;align-items:center;justify-content:center;">' +
          _svgIcon('barcode','white') +
        '</div>' +
        '<div>' +
          '<div style="color:#fff;font-weight:700;font-size:15px;' +
               'font-family:\'Noto Sans Thai\',sans-serif;">สแกนบาร์โค้ดแท่ง</div>' +
          '<div style="color:rgba(255,255,255,0.55);font-size:11px;' +
               'font-family:\'Noto Sans Thai\',sans-serif;">' +
            'Code128 · EAN-13 · EAN-8 · UPC · Code39' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button onclick="closeCustomScanner()" ' +
        'style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;' +
               'width:34px;height:34px;cursor:pointer;color:#fff;font-size:18px;' +
               'display:flex;align-items:center;justify-content:center;' +
               'font-family:sans-serif;padding:0;flex-shrink:0;">✕</button>' +
    '</div>' +

    // Camera Area
    '<div id="scanVideoWrap" ' +
         'style="position:relative;width:100%;flex:1;background:#000;' +
                'overflow:hidden;min-height:0;">' +
      '<video id="scanLiveVideo" autoplay playsinline muted webkit-playsinline ' +
        'style="width:100%;height:100%;object-fit:cover;display:block;"></video>' +

      // SVG dark mask
      '<svg id="scanDarkMask" ' +
           'style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" ' +
           'preserveAspectRatio="none">' +
        '<defs><mask id="scanMask">' +
          '<rect width="100%" height="100%" fill="white"/>' +
          '<rect id="scanHoleRect" fill="black" rx="8" ry="8"/>' +
        '</mask></defs>' +
        '<rect width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#scanMask)"/>' +
      '</svg>' +

      // กรอบสแกน
      '<div id="scanBoxEl" ' +
           'style="position:absolute;top:50%;left:50%;' +
                  'transform:translate(-50%,-50%);' +
                  'width:' + SCAN_BOX_W + 'px;height:' + SCAN_BOX_H + 'px;' +
                  'pointer-events:none;">' +
        // เส้นสแกน
        '<div style="position:absolute;top:50%;left:6px;right:6px;height:2px;margin-top:-1px;' +
             'background:linear-gradient(90deg,transparent,#60a5fa 30%,#3b82f6 50%,' +
             '#60a5fa 70%,transparent);' +
             'box-shadow:0 0 10px rgba(59,130,246,0.9),0 0 20px rgba(59,130,246,0.5);' +
             'border-radius:2px;animation:scanLineLR 1.2s ease-in-out infinite;"></div>' +
        // มุมกรอบ
        _scanCorner('top:0;left:0',    'border-top','border-left',    'border-top-left-radius') +
        _scanCorner('top:0;right:0',   'border-top','border-right',   'border-top-right-radius') +
        _scanCorner('bottom:0;left:0', 'border-bottom','border-left', 'border-bottom-left-radius') +
        _scanCorner('bottom:0;right:0','border-bottom','border-right','border-bottom-right-radius') +
      '</div>' +

      // Loading overlay
      '<div id="scanLoadingOverlay" ' +
           'style="position:absolute;inset:0;background:rgba(0,0,0,0.75);' +
                  'display:flex;flex-direction:column;align-items:center;' +
                  'justify-content:center;gap:14px;">' +
        '<div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.15);' +
             'border-top-color:#3b82f6;border-radius:50%;' +
             'animation:scanSpin 0.8s linear infinite;"></div>' +
        '<span style="color:#93c5fd;font-size:14px;' +
              'font-family:\'Noto Sans Thai\',sans-serif;">กำลังเปิดกล้อง...</span>' +
      '</div>' +
    '</div>' +

    // Bottom Panel
    '<div style="width:100%;background:rgba(0,0,0,0.85);flex-shrink:0;' +
         'padding:14px 16px 20px;box-sizing:border-box;">' +
      '<div id="scanStatusText" ' +
           'style="text-align:center;color:#93c5fd;font-size:13px;' +
                  'font-family:\'Noto Sans Thai\',sans-serif;margin-bottom:12px;' +
                  'min-height:18px;">กำลังขอสิทธิ์กล้อง...</div>' +
      '<div style="text-align:center;margin-bottom:12px;">' +
        '<span style="display:inline-block;background:rgba(59,130,246,0.2);' +
              'border:1px solid rgba(59,130,246,0.4);border-radius:20px;' +
              'padding:3px 14px;color:#93c5fd;font-size:11px;' +
              'font-family:\'Noto Sans Thai\',sans-serif;">' +
          '📏 กรอบสแกน ' + SCAN_BOX_W + ' × ' + SCAN_BOX_H + ' px' +
        '</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<input type="text" id="scanManualCode" ' +
          'style="flex:1;min-width:0;padding:11px 14px;' +
                 'background:rgba(255,255,255,0.1);' +
                 'border:1.5px solid rgba(255,255,255,0.2);' +
                 'border-radius:10px;font-size:14px;outline:none;color:#fff;' +
                 'font-family:\'Noto Sans Thai\',sans-serif;box-sizing:border-box;" ' +
          'placeholder="หรือกรอกบาร์โค้ดเอง" ' +
          'onkeydown="if(event.key===\'Enter\')confirmScanManual()" ' +
          'onfocus="this.style.borderColor=\'#3b82f6\'" ' +
          'onblur="this.style.borderColor=\'rgba(255,255,255,0.2)\'">' +
        '<button onclick="confirmScanManual()" ' +
          'style="flex-shrink:0;padding:11px 18px;' +
                 'background:linear-gradient(135deg,#3b82f6,#1d4ed8);' +
                 'color:#fff;border:none;border-radius:10px;font-size:14px;' +
                 'font-weight:700;cursor:pointer;white-space:nowrap;' +
                 'font-family:\'Noto Sans Thai\',sans-serif;">ยืนยัน</button>' +
      '</div>' +
      '<button onclick="closeCustomScanner()" ' +
        'style="width:100%;margin-top:10px;padding:11px;' +
               'background:rgba(255,255,255,0.08);' +
               'border:1px solid rgba(255,255,255,0.15);' +
               'border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;' +
               'cursor:pointer;font-family:\'Noto Sans Thai\',sans-serif;">ยกเลิก</button>' +
    '</div>' +

    '<style>' +
      '@keyframes scanSpin   { to { transform:rotate(360deg) } }' +
      '@keyframes scanLineLR {' +
        '0%,100% { opacity:0.4;transform:scaleX(0.3) }' +
        '50%     { opacity:1;  transform:scaleX(1)   }' +
      '}' +
      '@keyframes spin { to { transform:rotate(360deg) } }' +
    '</style>';

  document.body.appendChild(modal);
}

// ── Scanner Helpers ───────────────────────────────────────────

function _scanCorner(pos, b1, b2, radius) {
  return (
    '<div style="position:absolute;' + pos + ';width:22px;height:22px;' +
    b1 + ':3px solid #3b82f6;' + b2 + ':3px solid #3b82f6;' +
    radius + ':6px;"></div>'
  );
}

function _svgIcon(name, stroke) {
  stroke   = stroke || 'currentColor';
  var size = (name === 'barcode') ? '18' : '22';
  var paths = {
    barcode:
      '<rect x="4" y="4" width="2" height="16" fill="' + stroke + '"/>' +
      '<rect x="8" y="4" width="1" height="16" fill="' + stroke + '"/>' +
      '<rect x="11" y="4" width="3" height="16" fill="' + stroke + '"/>' +
      '<rect x="16" y="4" width="1" height="16" fill="' + stroke + '"/>' +
      '<rect x="19" y="4" width="1" height="16" fill="' + stroke + '"/>',
    camera:
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
      'd="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4' +
      'h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9' +
      'a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>' +
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
      'd="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>',
    gallery:
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
      'd="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0' +
      'L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>'
  };
  if (name === 'barcode') {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24">' +
           (paths[name] || '') + '</svg>';
  }
  return '<svg width="' + size + '" height="' + size + '" fill="none" ' +
         'stroke="' + stroke + '" viewBox="0 0 24 24">' +
         (paths[name] || '') + '</svg>';
}

function _optionCard(bg, border, iconBg, titleColor, subColor, icon, title, sub) {
  return (
    '<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;' +
         'background:' + bg + ';border:2px solid ' + border + ';border-radius:14px;">' +
      '<div style="width:48px;height:48px;flex-shrink:0;background:' + iconBg + ';' +
           'border-radius:12px;display:flex;align-items:center;justify-content:center;">' +
        icon +
      '</div>' +
      '<div>' +
        '<div style="font-weight:700;color:' + titleColor + ';font-size:14px;' +
             'font-family:\'Noto Sans Thai\',sans-serif;">' + title + '</div>' +
        '<div style="font-size:12px;color:' + subColor + ';margin-top:3px;' +
             'font-family:\'Noto Sans Thai\',sans-serif;">' + sub + '</div>' +
      '</div>' +
    '</div>'
  );
}

// ── Camera ───────────────────────────────────────────────────

function _startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _setScanStatus('Browser นี้ไม่รองรับกล้อง');
    _hideScanLoading();
    return;
  }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  })
  .then(function(stream) {
    scannerStream        = stream;
    _scanVideo           = document.getElementById('scanLiveVideo');
    if (!_scanVideo)     { _stopStream(stream); return; }
    _scanVideo.srcObject = stream;
    _scanVideo.onloadedmetadata = function() {
      _scanVideo.play();
      _updateScanMask();
      _hideScanLoading();
      _setScanStatus('จ่อบาร์โค้ดแท่งให้อยู่ในกรอบ แนวนอน');
      _startDecodeLoop();
    };
  })
  .catch(function(err) {
    _hideScanLoading();
    _handleCameraErr(err);
  });
}

function _updateScanMask() {
  var wrap = document.getElementById('scanVideoWrap');
  var hole = document.getElementById('scanHoleRect');
  if (!wrap || !hole) return;
  var wrapW = wrap.offsetWidth  || 380;
  var wrapH = wrap.offsetHeight || 300;
  hole.setAttribute('x',      (wrapW - SCAN_BOX_W) / 2);
  hole.setAttribute('y',      (wrapH - SCAN_BOX_H) / 2);
  hole.setAttribute('width',  SCAN_BOX_W);
  hole.setAttribute('height', SCAN_BOX_H);
}

function _startDecodeLoop() {
  _scanCanvas        = document.createElement('canvas');
  _scanCanvas.width  = SCAN_BOX_W;
  _scanCanvas.height = SCAN_BOX_H;
  _scanCtx           = _scanCanvas.getContext('2d');

  _scanHints = _initScanHints();
  if (_scanReader) { try { _scanReader.reset(); } catch(e) {} }
  _scanReader = _scanHints
    ? new ZXing.BrowserMultiFormatReader(_scanHints)
    : new ZXing.BrowserMultiFormatReader();

  scannerActive = true;

  _scanTimer = setInterval(function() {
    if (!_scanVideo || _scanVideo.readyState < 2 || !scannerActive) return;
    var vw = _scanVideo.videoWidth;
    var vh = _scanVideo.videoHeight;
    if (!vw || !vh) return;

    var displayW = _scanVideo.offsetWidth  || _scanVideo.clientWidth  || 380;
    var displayH = _scanVideo.offsetHeight || _scanVideo.clientHeight || 300;
    var scale    = Math.max(vw / displayW, vh / displayH);
    var cropW    = SCAN_BOX_W * scale;
    var cropH    = SCAN_BOX_H * scale;
    var cropX    = Math.max(0, Math.min(vw / 2 - cropW / 2, vw - cropW));
    var cropY    = Math.max(0, Math.min(vh / 2 - cropH / 2, vh - cropH));

    _scanCtx.drawImage(_scanVideo, cropX, cropY, cropW, cropH, 0, 0, SCAN_BOX_W, SCAN_BOX_H);
    _decodeFromCanvas();
  }, SCAN_INTERVAL);
}

function _decodeFromCanvas() {
  if (!_scanCanvas || !_scanReader) return;
  var promise;
  try {
    if (typeof _scanReader.decodeFromCanvas === 'function') {
      promise = Promise.resolve(_scanReader.decodeFromCanvas(_scanCanvas));
    } else {
      var tmp = new Image();
      promise = new Promise(function(resolve, reject) {
        tmp.onload  = function() {
          try   { resolve(_scanReader.decodeFromImage(tmp)); }
          catch (e) { reject(e); }
        };
        tmp.onerror = reject;
        tmp.src     = _scanCanvas.toDataURL('image/jpeg', 0.85);
      });
    }
  } catch(e) { return; }

  promise
    .then(function(result) {
      if (!result) return;
      var code = result.getText ? result.getText() : String(result);
      if (!code || !code.trim()) return;
      _setScanStatus('✅ สแกนได้: ' + code);
      _flashSuccess();
      _stopDecodeLoop();
      setTimeout(function() {
        closeCustomScanner();
        showToast('✅ สแกนได้: ' + code, 'success', 3000);
        if (onBarcodeDetectedCallback) onBarcodeDetectedCallback(code.trim());
      }, 500);
    })
    .catch(function() { /* ไม่เจอ barcode → รอ loop ถัดไป */ });
}

function _flashSuccess() {
  var box = document.getElementById('scanBoxEl');
  if (!box) return;
  box.querySelectorAll('div').forEach(function(d) {
    d.style.borderColor = '#22c55e';
    d.style.transition  = 'border-color 0.2s';
  });
  var line = box.querySelector('div:first-child');
  if (line) {
    line.style.background = 'linear-gradient(90deg,transparent,#22c55e,transparent)';
    line.style.boxShadow  = '0 0 10px rgba(34,197,94,0.9),0 0 20px rgba(34,197,94,0.5)';
  }
}

function _stopDecodeLoop() {
  scannerActive = false;
  if (_scanTimer)  { clearInterval(_scanTimer); _scanTimer = null; }
  if (_scanReader) { try { _scanReader.reset(); } catch(e) {} _scanReader = null; }
}

function _stopStream(stream) {
  if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
}

function _handleCameraErr(err) {
  console.warn('Camera error:', err.name, err.message);
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    _setScanStatus('');
    closeCustomScanner();
    _showFallbackOptions();
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    _setScanStatus('ไม่พบกล้อง');
    setTimeout(function() { closeCustomScanner(); _showManualInput('ไม่พบกล้อง'); }, 1200);
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    _setScanStatus('กล้องถูกใช้งานโดย App อื่น');
    setTimeout(function() { closeCustomScanner(); _showManualInput('กล้องถูกใช้งานอยู่'); }, 1200);
  } else if (err.name === 'OverconstrainedError') {
    _retryCamera();
  } else {
    _setScanStatus('เปิดกล้องไม่ได้');
    setTimeout(function() { closeCustomScanner(); _showFallbackOptions(); }, 1500);
  }
}

function _retryCamera() {
  navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    .then(function(stream) {
      scannerStream        = stream;
      _scanVideo           = document.getElementById('scanLiveVideo');
      if (!_scanVideo)     { _stopStream(stream); return; }
      _scanVideo.srcObject = stream;
      _scanVideo.onloadedmetadata = function() {
        _scanVideo.play();
        _updateScanMask();
        _hideScanLoading();
        _setScanStatus('จ่อบาร์โค้ดแท่งให้อยู่ในกรอบ');
        _startDecodeLoop();
      };
    })
    .catch(function() {
      _hideScanLoading();
      closeCustomScanner();
      _showFallbackOptions();
    });
}

function _showFallbackOptions() {
  var old = document.getElementById('scannerUIModal');
  if (old) old.remove();

  var modal    = document.createElement('div');
  modal.id     = 'scannerUIModal';
  modal.style.cssText =
    'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.88);' +
    'display:flex;align-items:center;justify-content:center;' +
    'padding:16px;box-sizing:border-box;';

  modal.innerHTML =
    '<div style="background:#fff;border-radius:20px;width:100%;max-width:360px;' +
         'box-shadow:0 25px 60px rgba(0,0,0,0.5);overflow:hidden;">' +
      '<div style="background:linear-gradient(135deg,#1e40af,#3b82f6);' +
           'padding:16px 20px;display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="color:#fff;font-weight:700;font-size:16px;' +
              'font-family:\'Noto Sans Thai\',sans-serif;">สแกนบาร์โค้ด</span>' +
        '<button onclick="closeCustomScanner()" ' +
          'style="background:rgba(255,255,255,0.2);border:none;border-radius:8px;' +
                 'width:32px;height:32px;cursor:pointer;color:#fff;font-size:18px;' +
                 'display:flex;align-items:center;justify-content:center;padding:0;">✕</button>' +
      '</div>' +
      '<div style="padding:20px;display:flex;flex-direction:column;gap:12px;">' +
        '<label style="cursor:pointer;display:block;">' +
          '<input type="file" accept="image/*" capture="environment" ' +
            'style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;" ' +
            'onchange="handleCaptureImage(event)">' +
          _optionCard('#eff6ff','#bfdbfe','#2563eb','#1e40af','#3b82f6',
            _svgIcon('camera','white'),'📷 ถ่ายรูปบาร์โค้ด','ถ่ายรูปแล้วระบบอ่านให้') +
        '</label>' +
        '<label style="cursor:pointer;display:block;">' +
          '<input type="file" accept="image/*" ' +
            'style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;" ' +
            'onchange="handleCaptureImage(event)">' +
          _optionCard('#f0fdf4','#bbf7d0','#16a34a','#15803d','#16a34a',
            _svgIcon('gallery','white'),'🖼️ เลือกรูปจากคลัง','เลือกรูปบาร์โค้ดจากเครื่อง') +
        '</label>' +
        '<div style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:14px;padding:14px;">' +
          '<div style="font-weight:700;color:#374151;font-size:13px;margin-bottom:8px;' +
               'font-family:\'Noto Sans Thai\',sans-serif;">⌨️ กรอกบาร์โค้ดเอง</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<input type="text" id="scanManualCode" ' +
              'style="flex:1;min-width:0;padding:10px 12px;border:1.5px solid #d1d5db;' +
                     'border-radius:8px;font-size:15px;outline:none;' +
                     'font-family:\'Noto Sans Thai\',sans-serif;" ' +
              'placeholder="กรอกบาร์โค้ด" ' +
              'onkeydown="if(event.key===\'Enter\')confirmScanManual()">' +
            '<button onclick="confirmScanManual()" ' +
              'style="flex-shrink:0;padding:10px 16px;' +
                     'background:linear-gradient(135deg,#3b82f6,#1d4ed8);' +
                     'color:#fff;border:none;border-radius:8px;font-size:14px;' +
                     'font-weight:700;cursor:pointer;white-space:nowrap;' +
                     'font-family:\'Noto Sans Thai\',sans-serif;">ยืนยัน</button>' +
          '</div>' +
        '</div>' +
        '<div id="scanProcessStatus" style="display:none;text-align:center;' +
             'padding:12px;background:#eff6ff;border-radius:10px;">' +
          '<div style="display:flex;align-items:center;justify-content:center;gap:8px;">' +
            '<div style="width:16px;height:16px;border:2px solid #3b82f6;' +
                 'border-top-color:transparent;border-radius:50%;' +
                 'animation:scanSpin 0.8s linear infinite;"></div>' +
            '<span id="scanProcessText" ' +
                  'style="font-size:13px;color:#1d4ed8;font-weight:600;' +
                         'font-family:\'Noto Sans Thai\',sans-serif;">' +
              'กำลังอ่านบาร์โค้ด...' +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div id="scanErrorBox" style="display:none;padding:12px;background:#fef2f2;' +
             'border-radius:10px;border:1px solid #fecaca;">' +
          '<div id="scanErrorText" ' +
               'style="font-size:13px;color:#dc2626;font-weight:600;' +
                      'font-family:\'Noto Sans Thai\',sans-serif;"></div>' +
          '<div style="font-size:12px;color:#ef4444;margin-top:3px;' +
               'font-family:\'Noto Sans Thai\',sans-serif;">กรุณาถ่ายใหม่ให้ชัดขึ้น</div>' +
        '</div>' +
      '</div>' +
      '<style>@keyframes scanSpin{to{transform:rotate(360deg)}}</style>' +
    '</div>';

  document.body.appendChild(modal);
}

// ── Scanner Status Helpers ────────────────────────────────────

function _setScanStatus(text) {
  var el = document.getElementById('scanStatusText');
  if (el) el.textContent = text;
}
function _hideScanLoading() {
  var el = document.getElementById('scanLoadingOverlay');
  if (!el) return;
  el.style.opacity    = '0';
  el.style.transition = 'opacity 0.3s';
  setTimeout(function() { if (el.parentNode) el.remove(); }, 300);
}
function _showScanStatus(text) {
  var el  = document.getElementById('scanProcessStatus');
  var txt = document.getElementById('scanProcessText');
  if (txt) txt.textContent = text;
  if (el)  el.style.display = 'block';
}
function _hideScanStatus() {
  var el = document.getElementById('scanProcessStatus');
  if (el) el.style.display = 'none';
}
function _showScanError(text) {
  var el  = document.getElementById('scanErrorBox');
  var txt = document.getElementById('scanErrorText');
  if (txt) txt.textContent = '❌ ' + text;
  if (el)  el.style.display = 'block';
}
function _hideScanError() {
  var el = document.getElementById('scanErrorBox');
  if (el) el.style.display = 'none';
}

// ── Image Capture Fallback ────────────────────────────────────

function handleCaptureImage(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.value = '';
  _hideScanError();
  if (!file.type.startsWith('image/')) { _showScanError('ไฟล์ที่เลือกไม่ใช่รูปภาพ'); return; }
  if (file.size > 15 * 1024 * 1024)   { _showScanError('รูปภาพใหญ่เกินไป (สูงสุด 15MB)'); return; }
  _showScanStatus('กำลังโหลดรูปภาพ...');
  var reader    = new FileReader();
  reader.onload = function(e) {
    var img    = new Image();
    img.onload = function() {
      _showScanStatus('กำลังวิเคราะห์บาร์โค้ด...');
      setTimeout(function() { _decodeImageStatic(img); }, 50);
    };
    img.onerror = function() { _hideScanStatus(); _showScanError('โหลดรูปไม่สำเร็จ'); };
    img.src     = e.target.result;
  };
  reader.onerror = function() { _hideScanStatus(); _showScanError('อ่านไฟล์ไม่สำเร็จ'); };
  reader.readAsDataURL(file);
}

function _decodeImageStatic(imgElement) {
  var canvas = document.createElement('canvas');
  var ctx    = canvas.getContext('2d');
  var w = imgElement.naturalWidth  || imgElement.width;
  var h = imgElement.naturalHeight || imgElement.height;
  if (!w || !h) { _hideScanStatus(); _showScanError('รูปภาพไม่ถูกต้อง'); return; }
  var scale     = Math.min(1280/w, 1280/h, 1);
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
  _decodeStaticCanvas(canvas, ctx, imgElement, false);
}

function _decodeStaticCanvas(canvas, ctx, imgElement, isRetry) {
  var hints = _initScanHints();
  var cr    = hints
    ? new ZXing.BrowserMultiFormatReader(hints)
    : new ZXing.BrowserMultiFormatReader();
  var p;
  try {
    if (typeof cr.decodeFromCanvas === 'function') {
      p = Promise.resolve(cr.decodeFromCanvas(canvas));
    } else {
      var tmp = new Image();
      p = new Promise(function(res, rej) {
        tmp.onload  = function() { try { res(cr.decodeFromImage(tmp)); } catch(e) { rej(e); } };
        tmp.onerror = rej;
        tmp.src     = canvas.toDataURL('image/png');
      });
    }
  } catch(e) { p = Promise.reject(e); }

  p.then(function(result) {
    try { cr.reset(); } catch(e) {}
    _hideScanStatus(); _hideScanError();
    var code = result.getText ? result.getText() : String(result);
    if (!code || !code.trim()) { _showScanError('อ่านได้ค่าว่าง กรุณาถ่ายใหม่'); return; }
    if (navigator.vibrate) navigator.vibrate([80,40,80]);
    closeCustomScanner();
    showToast('✅ สแกนได้: ' + code, 'success', 3000);
    if (onBarcodeDetectedCallback) onBarcodeDetectedCallback(code.trim());
  }).catch(function() {
    try { cr.reset(); } catch(e) {}
    if (!isRetry) {
      _showScanStatus('ปรับคุณภาพภาพแล้วลองใหม่...');
      setTimeout(function() {
        ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
        try {
          var id = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var d  = id.data;
          for (var i = 0; i < d.length; i += 4) {
            var g = Math.max(0, Math.min(255,
              (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2] - 128) * 1.6 + 128
            ));
            d[i] = d[i+1] = d[i+2] = g;
          }
          ctx.putImageData(id, 0, 0);
        } catch(e) {}
        _decodeStaticCanvas(canvas, ctx, imgElement, true);
      }, 50);
    } else {
      _hideScanStatus();
      _showScanError('อ่านบาร์โค้ดไม่สำเร็จ รูปอาจเบลอหรือมืดเกิน');
    }
  });
}

// ── Scanner Actions ───────────────────────────────────────────

function confirmScanManual() {
  var input = document.getElementById('scanManualCode');
  if (!input) return;
  var val = input.value.trim();
  if (!val) {
    input.style.borderColor = '#ef4444';
    input.style.boxShadow   = '0 0 0 3px rgba(239,68,68,0.15)';
    input.focus();
    return;
  }
  closeCustomScanner();
  if (onBarcodeDetectedCallback) onBarcodeDetectedCallback(val);
}

function closeCustomScanner() {
  _stopDecodeLoop();
  if (scannerStream) { _stopStream(scannerStream); scannerStream = null; }
  _scanVideo = null;
  var modal  = document.getElementById('scannerUIModal');
  if (modal) {
    modal.style.opacity    = '0';
    modal.style.transition = 'opacity 0.2s ease';
    setTimeout(function() { if (modal.parentNode) modal.remove(); }, 200);
  }
}

function closeScannerModal() { closeCustomScanner(); stopScanner(); }

function stopScanner() {
  _stopDecodeLoop();
  if (scannerStream)   { _stopStream(scannerStream); scannerStream = null; }
  if (scannerInstance) { try { scannerInstance.reset(); } catch(e) {} scannerInstance = null; }
  scannerActive = false;
}

function _showManualInput(reason) {
  Swal.fire({
    icon: 'info', title: 'กรอกบาร์โค้ด',
    html:
      (reason
        ? '<p style="font-size:13px;color:#6b7280;margin-bottom:8px;">' +
            escapeHtml(reason) + '</p>'
        : '') +
      '<input id="swalBarcodeInput" type="text" class="swal2-input" ' +
        'placeholder="กรอกบาร์โค้ดที่นี่">',
    confirmButtonText: 'ยืนยัน', confirmButtonColor: '#2563eb',
    showCancelButton: true, cancelButtonText: 'ยกเลิก',
    didOpen: function() {
      var inp = document.getElementById('swalBarcodeInput');
      if (inp) inp.focus();
    },
    preConfirm: function() {
      var val = document.getElementById('swalBarcodeInput').value.trim();
      if (!val) { Swal.showValidationMessage('กรุณากรอกบาร์โค้ด'); return false; }
      return val;
    }
  }).then(function(result) {
    if (result.isConfirmed && onBarcodeDetectedCallback) {
      onBarcodeDetectedCallback(result.value);
    }
  });
}

// ============================================================
// SECTION 9: KEYBOARD / INIT
// ============================================================

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !currentUser) {
    var btn = document.getElementById('loginBtn');
    if (btn && !btn.disabled) handleLogin();
  }
  if (e.key === 'Escape') closeCustomScanner();
});

// ============================================================
// EXPORT ฟอร์ม Excel (ตั้งค่าเริ่มต้น / รับเข้า / เบิกออก) — ตัวสร้างร่วม
// ใช้ getProducts + getStockOnHand (มีอยู่แล้ว) ไม่ต้องแก้ backend
// ============================================================
function _dfEnsureExcelJS(cb){
  if (window.ExcelJS) return cb();
  showLoading('กำลังโหลดตัวสร้าง Excel...');
  var s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  s.onload=function(){cb();};
  s.onerror=function(){hideLoading();showToast('โหลดไลบรารี Excel ไม่สำเร็จ','error');};
  document.head.appendChild(s);
}

window.exportDrugForm = function(cfg){
  cfg = cfg || {};
  showLoading('กำลังดึงข้อมูลยา...');
  var products=null, bal=null, done=0;
  function join(){
    if(++done<2) return;
    if(products===null){ hideLoading(); showToast('ดึงข้อมูลไม่สำเร็จ','error'); return; }
    _dfBuild(cfg, products.filter(function(p){return p.active;}), bal||{});
  }
  google.script.run.withSuccessHandler(function(r){products=(r&&r.success)?(r.data||[]):[];join();}).withFailureHandler(function(){products=null;join();}).getProducts();
  google.script.run.withSuccessHandler(function(r){bal={};((r&&r.data)||[]).forEach(function(s){bal[s.barcode]=(bal[s.barcode]||0)+(Number(s.qtyBalance)||0);});join();}).withFailureHandler(function(){bal={};join();}).getStockOnHand({});
};

function _dfBuild(cfg, products, balMap){
  _dfEnsureExcelJS(function(){
    try{
      showLoading('กำลังสร้างไฟล์ Excel...');
      var FONT='TH Sarabun New', cols=cfg.columns||[], N=cols.length;
      var wb=new ExcelJS.Workbook();
      var ws=wb.addWorksheet('ฟอร์ม',{ pageSetup:{paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,horizontalCentered:true,margins:{left:0.4,right:0.4,top:0.55,bottom:0.5,header:0.2,footer:0.2}}, headerFooter:{oddFooter:'&Cหน้า &P / &N'} });
      ws.columns=cols.map(function(c){return {width:c.w||12};});
      function L(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }
      var LAST=L(N);
      var thin={style:'thin',color:{argb:'FF000000'}}, border={top:thin,left:thin,bottom:thin,right:thin};
      function f(cell,o){o=o||{};cell.font={name:FONT,size:o.size||14,bold:!!o.bold};}
      function ctr(cell,w){cell.alignment={horizontal:'center',vertical:'middle',wrapText:!!w};}
      function lft(cell){cell.alignment={horizontal:'left',vertical:'middle',indent:1};}

      ws.mergeCells('A1:'+LAST+'1'); var c=ws.getCell('A1'); c.value=cfg.title||'ฟอร์มเวชภัณฑ์'; f(c,{size:20,bold:true}); ctr(c); ws.getRow(1).height=30;
      ws.mergeCells('A2:'+LAST+'2'); c=ws.getCell('A2'); c.value='โรงพยาบาลส่งเสริมสุขภาพตำบล ..............................  อำเภอ ......................  จังหวัด ......................'; f(c,{size:15}); ctr(c); ws.getRow(2).height=24;
      ws.mergeCells('A3:'+LAST+'3'); c=ws.getCell('A3'); c.value='วันที่ ................................................'; f(c,{size:15}); c.alignment={horizontal:'center',vertical:'middle'}; ws.getRow(3).height=24;

      var hr=ws.getRow(5);
      cols.forEach(function(col,i){ var cell=hr.getCell(i+1); cell.value=col.h; f(cell,{size:13,bold:true}); ctr(cell,true); cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}}; cell.border=border; });
      hr.height=34; var HEADER_ROW=5, r=6;

      var order=[],groups={};
      products.forEach(function(p){var cat=(p.category||'').trim()||'อื่น ๆ'; if(!groups[cat]){groups[cat]=[];order.push(cat);} groups[cat].push(p);});
      order.forEach(function(cat){
        ws.mergeCells('A'+r+':'+LAST+r);
        var sc=ws.getCell('A'+r); sc.value='หมวด : '+cat; f(sc,{size:14,bold:true}); lft(sc); sc.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFDDEBF7'}};
        for(var ci=1;ci<=N;ci++) ws.getCell(r,ci).border=border;
        ws.getRow(r).height=22; r++;
        groups[cat].slice().sort(function(a,b){return String(a.productName).localeCompare(String(b.productName),'th');}).forEach(function(p,idx){
          var row=ws.getRow(r);
          cols.forEach(function(col,i){
            var cell=row.getCell(i+1); cell.border=border; f(cell,{size:14}); var v='';
            if(col.type==='no') v=idx+1;
            else if(col.type==='code') v=(p.sku||p.barcode||'');
            else if(col.type==='name') v=(p.productName||'');
            else if(col.type==='pack') v=(p.packSize||p.unit||'');
            else if(col.type==='balance'){ var b=balMap[p.barcode]||0; v=b>0?b:''; }
            cell.value=v; if(col.type==='name') lft(cell); else ctr(cell);
          });
          row.height=20; r++;
        });
      });

      r+=2;
      var a=Math.max(1,Math.ceil(N/3));
      var sg=[[1,Math.min(a,N)],[Math.min(a+1,N),Math.min(2*a,N)],[Math.min(2*a+1,N),N]];
      var labels=['ลงชื่อ ...................................... ผู้จัดทำ','ลงชื่อ ...................................... ผู้ตรวจสอบ','ลงชื่อ ...................................... ผู้อนุมัติ'];
      function sig(text,c1,c2,rr){ if(c1>c2)c2=c1; ws.mergeCells(rr,c1,rr,c2); var cell=ws.getCell(rr,c1); cell.value=text; f(cell,{size:14}); ctr(cell); }
      sg.forEach(function(g,i){sig(labels[i],g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('( ...................................... )',g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('ตำแหน่ง ..........................................',g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('วันที่ .......... / .......... / ..........',g[0],g[1],r);});

      ws.views=[{state:'frozen',ySplit:HEADER_ROW}];
      try{ ws.pageSetup.printTitlesRow='1:'+HEADER_ROW; }catch(e){}

      wb.xlsx.writeBuffer().then(function(buf){
        var blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
        var el=document.createElement('a'); el.href=URL.createObjectURL(blob);
        el.download=(cfg.filePrefix||'ฟอร์ม')+'_'+new Date().toISOString().slice(0,10)+'.xlsx';
        document.body.appendChild(el); el.click(); setTimeout(function(){URL.revokeObjectURL(el.href);el.remove();},1500);
        hideLoading(); showToast('สร้างฟอร์มสำเร็จ ('+products.length+' รายการ)','success');
      }).catch(function(e){ hideLoading(); showToast('สร้างไฟล์ไม่สำเร็จ: '+e.message,'error'); });
    }catch(err){ hideLoading(); showToast('เกิดข้อผิดพลาด: '+err.message,'error'); }
  });
}

function exportInitForm(){
  exportDrugForm({ title:'ฟอร์มตั้งค่าสต็อกเริ่มต้น', filePrefix:'ฟอร์มตั้งค่าเริ่มต้น', columns:[
    {h:'ลำดับ',w:5,type:'no'},{h:'รหัส',w:11,type:'code'},{h:'รายการเวชภัณฑ์ (ชื่อสามัญทางยา)',w:34,type:'name'},{h:'ขนาดบรรจุ\n(PACK)',w:11,type:'pack'},
    {h:'จำนวนตั้งต้น',w:11,type:'blank'},{h:'LOT',w:12,type:'blank'},{h:'วันหมดอายุ',w:13,type:'blank'},{h:'หมายเหตุ',w:12,type:'blank'} ] });
}
function exportStockInForm(){
  exportDrugForm({ title:'ฟอร์มรับเวชภัณฑ์เข้าคลัง', filePrefix:'ฟอร์มรับเข้า', columns:[
    {h:'ลำดับ',w:5,type:'no'},{h:'รหัส',w:11,type:'code'},{h:'รายการเวชภัณฑ์ (ชื่อสามัญทางยา)',w:32,type:'name'},{h:'ขนาดบรรจุ\n(PACK)',w:10,type:'pack'},
    {h:'คงเหลือ',w:9,type:'balance'},{h:'จำนวนรับเข้า',w:11,type:'blank'},{h:'LOT',w:11,type:'blank'},{h:'วันหมดอายุ',w:12,type:'blank'},{h:'หมายเหตุ',w:11,type:'blank'} ] });
}
function exportStockOutForm(){
  exportDrugForm({ title:'ฟอร์มเบิก-จ่ายเวชภัณฑ์', filePrefix:'ฟอร์มเบิกออก', columns:[
    {h:'ลำดับ',w:5,type:'no'},{h:'รหัส',w:11,type:'code'},{h:'รายการเวชภัณฑ์ (ชื่อสามัญทางยา)',w:34,type:'name'},{h:'ขนาดบรรจุ\n(PACK)',w:11,type:'pack'},
    {h:'คงเหลือ',w:10,type:'balance'},{h:'จำนวนเบิก',w:9,type:'blank'},{h:'จำนวนจ่าย',w:9,type:'blank'},{h:'หมายเหตุ',w:13,type:'blank'} ] });
}

// ============================================================
// EXPORT ฟอร์ม Excel — เวชภัณฑ์ที่มิใช่ยา (จาก getMedicalSupplies F/G/H)
// รายการแบบ flat ไม่จัดกลุ่มหมวด · 4 คอลัมน์แรก = ลำดับ + F/G/H
// ============================================================
window.exportSupplyForm = function(cfg){
  cfg = cfg || {};
  showLoading('กำลังดึงข้อมูลเวชภัณฑ์...');
  google.script.run
    .withSuccessHandler(function(res){
      hideLoading();
      if(!res || !res.success){ showToast((res&&res.message)||'ดึงข้อมูลไม่สำเร็จ (อาจต้อง deploy GAS เวอร์ชันใหม่)','error'); return; }
      _sfBuild(cfg, res.data||[], res.headers||[]);
    })
    .withFailureHandler(function(err){ hideLoading(); showToast('ดึงข้อมูลไม่สำเร็จ: '+(err&&err.message||''),'error'); })
    .getMedicalSupplies();
};

function _sfBuild(cfg, supplies, headers){
  _dfEnsureExcelJS(function(){
    try{
      showLoading('กำลังสร้างไฟล์ Excel...');
      var FONT='TH Sarabun New';
      var cols=[ {h:'ลำดับ',w:5}, {h:headers[0]||'คอลัมน์ F',w:30}, {h:headers[1]||'คอลัมน์ G',w:14}, {h:headers[2]||'คอลัมน์ H',w:16} ].concat(cfg.extraCols||[]);
      var N=cols.length;
      var wb=new ExcelJS.Workbook();
      var ws=wb.addWorksheet('ฟอร์ม',{ pageSetup:{paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,horizontalCentered:true,margins:{left:0.4,right:0.4,top:0.55,bottom:0.5,header:0.2,footer:0.2}}, headerFooter:{oddFooter:'&Cหน้า &P / &N'} });
      ws.columns=cols.map(function(c){return {width:c.w||12};});
      function L(n){ var s=''; while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }
      var LAST=L(N);
      var thin={style:'thin',color:{argb:'FF000000'}}, border={top:thin,left:thin,bottom:thin,right:thin};
      function f(cell,o){o=o||{};cell.font={name:FONT,size:o.size||14,bold:!!o.bold};}
      function ctr(cell,w){cell.alignment={horizontal:'center',vertical:'middle',wrapText:!!w};}
      function lft(cell){cell.alignment={horizontal:'left',vertical:'middle',indent:1};}

      ws.mergeCells('A1:'+LAST+'1'); var c=ws.getCell('A1'); c.value=cfg.title||'ฟอร์มเวชภัณฑ์ที่มิใช่ยา'; f(c,{size:20,bold:true}); ctr(c); ws.getRow(1).height=30;
      ws.mergeCells('A2:'+LAST+'2'); c=ws.getCell('A2'); c.value='โรงพยาบาลส่งเสริมสุขภาพตำบล ..............................  อำเภอ ......................  จังหวัด ......................'; f(c,{size:15}); ctr(c); ws.getRow(2).height=24;
      ws.mergeCells('A3:'+LAST+'3'); c=ws.getCell('A3'); c.value='วันที่ ................................................'; f(c,{size:15}); c.alignment={horizontal:'center',vertical:'middle'}; ws.getRow(3).height=24;

      var hr=ws.getRow(5);
      cols.forEach(function(col,i){ var cell=hr.getCell(i+1); cell.value=col.h; f(cell,{size:13,bold:true}); ctr(cell,true); cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFBDD7EE'}}; cell.border=border; });
      hr.height=34; var HEADER_ROW=5, r=6;

      supplies.forEach(function(s,idx){
        var row=ws.getRow(r);
        cols.forEach(function(col,i){
          var cell=row.getCell(i+1); cell.border=border; f(cell,{size:14}); var v='';
          if(i===0) v=idx+1; else if(i===1) v=s.col1||''; else if(i===2) v=s.col2||''; else if(i===3) v=s.col3||'';
          cell.value=v; if(i===1) lft(cell); else ctr(cell);
        });
        row.height=20; r++;
      });
      if(!supplies.length){ // เว้นแถวเปล่าไว้ให้กรอกถ้าไม่มีข้อมูล
        for(var k=0;k<15;k++){ var rr=ws.getRow(r); for(var ci=1;ci<=N;ci++){ var cell=rr.getCell(ci); cell.border=border; f(cell,{size:14}); if(ci===1){cell.value=k+1; ctr(cell);} else if(ci===2) lft(cell); else ctr(cell); } rr.height=20; r++; }
      }

      r+=2;
      var a=Math.max(1,Math.ceil(N/3));
      var sg=[[1,Math.min(a,N)],[Math.min(a+1,N),Math.min(2*a,N)],[Math.min(2*a+1,N),N]];
      var labels=['ลงชื่อ ...................................... ผู้จัดทำ','ลงชื่อ ...................................... ผู้ตรวจสอบ','ลงชื่อ ...................................... ผู้อนุมัติ'];
      function sig(text,c1,c2,rr){ if(c1>c2)c2=c1; ws.mergeCells(rr,c1,rr,c2); var cell=ws.getCell(rr,c1); cell.value=text; f(cell,{size:14}); ctr(cell); }
      sg.forEach(function(g,i){sig(labels[i],g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('( ...................................... )',g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('ตำแหน่ง ..........................................',g[0],g[1],r);}); r++;
      sg.forEach(function(g){sig('วันที่ .......... / .......... / ..........',g[0],g[1],r);});

      ws.views=[{state:'frozen',ySplit:HEADER_ROW}];
      try{ ws.pageSetup.printTitlesRow='1:'+HEADER_ROW; }catch(e){}

      wb.xlsx.writeBuffer().then(function(buf){
        var blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
        var el=document.createElement('a'); el.href=URL.createObjectURL(blob);
        el.download=(cfg.filePrefix||'ฟอร์มเวชภัณฑ์มิใช่ยา')+'_'+new Date().toISOString().slice(0,10)+'.xlsx';
        document.body.appendChild(el); el.click(); setTimeout(function(){URL.revokeObjectURL(el.href);el.remove();},1500);
        hideLoading(); showToast('สร้างฟอร์มสำเร็จ ('+supplies.length+' รายการ)','success');
      }).catch(function(e){ hideLoading(); showToast('สร้างไฟล์ไม่สำเร็จ: '+e.message,'error'); });
    }catch(err){ hideLoading(); showToast('เกิดข้อผิดพลาด: '+err.message,'error'); }
  });
}

function exportSupplyInForm(){
  exportSupplyForm({ title:'ฟอร์มรับเวชภัณฑ์ที่มิใช่ยาเข้าคลัง', filePrefix:'ฟอร์มรับเข้า-เวชภัณฑ์มิใช่ยา',
    extraCols:[{h:'คงเหลือยกมา',w:11},{h:'จำนวนรับเข้า',w:11},{h:'รวมคงเหลือ',w:11},{h:'หมายเหตุ',w:14}] });
}
function exportSupplyOutForm(){
  exportSupplyForm({ title:'ฟอร์มจ่ายเวชภัณฑ์ที่มิใช่ยาออก', filePrefix:'ฟอร์มจ่ายออก-เวชภัณฑ์มิใช่ยา',
    extraCols:[{h:'คงเหลือ',w:10},{h:'จำนวนจ่าย',w:10},{h:'คงเหลือหลังจ่าย',w:13},{h:'หมายเหตุ',w:14}] });
}
function exportSupplyInitForm(){
  exportSupplyForm({ title:'ฟอร์มตั้งค่าสต็อกเริ่มต้น เวชภัณฑ์ที่มิใช่ยา', filePrefix:'ฟอร์มตั้งต้น-เวชภัณฑ์มิใช่ยา',
    extraCols:[{h:'จำนวนตั้งต้น',w:12},{h:'LOT / รุ่น',w:12},{h:'วันหมดอายุ',w:13},{h:'หมายเหตุ',w:14}] });
}

window.addEventListener('load', function() {
  if (!document.getElementById('bottomNav')) {
    var nav       = document.createElement('nav');
    nav.id        = 'bottomNav';
    nav.style.display = 'none';
    document.body.appendChild(nav);
  }
  initApp();
});
