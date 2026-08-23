/**
 * THE BANIYAN COMPANY — Loading Controller
 * Provides smooth, realistic progression loading bars and live percentage counters (0% - 100%).
 */

(function () {
  'use strict';

  function createPageLoader(options) {
    const opts = Object.assign({
      screenId: 'loading-screen',
      barId: 'loading-bar-fill',
      pctId: 'loading-pct',
      statusId: 'loading-status',
      autoStart: true,
      minDuration: 400,
      maxDuration: 5000,
      onFinish: null
    }, options || {});

    let currentPct = 0;
    let targetPct = 20;
    let isComplete = false;
    let timer = null;
    let animFrame = null;

    const screenEl = document.getElementById(opts.screenId);
    const barEl = document.getElementById(opts.barId) || screenEl?.querySelector('.loading-bar-fill');
    const pctEl = document.getElementById(opts.pctId) || screenEl?.querySelector('.loading-percent') || screenEl?.querySelector('#loading-pct');
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
        currentPct += (100 - currentPct) * 0.3;
        if (currentPct >= 99.5) {
          currentPct = 100;
          updateUI(100);
          cancelAnimationFrame(animFrame);
          clearInterval(timer);
          setTimeout(fadeOutAndHide, 120);
          return;
        }
      } else {
        if (currentPct < targetPct) {
          const diff = targetPct - currentPct;
          currentPct += Math.max(0.3, diff * 0.08);
        }
      }
      updateUI(currentPct);
      animFrame = requestAnimationFrame(step);
    }

    function advanceStage() {
      if (isComplete) return;
      if (targetPct < 40) {
        targetPct = 40 + Math.random() * 15;
      } else if (targetPct < 75) {
        targetPct = 75 + Math.random() * 15;
      } else if (targetPct < 92) {
        targetPct = 92 + Math.random() * 5;
      }
    }

    function fadeOutAndHide() {
      if (screenEl) {
        screenEl.style.transition = 'opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1), visibility 0.4s ease';
        screenEl.style.opacity = '0';
        screenEl.style.pointerEvents = 'none';
        setTimeout(() => {
          screenEl.classList.add('hidden');
          screenEl.style.display = 'none';
          if (typeof opts.onFinish === 'function') {
            opts.onFinish();
          }
        }, 400);
      }
    }

    function start() {
      if (!screenEl) return;
      screenEl.style.opacity = '1';
      screenEl.style.visibility = 'visible';
      screenEl.classList.remove('hidden');
      updateUI(0);

      animFrame = requestAnimationFrame(step);
      timer = setInterval(advanceStage, 250);

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
    const screen = document.getElementById('loading-screen');
    if (screen && !window._pageLoaderInstance) {
      window._pageLoaderInstance = createPageLoader({
        screenId: 'loading-screen',
        barId: 'loading-bar-fill',
        pctId: 'loading-pct',
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
      const screen = document.getElementById('loading-screen');
      if (screen) {
        screen.style.transition = 'opacity 0.4s ease';
        screen.style.opacity = '0';
        setTimeout(() => {
          screen.classList.add('hidden');
          screen.style.display = 'none';
        }, 400);
      }
    }
  };

  // Ensure loader completes when all resources finish loading
  window.addEventListener('load', () => {
    setTimeout(() => {
      window.finishPageLoading();
    }, 200);
  });
})();
