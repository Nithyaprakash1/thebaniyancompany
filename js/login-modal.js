/**
 * THE BANIYAN COMPANY — Global Customer Login Modal UI & Auth Enforcement
 * Opens a custom branded login modal whenever login is required before adding to bag or buying.
 */
(function() {
  window.checkCustomerAuth = function(onSuccess) {
    let profile = null;
    try {
      const raw = localStorage.getItem('tbc_user_profile');
      if (raw) profile = JSON.parse(raw);
      const phone = localStorage.getItem('tbc_customer_phone');
      if (phone && (!profile || !profile.phone)) {
        profile = { name: profile?.name || 'Customer', phone };
      }
    } catch(e){}

    if (profile && profile.name && profile.phone && String(profile.phone).replace(/\D/g, '').length >= 10) {
      return true;
    }

    // Open Login UI Modal
    window._authPendingCallback = onSuccess;
    let modal = document.getElementById('tbc-login-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'tbc-login-modal';
      modal.className = 'fixed inset-0 bg-black/70 backdrop-blur-md z-[99999] flex items-center justify-center p-4 transition-all duration-300';
      modal.innerHTML = `
        <div class="bg-white rounded-[28px] p-6 sm:p-8 max-w-sm w-full space-y-6 shadow-2xl relative border border-black/10 transform transition-all scale-100">
          <button type="button" onclick="window.closeLoginModal()" class="absolute top-4 right-4 w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold hover:bg-slate-200 transition-colors">✕</button>
          
          <div class="text-center space-y-2 pt-2">
            <div class="w-16 h-16 bg-slate-900 text-white rounded-2xl flex items-center justify-center mx-auto shadow-lg">
              <span class="material-symbols-outlined text-3xl">account_circle</span>
            </div>
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Login Required 📱</h3>
            <p class="text-xs text-slate-500 font-medium leading-relaxed px-2">Please enter your Name &amp; 10-Digit Mobile Number to access your bag &amp; complete orders.</p>
          </div>

          <form onsubmit="event.preventDefault(); window.submitCustomerLoginUI();" class="space-y-4">
            <div>
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Full Name *</label>
              <input required type="text" id="tbc-login-name" placeholder="e.g. Alex Mercer" class="w-full bg-slate-100 px-4 py-3 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:ring-black border border-black/5 transition-all">
            </div>

            <div>
              <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">10-Digit Mobile Number *</label>
              <div class="flex items-center bg-slate-100 rounded-xl overflow-hidden border border-black/10 focus-within:ring-2 focus-within:ring-black transition-all">
                <span class="px-3.5 py-3 text-xs font-bold text-slate-800 bg-slate-200/70 border-r border-slate-300 flex-shrink-0">🇮🇳 +91</span>
                <input required type="tel" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" id="tbc-login-phone" oninput="this.value = this.value.replace(/\\D/g, '').slice(0, 10)" placeholder="9876543210" class="w-full bg-transparent px-3.5 py-3 text-sm font-bold outline-none text-slate-900">
              </div>
            </div>

            <button type="submit" class="w-full bg-slate-900 hover:bg-black text-white py-4 rounded-xl font-bold text-xs uppercase tracking-widest transition-all shadow-xl flex items-center justify-center gap-2">
              Login &amp; Continue ⚡ <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </form>

          <p class="text-[10px] text-center text-slate-400 font-medium">🔒 Your details are 100% encrypted &amp; secure.</p>
        </div>
      `;
      document.body.appendChild(modal);
    } else {
      modal.classList.remove('hidden');
    }
    return false;
  };

  window.closeLoginModal = function() {
    const modal = document.getElementById('tbc-login-modal');
    if (modal) modal.classList.add('hidden');
    window._authPendingCallback = null;
  };

  window.submitCustomerLoginUI = function() {
    const nameEl = document.getElementById('tbc-login-name');
    const phoneEl = document.getElementById('tbc-login-phone');
    const name = nameEl ? nameEl.value.trim() : '';
    const phone = phoneEl ? phoneEl.value.replace(/\D/g, '').slice(-10) : '';

    if (!name) {
      alert("Please enter your Full Name.");
      if (nameEl) nameEl.focus();
      return;
    }
    if (!phone || phone.length < 10) {
      alert("Please enter a valid 10-digit Mobile Number.");
      if (phoneEl) phoneEl.focus();
      return;
    }

    const profile = { name, phone };
    localStorage.setItem('tbc_user_profile', JSON.stringify(profile));
    localStorage.setItem('tbc_customer_phone', phone);

    window.closeLoginModal();

    if (typeof window._authPendingCallback === 'function') {
      const cb = window._authPendingCallback;
      window._authPendingCallback = null;
      cb(profile);
    }
  };
})();
