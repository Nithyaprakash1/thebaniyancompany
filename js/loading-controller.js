/**
 * THE BANIYAN COMPANY — Loading & Splash Screen Controller
 * Provides smooth cinematic progression, cached logo hydration,
 * and seamless fade-out / zoom transitions.
 */

(function () {
  'use strict';

  // Apply cached logo instantly to prevent flickering
  try {
    let logoUrl = localStorage.getItem('onespace_shop_logo') || localStorage.getItem('tbc_shop_logo');
    if (!logoUrl) {
      const rawCache = localStorage.getItem('tbc_cache_company');
      if (rawCache) {
        const parsed = JSON.parse(rawCache);
        logoUrl = parsed && parsed.data && parsed.data.logo;
      }
    }
    if (!logoUrl) {
      logoUrl = 'assets/tbclogo.jpeg';
    }
    if (logoUrl) {
      const applyLogoImg = () => {
        const logoImg = document.getElementById('nav-company-logo');
        if (logoImg && !logoImg.src.includes(logoUrl)) logoImg.src = logoUrl;
        const loadImg = document.getElementById('loading-company-logo');
        if (loadImg && !loadImg.src.includes(logoUrl)) loadImg.src = logoUrl;
        const splashLogo = document.getElementById('splash-shop-logo');
        if (splashLogo && !splashLogo.src.includes(logoUrl)) splashLogo.src = logoUrl;
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyLogoImg);
      } else {
        applyLogoImg();
      }
    }
  } catch(e) {}

  function createPageLoader(options) {
    const opts = Object.assign({
      screenId: 'splash-screen',
      barId: 'splash-progress-bar',
      pctId: 'splash-pct',
      statusId: 'loading-status',
      autoStart: true,
      minDuration: 400,
      maxDuration: 4500,
      onFinish: null
    }, options || {});

    let currentPct = 0;
    let targetPct = 25;
    let isComplete = false;
    let timer = null;
    let animFrame = null;

    const screenEl = document.getElementById(opts.screenId) || document.getElementById('splash-screen') || document.getElementById('loading-screen');
    const barEl = document.getElementById(opts.barId) || screenEl?.querySelector('#splash-progress-bar') || screenEl?.querySelector('.loading-bar-fill');
    const pctEl = document.getElementById(opts.pctId) || screenEl?.querySelector('#splash-pct') || screenEl?.querySelector('.loading-percent') || screenEl?.querySelector('#loading-pct');
    const statusEl = document.getElementById(opts.statusId) || screenEl?.querySelector('.loading-status');

    function updateUI(val) {
      const rounded = Math.min(100, Math.max(0, Math.round(val)));
      if (pctEl) {
        pctEl.textContent = rounded + '%';
      }
      if (barEl) {
        barEl.style.width = rounded + '%';
      }
    }

    function step() {
      if (isComplete) {
        currentPct += (100 - currentPct) * 0.35;
        if (currentPct >= 99.4) {
          currentPct = 100;
          updateUI(100);
          cancelAnimationFrame(animFrame);
          clearInterval(timer);
          setTimeout(fadeOutAndHide, 160);
          return;
        }
      } else {
        if (currentPct < targetPct) {
          const diff = targetPct - currentPct;
          currentPct += Math.max(0.35, diff * 0.08);
        }
      }
      updateUI(currentPct);
      animFrame = requestAnimationFrame(step);
    }

    function advanceStage() {
      if (isComplete) return;
      if (targetPct < 45) {
        targetPct = 45 + Math.random() * 15;
      } else if (targetPct < 80) {
        targetPct = 80 + Math.random() * 12;
      } else if (targetPct < 95) {
        targetPct = 95 + Math.random() * 4;
      }
    }

    function fadeOutAndHide() {
      if (screenEl) {
        screenEl.classList.add('splash-exit');
        screenEl.style.transition = 'opacity 0.45s cubic-bezier(0.4, 0, 0.2, 1), transform 0.45s ease, filter 0.45s ease, visibility 0.45s ease';
        screenEl.style.opacity = '0';
        screenEl.style.transform = 'scale(1.03)';
        screenEl.style.filter = 'blur(4px)';
        screenEl.style.pointerEvents = 'none';
        setTimeout(() => {
          screenEl.classList.add('hidden');
          screenEl.style.display = 'none';
          if (typeof opts.onFinish === 'function') {
            opts.onFinish();
          }
        }, 460);
      }
    }

    // Skip on click / tap
    if (screenEl) {
      screenEl.addEventListener('click', () => {
        finish();
        fadeOutAndHide();
      });
    }

    function start() {
      if (!screenEl) return;
      screenEl.style.opacity = '1';
      screenEl.style.visibility = 'visible';
      screenEl.classList.remove('hidden', 'splash-exit');
      updateUI(0);

      animFrame = requestAnimationFrame(step);
      timer = setInterval(advanceStage, 220);

      setTimeout(() => {
        finish();
      }, opts.maxDuration);
    }

    function finish() {
      if (isComplete) return;
      isComplete = true;
      targetPct = 100;
    }

    function setStatus(text) {
      if (statusEl) {
        statusEl.textContent = text;
      }
    }

    if (opts.autoStart && screenEl) {
      start();
    }

    return {
      start,
      finish,
      setStatus,
      updateUI,
      get isComplete() { return isComplete; }
    };
  }

  // Global exports
  window.TBC_Loader = {
    create: createPageLoader
  };

  function initScreen() {
    const screen = document.getElementById('splash-screen') || document.getElementById('loading-screen');
    if (screen && !window._pageLoaderInstance) {
      window._pageLoaderInstance = createPageLoader({
        screenId: screen.id,
        barId: screen.id === 'splash-screen' ? 'splash-progress-bar' : 'loading-bar-fill',
        pctId: screen.id === 'splash-screen' ? 'splash-pct' : 'loading-pct',
        autoStart: true
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScreen);
  } else {
    initScreen();
  }

  window.finishPageLoading = function () {
    if (window._pageLoaderInstance) {
      window._pageLoaderInstance.finish();
    } else {
      const screen = document.getElementById('splash-screen') || document.getElementById('loading-screen');
      if (screen) {
        screen.classList.add('splash-exit');
        screen.style.transition = 'opacity 0.45s ease, transform 0.45s ease';
        screen.style.opacity = '0';
        screen.style.transform = 'scale(1.03)';
        setTimeout(() => {
          screen.classList.add('hidden');
          screen.style.display = 'none';
        }, 450);
      }
    }
  };

  // Ensure loader completes when all resources finish loading
  window.addEventListener('load', () => {
    setTimeout(() => {
      window.finishPageLoading();
    }, 280);
  });
})();
