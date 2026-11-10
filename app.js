/**
 * Dexter HiTech CRM - Core Application Engine
 * Secured with Firebase Authentication (Email/Password + Google),
 * Cloud Firestore, Admin Approval Workflow & Domain Authorization Helper.
 */

// Designated Super Administrator Email
const SUPER_ADMIN_EMAIL = 'aryanshinde20302003@gmail.com';

// Utility to clean and sanitize objects for Cloud Firestore (removes undefined, handles NaN)
function cleanDataForFirestore(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (typeof val === 'number' && isNaN(val)) {
      result[key] = 0;
    } else if (val === null) {
      result[key] = '';
    } else if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      result[key] = cleanDataForFirestore(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

const State = {
  currentUser: null,
  users: [],
  clients: [],
  tasks: [],
  requests: [],
  billing: [],
  pendingUsers: []
};

// ---------------------------------------------------------------------------
// 1. Firebase Authentication & Approval Service
// ---------------------------------------------------------------------------
const Auth = {
  init() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const isLoginPage = (currentPage === 'login.html');
    const isPendingPage = (currentPage === 'pending.html');
    const isAdminPage = (currentPage === 'admin.html');

    if (typeof fbAuth === 'undefined' || fbAuth === null) {
      console.warn("[Auth] Firebase Auth is not initialized. Check firebase-config.js.");
      return;
    }

    // Real-time Auth State Observer
    fbAuth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        console.log("[Auth] Active session found for:", firebaseUser.email || firebaseUser.displayName);
        
        // 1. Sync or create user profile with approval status
        const userProfile = await this.syncUserProfile(firebaseUser);

        // 2. Strict Check for Pending Approval
        if (userProfile.status === 'Pending') {
          console.warn("[Auth] Account approval is pending for:", userProfile.email);
          if (!isPendingPage) {
            // Strictly redirect pending users to pending.html - zero dashboard access
            window.location.replace('pending.html');
          } else {
            // Render pending card with live snapshot watcher
            App.renderPendingPage(userProfile);
          }
          return;
        }

        // 3. Check for Suspended or Rejected Users
        if (userProfile.status === 'Rejected' || userProfile.status === 'Suspended') {
          alert("Your access to Dexter HiTech CRM has been suspended or declined by the administrator. Please contact " + SUPER_ADMIN_EMAIL);
          this.logout();
          return;
        }

        // 4. User is Active & Approved!
        if (isPendingPage || isLoginPage) {
          // If approved user visits pending or login, direct to dashboard
          window.location.replace('index.html');
          return;
        }

        // 5. Admin Panel Access Control
        if (isAdminPage) {
          if (userProfile.role !== 'Admin') {
            alert("Access Denied: Administrator privileges are required to access the Admin Panel.");
            window.location.replace('index.html');
            return;
          }
        }

        // Render authorized workspace page
        App.onUserAuthenticated();

      } else {
        console.log("[Auth] No active session.");
        State.currentUser = null;
        sessionStorage.removeItem('dexter_session');

        // If on a protected page, redirect to login
        if (!isLoginPage) {
          window.location.href = 'login.html';
        }
      }
    });
  },

  async syncUserProfile(firebaseUser) {
    let profile = null;
    const uid = firebaseUser.uid;
    const email = (firebaseUser.email || '').toLowerCase().trim();
    const name = firebaseUser.displayName || (email ? email.split('@')[0] : 'Member');
    const photoURL = firebaseUser.photoURL || '';
    const isGoogle = firebaseUser.providerData && firebaseUser.providerData.some(p => p.providerId === 'google.com');

    // Check if this is the Super Admin: aryanshinde20302003@gmail.com
    const isSuperAdmin = (email === SUPER_ADMIN_EMAIL.toLowerCase().trim());

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        const docRef = fbDb.collection('users').doc(uid);
        const snap = await docRef.get();

        if (snap.exists) {
          profile = { id: uid, ...snap.data() };
          // If super admin, enforce Admin & Active status unconditionally
          if (isSuperAdmin) {
            profile.role = 'Admin';
            profile.status = 'Active';
            profile.approved = true;
            await docRef.set(cleanDataForFirestore(profile), { merge: true }).catch(() => {});
          }
        } else {
          // Check if user email was pre-authorized by Super Admin
          let preAuthDoc = null;
          if (email) {
            const preAuthSnap = await fbDb.collection('users').where('email', '==', email).get();
            if (!preAuthSnap.empty) {
              preAuthDoc = preAuthSnap.docs[0];
            }
          }

          if (isSuperAdmin) {
            // Super Admin account setup
            profile = {
              id: uid,
              uid: uid,
              email: email,
              full_name: name || 'Aryan Shinde (Admin)',
              photoURL: photoURL,
              auth_provider: isGoogle ? 'google.com' : 'password',
              role: 'Admin',
              status: 'Active',
              approved: true,
              created_at: new Date().toISOString()
            };
            await docRef.set(cleanDataForFirestore(profile), { merge: true }).catch(() => {});
          } else if (preAuthDoc && preAuthDoc.data().approved) {
            // Pre-authorized by Admin
            const preData = preAuthDoc.data();
            profile = {
              id: uid,
              uid: uid,
              email: email,
              full_name: name || preData.full_name || 'Member',
              photoURL: photoURL,
              auth_provider: isGoogle ? 'google.com' : 'password',
              role: preData.role || 'Member',
              status: 'Active',
              approved: true,
              preauthorized: true,
              created_at: preData.created_at || new Date().toISOString()
            };
            await docRef.set(cleanDataForFirestore(profile), { merge: true }).catch(() => {});

            // Clean up temporary preauth entry if under a different doc ID
            if (preAuthDoc.id !== uid) {
              await fbDb.collection('users').doc(preAuthDoc.id).delete().catch(() => {});
            }
          } else {
            // Brand new registration: Requires approval from aryanshinde20302003@gmail.com
            profile = {
              id: uid,
              uid: uid,
              email: email,
              full_name: name,
              photoURL: photoURL,
              auth_provider: isGoogle ? 'google.com' : 'password',
              role: 'Member',
              status: 'Pending',
              approved: false,
              created_at: new Date().toISOString()
            };

            await docRef.set(cleanDataForFirestore(profile), { merge: true }).catch(() => {});

            // Immediately register in local user state for instant visibility
            const curUsers = JSON.parse(localStorage.getItem('dexter_users') || '[]');
            const existingIdx = curUsers.findIndex(u => u.id === uid || u.email === email);
            if (existingIdx >= 0) {
              curUsers[existingIdx] = profile;
            } else {
              curUsers.unshift(profile);
            }
            State.users = curUsers;
            localStorage.setItem('dexter_users', JSON.stringify(curUsers));

            // DISPATCH INSTANT NOTIFICATION TO ARYAN SHINDE!
            this.notifyAdminNewUser(profile);
          }
        }
      }
    } catch (err) {
      console.warn("[Auth] Firestore profile fetch note:", err.message);
    }

    if (!profile) {
      profile = {
        id: uid,
        uid: uid,
        email: email,
        full_name: name,
        photoURL: photoURL,
        role: isSuperAdmin ? 'Admin' : 'Member',
        status: isSuperAdmin ? 'Active' : 'Pending',
        approved: isSuperAdmin
      };
    }

    State.currentUser = profile;
    sessionStorage.setItem('dexter_session', JSON.stringify(profile));
    return profile;
  },

  // Notify Workspace Super Admin (aryanshinde20302003@gmail.com) via Email when any user registers
  async notifyAdminNewUser(newUser) {
    const adminEmail = SUPER_ADMIN_EMAIL;
    console.log(`[Notify] Sending access approval notification to ${adminEmail} for:`, newUser.email);

    // 1. Record in Firestore 'admin_notifications' and 'notifications'
    if (typeof fbDb !== 'undefined' && fbDb) {
      try {
        const notif = {
          type: 'user_approval_request',
          userId: newUser.id,
          userEmail: newUser.email,
          userName: newUser.full_name || 'New Member',
          authProvider: newUser.auth_provider || 'Google/Email',
          adminEmail: adminEmail,
          created_at: new Date().toISOString(),
          status: 'pending'
        };
        await fbDb.collection('admin_notifications').add(cleanDataForFirestore(notif));
        await fbDb.collection('notifications').add(cleanDataForFirestore(notif));
      } catch (err) {
        console.warn("[Notify] Firestore notification write note:", err.message);
      }
    }

    // 2. Dispatch Automated Email via FormSubmit to aryanshinde20302003@gmail.com
    const origin = window.location.origin || '';
    const path = window.location.pathname.replace(/[^\/]*$/, '');
    const adminPanelUrl = `${origin}${path}admin.html`;

    const emailPayload = {
      _subject: `[ACTION REQUIRED] New CRM User Access Request: ${newUser.full_name || newUser.email}`,
      _template: 'table',
      _captcha: 'false',
      'Applicant Name': newUser.full_name || 'New Member',
      'Applicant Email': newUser.email,
      'Registration Time': new Date().toLocaleString(),
      'Sign-in Method': newUser.auth_provider || 'Google OAuth / Email',
      'Current Status': 'Pending Admin Approval (Dashboard Blocked)',
      'Action Needed': 'A new user has registered for Dexter HiTech CRM. Please click the link below to approve or decline their access in your Admin Panel.',
      'Admin Panel Link': adminPanelUrl
    };

    try {
      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(adminEmail), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(emailPayload)
      }).then(res => res.json()).then(data => {
        console.log("[Notify] Email dispatch result:", data);
      }).catch(err => {
        console.warn("[Notify] FormSubmit dispatch note:", err);
      });
    } catch (e) {
      console.warn("[Notify] Dispatch note:", e);
    }
  },

  async loginWithEmail(email, password) {
    return await fbAuth.signInWithEmailAndPassword(email.trim(), password);
  },

  async signUpWithEmail(email, password, fullName) {
    const cred = await fbAuth.createUserWithEmailAndPassword(email.trim(), password);
    if (fullName && cred.user) {
      await cred.user.updateProfile({ displayName: fullName.trim() });
    }
    const profile = await this.syncUserProfile(cred.user);
    return profile;
  },

  async loginWithGoogle() {
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.style.display = 'none';

    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');
      
      const result = await fbAuth.signInWithPopup(provider);
      const profile = await this.syncUserProfile(result.user);

      if (profile.status === 'Pending') {
        window.location.href = 'pending.html';
      } else {
        window.location.href = 'index.html';
      }
    } catch (err) {
      console.error("[Auth] Google Sign-in Error:", err);
      
      // Specifically handle auth/unauthorized-domain
      if (err.code === 'auth/unauthorized-domain') {
        App.showUnauthorizedDomainModal(window.location.hostname);
        return;
      }
      
      if (err.code === 'auth/popup-blocked') {
        const provider = new firebase.auth.GoogleAuthProvider();
        fbAuth.signInWithRedirect(provider);
      } else if (errEl) {
        errEl.textContent = err.message || 'Google Sign-in failed. Please try again.';
        errEl.style.display = 'block';
      }
    }
  },

  async logout() {
    try {
      if (typeof fbAuth !== 'undefined' && fbAuth) {
        await fbAuth.signOut();
      }
    } catch (e) {}
    sessionStorage.removeItem('dexter_session');
    window.location.href = 'login.html';
  },

  async forgotPassword(e) {
    if (e) e.preventDefault();
    const email = document.getElementById('login-email') ? document.getElementById('login-email').value.trim() : '';
    const targetEmail = email || prompt("Please enter your account email to receive a password reset link:");
    if (!targetEmail) return;

    try {
      await fbAuth.sendPasswordResetEmail(targetEmail);
      alert(`Password reset link sent to ${targetEmail}. Please check your inbox.`);
    } catch (err) {
      alert("Error: " + err.message);
    }
  },

  async changePassword(currentPassword, newPassword) {
    const user = fbAuth.currentUser;
    if (!user) throw new Error("No authenticated user.");

    if (user.providerData && user.providerData.some(p => p.providerId === 'google.com')) {
      throw new Error("Your account is managed via Google Sign-In. Password updates are managed through your Google Account.");
    }

    if (currentPassword && user.email) {
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
      await user.reauthenticateWithCredential(cred);
    }
    await user.updatePassword(newPassword);
  }
};

// ---------------------------------------------------------------------------
// 2. Storage & Firestore Sync Layer (Resilient Multi-Tier Architecture)
// ---------------------------------------------------------------------------
const Storage = {
  isCloud() {
    return typeof isFirebaseConfigured === 'function' && isFirebaseConfigured() && typeof fbDb !== 'undefined' && fbDb !== null;
  },

  loadLocalData() {
    try {
      State.users = JSON.parse(localStorage.getItem('dexter_users') || '[]');
      State.clients = JSON.parse(localStorage.getItem('dexter_clients') || '[]');
      State.tasks = JSON.parse(localStorage.getItem('dexter_tasks') || '[]');
      State.requests = JSON.parse(localStorage.getItem('dexter_requests') || '[]');
      State.billing = JSON.parse(localStorage.getItem('dexter_billing') || '[]');
    } catch (e) {
      console.warn("Local storage parse note", e);
    }
  },

  async syncWithFirestore() {
    if (!this.isCloud()) return;

    try {
      await Promise.all([
        this.fetchCollection('users'),
        this.fetchCollection('clients'),
        this.fetchCollection('tasks'),
        this.fetchCollection('requests'),
        this.fetchCollection('billing')
      ]);

      // Calculate pending user approvals
      State.pendingUsers = State.users.filter(u => u.status === 'Pending');

      App.updatePendingBadges();
      App.renderCurrentPage();
      console.log("[Firebase] Firestore data synchronized successfully.");
    } catch (err) {
      console.warn("[Firebase] Background sync notice:", err.message);
    }
  },

  async fetchCollection(colName) {
    const localKey = 'dexter_' + colName;
    const localItems = JSON.parse(localStorage.getItem(localKey) || '[]');

    if (!this.isCloud()) {
      State[colName] = localItems;
      return localItems;
    }

    try {
      const snap = await fbDb.collection(colName).get();
      const cloudItems = [];
      snap.forEach(doc => {
        cloudItems.push({ id: doc.id, ...doc.data() });
      });

      if (cloudItems.length > 0) {
        // Smart Bi-directional Merge:
        // Cloud items take precedence, but keep any locally added items not yet uploaded
        const itemMap = new Map();
        localItems.forEach(item => itemMap.set(item.id, item));
        cloudItems.forEach(item => itemMap.set(item.id, item));
        const merged = Array.from(itemMap.values());

        // Upload any local items that were missing in Cloud
        for (const item of localItems) {
          if (!cloudItems.some(c => c.id === item.id)) {
            fbDb.collection(colName).doc(item.id).set(cleanDataForFirestore(item), { merge: true }).catch(() => {});
          }
        }

        State[colName] = merged;
        localStorage.setItem(localKey, JSON.stringify(merged));
        return merged;
      } else if (localItems.length > 0) {
        // Cloud collection is currently empty, but local has items -> Auto-seed Cloud Firestore!
        console.log(`[Firebase] Seeding ${colName} (${localItems.length} items) to Firestore...`);
        for (const item of localItems) {
          fbDb.collection(colName).doc(item.id).set(cleanDataForFirestore(item), { merge: true }).catch(() => {});
        }
        State[colName] = localItems;
        return localItems;
      } else {
        State[colName] = [];
        return [];
      }
    } catch (err) {
      console.warn(`[Firebase] fetchCollection note for ${colName}:`, err.message);
      // On network/permission issue, NEVER wipe local data!
      State[colName] = localItems;
      return localItems;
    }
  },

  async saveItem(colName, item) {
    if (!item.id) {
      item.id = 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }
    if (!item.created_at) {
      item.created_at = new Date().toISOString();
    }

    const cleanItem = cleanDataForFirestore(item);

    // 1. Immediately persist to State in memory
    const list = State[colName] || [];
    const idx = list.findIndex(x => x.id === cleanItem.id);
    if (idx >= 0) {
      list[idx] = cleanItem;
    } else {
      list.unshift(cleanItem);
    }
    State[colName] = list;

    // 2. Immediately persist to LocalStorage (Instant 0ms local durability)
    localStorage.setItem('dexter_' + colName, JSON.stringify(list));

    // 3. Persist to Cloud Firestore in background (Non-blocking)
    if (this.isCloud()) {
      fbDb.collection(colName).doc(cleanItem.id).set(cleanItem, { merge: true })
        .then(() => console.log(`[Firebase] Saved ${colName}/${cleanItem.id} to Firestore.`))
        .catch(err => console.warn(`[Firebase] Firestore write note for ${colName}:`, err.message));
    }
    return cleanItem;
  },

  async updateItemField(colName, id, fields) {
    const list = State[colName] || [];
    const item = list.find(x => x.id === id);
    const cleanFields = cleanDataForFirestore(fields);

    if (item) {
      Object.assign(item, cleanFields);
      localStorage.setItem('dexter_' + colName, JSON.stringify(list));
    }
    if (this.isCloud()) {
      fbDb.collection(colName).doc(id).set(cleanFields, { merge: true })
        .catch(err => console.warn(`[Firebase] Firestore update note:`, err.message));
    }
    return item;
  },

  async deleteItem(colName, id) {
    State[colName] = (State[colName] || []).filter(x => x.id !== id);
    localStorage.setItem('dexter_' + colName, JSON.stringify(State[colName]));

    if (this.isCloud()) {
      fbDb.collection(colName).doc(id).delete()
        .catch(err => console.warn(`[Firebase] Firestore delete note:`, err.message));
    }
  }
};

// ---------------------------------------------------------------------------
// 3. UI Application Controller
// ---------------------------------------------------------------------------
const App = {
  start() {
    Storage.loadLocalData();
    this.highlightActiveNav();
    this.bindEvents();
    this.setupMobileDrawer();
    this.renderCurrentPage(); // Instant 0ms initial render from local cache!

    // Start Authentication Watcher & Live Users Sync
    Auth.init();
    this.initLiveUsersListener();
  },

  onUserAuthenticated() {
    this.updateUserChip();
    this.renderCurrentPage();
    this.initLiveUsersListener();

    // Sync cloud data in background
    Storage.syncWithFirestore();
  },

  initLiveUsersListener() {
    if (typeof fbDb === 'undefined' || !fbDb || this._liveUsersListenerAttached) return;
    this._liveUsersListenerAttached = true;

    try {
      fbDb.collection('users').onSnapshot(snap => {
        const cloudUsers = [];
        snap.forEach(doc => {
          cloudUsers.push({ id: doc.id, ...doc.data() });
        });

        if (cloudUsers.length > 0) {
          const userMap = new Map();
          (State.users || []).forEach(u => userMap.set(u.id, u));
          cloudUsers.forEach(u => userMap.set(u.id, u));
          const merged = Array.from(userMap.values());

          State.users = merged;
          localStorage.setItem('dexter_users', JSON.stringify(merged));
          State.pendingUsers = merged.filter(u => u.status === 'Pending');

          App.updatePendingBadges();

          const path = window.location.pathname.split('/').pop() || 'index.html';
          if (path === 'index.html' || path === 'dashboard.html' || path === '') {
            App.renderDashboardPendingRequests();
          } else if (path === 'admin.html') {
            App.renderAdminPanel();
          } else if (path === 'team.html') {
            App.renderTeam();
          }
        }
      }, err => {
        console.warn("[Firebase] Live users listener note:", err.message);
      });
    } catch (e) {
      console.warn("[Firebase] Could not attach live users listener:", e);
    }
  },

  // Update Pending Badges on Sidebar & Alert Banners
  updatePendingBadges() {
    const pending = (State.users || []).filter(u => u.status === 'Pending');
    const isSuperAdmin = State.currentUser && (
      (State.currentUser.email || '').toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase() ||
      State.currentUser.role === 'Admin'
    );
    
    // Update all pending badges across navbar
    const badges = document.querySelectorAll('#pending-nav-badge');
    badges.forEach(badge => {
      if (pending.length > 0 && isSuperAdmin) {
        badge.textContent = pending.length;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    });

    // Overview banner
    const alertBanner = document.getElementById('admin-pending-alert');
    const alertText = document.getElementById('admin-pending-text');
    if (alertBanner && alertText) {
      if (pending.length > 0 && isSuperAdmin) {
        alertText.textContent = `${pending.length} team member(s) waiting for access approval.`;
        alertBanner.style.display = 'flex';
      } else {
        alertBanner.style.display = 'none';
      }
    }

    // Dashboard Pending Panel Count
    const dashPendingCount = document.getElementById('dash-pending-count');
    if (dashPendingCount) dashPendingCount.textContent = pending.length;

    // Admin Panel widgets
    const kpiPending = document.getElementById('kpi-pending-count');
    const tablePendingCount = document.getElementById('admin-pending-table-count');
    const adminBannerText = document.getElementById('admin-banner-text');
    const adminOverviewAlert = document.getElementById('admin-overview-alert');
    if (kpiPending) kpiPending.textContent = pending.length;
    if (tablePendingCount) tablePendingCount.textContent = pending.length;
    if (adminBannerText) adminBannerText.textContent = `${pending.length} user(s) are currently waiting for your approval to enter the workspace.`;
    if (adminOverviewAlert) adminOverviewAlert.style.display = pending.length > 0 ? 'flex' : 'none';
  },

  // Modal when domain is not authorized in Firebase Console
  showUnauthorizedDomainModal(domain) {
    const existing = document.getElementById('unauthorized-domain-modal');
    if (existing) existing.remove();

    const isLocalIP = (domain === '127.0.0.1');
    const modal = document.createElement('div');
    modal.id = 'unauthorized-domain-modal';
    modal.className = 'domain-modal-overlay';
    modal.innerHTML = `
      <div class="domain-modal">
        <h3>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          Authorize Domain in Firebase Console
        </h3>
        <p style="color:#475569; margin: 8px 0 14px;">
          Firebase requires this domain to be added to your <b>Authorized Domains</b> list before Google Sign-In can work:
        </p>
        
        <div class="domain-badge">
          <span id="domain-text">${escapeHtml(domain)}</span>
          <button type="button" class="copy-btn" onclick="navigator.clipboard.writeText('${escapeHtml(domain)}'); this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 2000)">Copy</button>
        </div>

        <ol class="domain-steps">
          <li>Open <a href="https://console.firebase.google.com/project/dexter-hitech-client-review/authentication/settings" target="_blank" rel="noopener">Firebase Console → Authentication → Settings ↗</a></li>
          <li>Under <b>Authorized domains</b>, click <b>Add domain</b></li>
          <li>Paste <b>${escapeHtml(domain)}</b> and click <b>Save</b></li>
        </ol>

        ${isLocalIP ? `
          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:10px 12px; margin: 12px 0; color:#1e40af; font-size:12px;">
            💡 <b>Localhost Tip:</b> Firebase authorizes <code>localhost</code> by default. If testing locally, open <a href="http://localhost:5000/login.html" style="color:#1d4ed8; font-weight:700;">http://localhost:...</a> instead of 127.0.0.1!
          </div>
        ` : ''}

        <p style="font-size:12px; color:#64748b; margin: 12px 0 18px;">
          <b>Alternative:</b> You can also sign in with <b>Email & Password</b> right now without waiting for domain configuration.
        </p>

        <div style="display:flex; justify-content:flex-end;">
          <button type="button" class="primary small-btn" onclick="document.getElementById('unauthorized-domain-modal').remove()">Got it, close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  },

  // Full-page Approval Required screen for pending users
  showApprovalPendingOverlay(user) {
    const existing = document.getElementById('pending-approval-overlay');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.id = 'pending-approval-overlay';
    overlay.className = 'approval-overlay-view';
    overlay.innerHTML = `
      <div class="approval-card">
        <div class="approval-icon-badge">⏳</div>
        <h2>Access Approval Pending</h2>
        <div class="approval-user-info">${escapeHtml(user.full_name || user.email)}</div>
        <p>
          Your account has been registered successfully. For security, all team accounts require administrator approval before gaining access to the CRM workspace.<br><br>
          An automated notification has been dispatched to the administrator. Once approved, your access will be activated immediately.
        </p>
        <div class="approval-actions">
          <button class="primary" onclick="window.location.reload()">Check Status (Refresh) ↻</button>
          <button class="btn-secondary" onclick="Auth.logout()">Sign out ↗</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  // Show pending state on login page
  showPendingApprovalState(user) {
    const succEl = document.getElementById('login-success');
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.style.display = 'none';

    if (succEl) {
      succEl.innerHTML = `
        <b>⏳ Account Pending Approval:</b><br>
        Your account (${escapeHtml(user.email)}) has been registered. The administrator has been notified. You will be able to sign in as soon as your access is approved.
      `;
      succEl.style.display = 'block';
    }
  },

  // Setup Mobile Drawer
  setupMobileDrawer() {
    const toggleBtn = document.getElementById('mobile-menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const closeBtn = document.getElementById('sidebar-close-btn');

    if (toggleBtn && sidebar && overlay) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
      });

      const closeDrawer = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      };

      overlay.addEventListener('click', closeDrawer);
      if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

      sidebar.querySelectorAll('.nav').forEach(link => {
        link.addEventListener('click', closeDrawer);
      });
    }
  },

  highlightActiveNav() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    const navMap = {
      '': 'nav-dashboard',
      'index.html': 'nav-dashboard',
      'dashboard.html': 'nav-dashboard',
      'clients.html': 'nav-clients',
      'tasks.html': 'nav-tasks',
      'requests.html': 'nav-requests',
      'billing.html': 'nav-billing',
      'team.html': 'nav-team',
      'admin.html': 'nav-admin'
    };

    const activeId = navMap[path];
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) el.classList.add('selected');
    }
  },

  updateUserChip() {
    if (!State.currentUser) return;
    const user = State.currentUser;
    const initial = (user.full_name || user.email || 'U').charAt(0).toUpperCase();

    const avatar = document.getElementById('user-avatar');
    if (avatar) {
      if (user.photoURL) {
        avatar.style.backgroundImage = `url('${user.photoURL}')`;
        avatar.textContent = '';
      } else {
        avatar.style.backgroundImage = 'none';
        avatar.textContent = initial;
      }
    }

    const name = document.getElementById('user-name');
    if (name) name.textContent = user.full_name || user.email;

    const role = document.getElementById('user-role');
    if (role) role.textContent = user.role || 'Member';

    const isAdmin = (user.role === 'Admin');

    const adminNav = document.getElementById('nav-admin');
    if (adminNav) adminNav.style.display = isAdmin ? 'flex' : 'none';

    const teamNav = document.getElementById('nav-team');
    if (teamNav) teamNav.style.display = isAdmin ? 'flex' : 'none';

    const teamHeader = document.getElementById('team-nav-header');
    if (teamHeader) teamHeader.style.display = isAdmin ? 'block' : 'none';

    const todayDate = document.getElementById('today-date');
    if (todayDate) todayDate.textContent = new Date().toISOString().split('T')[0];
  },

  showFlash(msg, type = 'success') {
    const el = document.getElementById('flash-message');
    if (!el) return;
    el.className = `flash show ${type}`;
    el.textContent = msg;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      el.className = 'flash';
    }, 4500);
  },

  renderCurrentPage() {
    const path = window.location.pathname.split('/').pop() || 'index.html';

    if (path === 'index.html' || path === 'dashboard.html' || path === '') {
      this.renderDashboard();
    } else if (path === 'clients.html') {
      this.renderClients();
    } else if (path === 'tasks.html') {
      this.renderTasks();
    } else if (path === 'requests.html') {
      this.renderRequests();
    } else if (path === 'billing.html') {
      this.renderBilling();
    } else if (path === 'team.html') {
      this.renderTeam();
    } else if (path === 'account.html') {
      this.renderAccount();
    } else if (path === 'admin.html') {
      this.renderAdminPanel();
    }
  },

  switchAuthTab(tab) {
    const signinTab = document.getElementById('tab-signin');
    const signupTab = document.getElementById('tab-signup');
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const authTitle = document.getElementById('auth-title');
    const authSubtitle = document.getElementById('auth-subtitle');
    const errEl = document.getElementById('login-error');
    const succEl = document.getElementById('login-success');

    if (errEl) errEl.style.display = 'none';
    if (succEl) succEl.style.display = 'none';

    if (tab === 'signup') {
      if (signinTab) signinTab.classList.remove('active');
      if (signupTab) signupTab.classList.add('active');
      if (loginForm) loginForm.style.display = 'none';
      if (signupForm) signupForm.style.display = 'grid';
      if (authTitle) authTitle.textContent = 'Create your account';
      if (authSubtitle) authSubtitle.textContent = 'Request access to Dexter HiTech CRM.';
    } else {
      if (signinTab) signinTab.classList.add('active');
      if (signupTab) signupTab.classList.remove('active');
      if (loginForm) loginForm.style.display = 'grid';
      if (signupForm) signupForm.style.display = 'none';
      if (authTitle) authTitle.textContent = 'Welcome back.';
      if (authSubtitle) authSubtitle.textContent = 'Sign in to manage your client operations.';
    }
  },

  // -------------------------------------------------------------------------
  // Dashboard View
  // -------------------------------------------------------------------------
  renderDashboard() {
    const today = new Date().toISOString().split('T')[0];

    const activeClients = State.clients.filter(c => (c.status || 'Active') === 'Active').length;
    const openTasks = State.tasks.filter(t => (t.status || 'To Do') !== 'Done').length;
    const openRequests = State.requests.filter(r => !['Completed', 'Closed'].includes(r.status || 'New')).length;
    const overdueInvoices = State.billing.filter(b => b.status !== 'Paid' && b.due_date && b.due_date < today).length;

    const sc = document.getElementById('stat-active-clients');
    if (sc) sc.textContent = activeClients;
    const st = document.getElementById('stat-open-tasks');
    if (st) st.textContent = openTasks;
    const sr = document.getElementById('stat-open-requests');
    if (sr) sr.textContent = openRequests;
    const so = document.getElementById('stat-overdue-invoices');
    if (so) so.textContent = overdueInvoices;

    // Upcoming tasks (up to 8, sorted by due date)
    const upcoming = State.tasks
      .filter(t => (t.status || 'To Do') !== 'Done')
      .sort((a, b) => {
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      })
      .slice(0, 8);

    const tasksTableBody = document.getElementById('dashboard-tasks-table');
    if (tasksTableBody) {
      if (upcoming.length === 0) {
        tasksTableBody.innerHTML = `<tr><td colspan="5" class="empty">No open tasks yet. Add your first task to get started.</td></tr>`;
      } else {
        tasksTableBody.innerHTML = upcoming.map(t => {
          const client = State.clients.find(c => c.id === t.client_id);
          const user = State.users.find(u => u.id === t.assignee_id);
          return `
            <tr>
              <td><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.priority || 'Medium')} priority</small></td>
              <td>${escapeHtml(client ? client.name : '—')}</td>
              <td>${escapeHtml(user ? (user.full_name || user.email) : 'Unassigned')}</td>
              <td>${escapeHtml(t.due_date || '—')}</td>
              <td><span class="pill">${escapeHtml(t.status || 'To Do')}</span></td>
            </tr>
          `;
        }).join('');
      }
    }

    // Recent requests (up to 6)
    const recent = [...State.requests]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 6);

    const reqContainer = document.getElementById('dashboard-recent-requests');
    if (reqContainer) {
      if (recent.length === 0) {
        reqContainer.innerHTML = `<div class="empty">No client requests logged yet.</div>`;
      } else {
        reqContainer.innerHTML = recent.map(r => {
          const client = State.clients.find(c => c.id === r.client_id);
          const user = State.users.find(u => u.id === r.owner_id);
          return `
            <div class="request-line">
              <div class="request-dot"></div>
              <div>
                <b>${escapeHtml(client ? client.name : 'Unknown client')}</b>
                <p>${escapeHtml(r.request)}</p>
                <small>${escapeHtml(r.received_date || '')} · ${escapeHtml(user ? (user.full_name || user.email) : 'Unassigned')} · ${escapeHtml(r.status || 'New')}</small>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Live Pending Access Requests on Dashboard
    this.renderDashboardPendingRequests();

    this.updatePendingBadges();
  },

  renderDashboardPendingRequests() {
    const panel = document.getElementById('dashboard-pending-access-panel');
    const tbody = document.getElementById('dashboard-pending-tbody');
    const countSpan = document.getElementById('dash-pending-count');

    if (!panel || !tbody) return;

    const isSuperAdmin = State.currentUser && (
      (State.currentUser.email || '').toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase() ||
      State.currentUser.role === 'Admin'
    );

    const pending = (State.users || []).filter(u => u.status === 'Pending');

    if (countSpan) countSpan.textContent = pending.length;

    if (!isSuperAdmin || pending.length === 0) {
      panel.style.display = 'none';
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No pending user requests.</td></tr>`;
      return;
    }

    panel.style.display = 'block';

    tbody.innerHTML = pending.map(u => {
      const initial = (u.full_name || u.email || 'U').charAt(0).toUpperCase();
      const avatarStyle = u.photoURL ? `background-image:url('${escapeHtml(u.photoURL)}');` : '';
      const isGoogle = u.photoURL || (u.auth_provider === 'google.com');
      const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString() + ' ' + new Date(u.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Recently';

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="avatar" style="${avatarStyle}">${u.photoURL ? '' : initial}</span>
              <div>
                <b>${escapeHtml(u.full_name || 'New Member')}</b>
                <small style="display:block; color:#94a3b8; font-family:monospace; font-size:10px;">ID: ${escapeHtml(u.id)}</small>
              </div>
            </div>
          </td>
          <td><b>${escapeHtml(u.email || '—')}</b></td>
          <td>
            <span class="provider-badge" style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:600; background:#f1f5f9; color:#475569;">
              ${isGoogle ? '🌐 Google OAuth' : '✉️ Email & Password'}
            </span>
          </td>
          <td><span style="font-size:12px; color:#475569;">${dateStr}</span></td>
          <td>
            <select id="dash-role-select-${u.id}" style="padding:5px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1; background:#fff;">
              <option value="Member" selected>Member (Standard)</option>
              <option value="Admin">Admin (Full Control)</option>
            </select>
          </td>
          <td style="text-align:right;">
            <div class="action-btn-group" style="display:flex; gap:6px; justify-content: flex-end;">
              <button type="button" class="approve-btn" onclick="App.approveDashboardUser('${u.id}')" style="background:#16a34a; color:#fff; border:none; padding:6px 12px; border-radius:6px; font-weight:600; cursor:pointer; font-size:12px;">✓ Approve Access</button>
              <button type="button" class="reject-btn" onclick="App.rejectUser('${u.id}')" style="background:#dc2626; color:#fff; border:none; padding:6px 10px; border-radius:6px; font-weight:600; cursor:pointer; font-size:12px;">✕ Decline</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  async approveDashboardUser(userId) {
    const roleSelect = document.getElementById(`dash-role-select-${userId}`);
    const assignedRole = roleSelect ? roleSelect.value : 'Member';
    const user = (State.users || []).find(u => u.id === userId);
    const userEmail = user ? user.email : '';
    const userName = user ? user.full_name : 'Team Member';

    // 1. Update user profile to Active in Firestore and LocalStorage
    await Storage.updateItemField('users', userId, {
      status: 'Active',
      approved: true,
      role: assignedRole,
      approved_at: new Date().toISOString(),
      approved_by: SUPER_ADMIN_EMAIL
    });

    // 2. Record approval in Firestore notifications
    if (typeof fbDb !== 'undefined' && fbDb) {
      await fbDb.collection('notifications').add(cleanDataForFirestore({
        type: 'user_approval_granted',
        userId: userId,
        userEmail: userEmail,
        userName: userName,
        assignedRole: assignedRole,
        approvedBy: SUPER_ADMIN_EMAIL,
        created_at: new Date().toISOString(),
        status: 'completed'
      })).catch(() => {});
    }

    // 3. Send automated confirmation email to applicant via FormSubmit
    if (userEmail) {
      const origin = window.location.origin || '';
      const path = window.location.pathname.replace(/[^\/]*$/, '');
      const dashboardUrl = `${origin}${path}index.html`;

      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(userEmail), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          _subject: `[Dexter HiTech CRM] Your Dashboard Access Has Been Approved!`,
          _template: 'table',
          _captcha: 'false',
          'Status': 'Access Granted (Approved)',
          'Role Assigned': assignedRole,
          'Approved By': SUPER_ADMIN_EMAIL,
          'Message': `Hello ${userName}, your access request for Dexter HiTech CRM has been approved. You now have full access to the dashboard.`,
          'Dashboard Link': dashboardUrl
        })
      }).catch(() => {});
    }

    this.showFlash(`User ${userEmail} approved with role ${assignedRole}! Dashboard access granted.`, 'success');
    await Storage.syncWithFirestore();
    this.renderDashboard();
    this.updatePendingBadges();
  },

  // -------------------------------------------------------------------------
  // Clients View
  // -------------------------------------------------------------------------
  renderClients() {
    this.populateSelect('client-owner-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('clients-table-body');
    const countEl = document.getElementById('clients-count');
    if (countEl) countEl.textContent = `${State.clients.length} records`;

    if (!tableBody) return;
    if (State.clients.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7" class="empty">No clients added yet.</td></tr>`;
      return;
    }

    tableBody.innerHTML = State.clients.map(c => {
      const owner = State.users.find(u => u.id === c.owner_id);
      const fee = Number(c.monthly_fee || 0).toFixed(2);
      return `
        <tr>
          <td><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.company || '—')}</small></td>
          <td>${escapeHtml(c.contact_person || '—')}<small>${escapeHtml(c.phone || c.email || '')}</small></td>
          <td>${escapeHtml(c.service || '—')}</td>
          <td>${escapeHtml(owner ? (owner.full_name || owner.email) : 'Unassigned')}</td>
          <td>₹${fee}</td>
          <td><span class="pill ${c.status === 'Active' ? 'active' : ''}">${escapeHtml(c.status || 'Active')}</span></td>
          <td>
            <button class="action-btn" onclick="App.deleteClient('${c.id}')" title="Delete client">✕</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async deleteClient(id) {
    if (!confirm('Are you sure you want to delete this client?')) return;
    await Storage.deleteItem('clients', id);
    this.showFlash('Client deleted.', 'success');
    this.renderClients();
  },

  // -------------------------------------------------------------------------
  // Tasks View
  // -------------------------------------------------------------------------
  renderTasks() {
    this.populateSelect('task-client-select', State.clients, 'id', 'name', 'Internal / none');
    this.populateSelect('task-assignee-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('tasks-table-body');
    const countEl = document.getElementById('tasks-count');
    if (countEl) countEl.textContent = `${State.tasks.length} tasks`;

    if (!tableBody) return;
    if (State.tasks.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7" class="empty">No tasks created yet.</td></tr>`;
      return;
    }

    const statuses = ['To Do', 'In Progress', 'Review', 'Waiting on Client', 'Done'];

    tableBody.innerHTML = State.tasks.map(t => {
      const client = State.clients.find(c => c.id === t.client_id);
      const user = State.users.find(u => u.id === t.assignee_id);
      const pClass = (t.priority || '').toLowerCase();

      return `
        <tr>
          <td><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.description || '')}</small></td>
          <td>${escapeHtml(client ? client.name : '—')}</td>
          <td>${escapeHtml(user ? (user.full_name || user.email) : 'Unassigned')}</td>
          <td>${escapeHtml(t.due_date || '—')}</td>
          <td><span class="pill ${pClass}">${escapeHtml(t.priority || 'Medium')}</span></td>
          <td>
            <form class="inline-form" onsubmit="return false;">
              <select onchange="App.updateTaskStatus('${t.id}', this.value)">
                ${statuses.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </form>
          </td>
          <td>
            <button class="action-btn" onclick="App.deleteTask('${t.id}')" title="Delete task">✕</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async updateTaskStatus(taskId, newStatus) {
    await Storage.updateItemField('tasks', taskId, { status: newStatus });
    this.showFlash(`Task updated to ${newStatus}.`, 'success');
  },

  async deleteTask(id) {
    if (!confirm('Are you sure you want to delete this task?')) return;
    await Storage.deleteItem('tasks', id);
    this.showFlash('Task deleted.', 'success');
    this.renderTasks();
  },

  // -------------------------------------------------------------------------
  // Requests View
  // -------------------------------------------------------------------------
  renderRequests() {
    this.populateSelect('request-client-select', State.clients, 'id', 'name', 'Select client');
    this.populateSelect('request-owner-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('requests-table-body');
    const countEl = document.getElementById('requests-count');
    if (countEl) countEl.textContent = `${State.requests.length} requests`;

    if (!tableBody) return;
    if (State.requests.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7" class="empty">No requests logged yet.</td></tr>`;
      return;
    }

    const statuses = ['New', 'In Progress', 'Waiting on Client', 'Completed', 'Closed'];

    tableBody.innerHTML = State.requests.map(r => {
      const client = State.clients.find(c => c.id === r.client_id);
      const user = State.users.find(u => u.id === r.owner_id);

      return `
        <tr>
          <td><b>${escapeHtml(r.request)}</b><small>${escapeHtml(r.notes || '')}</small></td>
          <td>${escapeHtml(client ? client.name : '—')}</td>
          <td>${escapeHtml(r.received_date || '—')}</td>
          <td>${escapeHtml(user ? (user.full_name || user.email) : 'Unassigned')}</td>
          <td>${escapeHtml(r.due_date || '—')}</td>
          <td>
            <form class="inline-form" onsubmit="return false;">
              <select onchange="App.updateRequestStatus('${r.id}', this.value)">
                ${statuses.map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </form>
          </td>
          <td>
            <button class="action-btn" onclick="App.deleteRequest('${r.id}')" title="Delete request">✕</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async updateRequestStatus(rid, newStatus) {
    await Storage.updateItemField('requests', rid, { status: newStatus });
    this.showFlash(`Request updated to ${newStatus}.`, 'success');
  },

  async deleteRequest(id) {
    if (!confirm('Are you sure you want to delete this request?')) return;
    await Storage.deleteItem('requests', id);
    this.showFlash('Request deleted.', 'success');
    this.renderRequests();
  },

  // -------------------------------------------------------------------------
  // Billing View
  // -------------------------------------------------------------------------
  renderBilling() {
    this.populateSelect('billing-client-select', State.clients, 'id', 'name', 'Select client');

    const paidTotal = State.billing
      .filter(b => b.status === 'Paid')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const pendingTotal = State.billing
      .filter(b => b.status !== 'Paid')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const paidEl = document.getElementById('billing-total-paid');
    if (paidEl) paidEl.textContent = '₹' + paidTotal.toFixed(2);

    const pendEl = document.getElementById('billing-total-pending');
    if (pendEl) pendEl.textContent = '₹' + pendingTotal.toFixed(2);

    const countEl = document.getElementById('billing-count');
    if (countEl) countEl.textContent = `${State.billing.length} billing records`;

    const tableBody = document.getElementById('billing-table-body');
    if (!tableBody) return;

    if (State.billing.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="7" class="empty">No billing records yet.</td></tr>`;
      return;
    }

    tableBody.innerHTML = State.billing.map(b => {
      const client = State.clients.find(c => c.id === b.client_id);
      let pillClass = '';
      if (b.status === 'Paid') pillClass = 'paid';
      else if (b.status === 'Overdue') pillClass = 'late';

      return `
        <tr>
          <td><b>${escapeHtml(client ? client.name : 'Unknown client')}</b><small>${escapeHtml(b.invoice_no || 'No invoice number')}</small></td>
          <td>${escapeHtml(b.billing_month || '—')}</td>
          <td>₹${Number(b.amount || 0).toFixed(2)}</td>
          <td>${escapeHtml(b.invoice_date || '—')}</td>
          <td>${escapeHtml(b.due_date || '—')}</td>
          <td><span class="pill ${pillClass}">${escapeHtml(b.status || 'Pending')}</span></td>
          <td>
            <button class="action-btn" onclick="App.deleteBilling('${b.id}')" title="Delete record">✕</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async deleteBilling(id) {
    if (!confirm('Are you sure you want to delete this billing record?')) return;
    await Storage.deleteItem('billing', id);
    this.showFlash('Billing record deleted.', 'success');
    this.renderBilling();
  },

  // -------------------------------------------------------------------------
  // Team View (Admin Only) with Approval Requests
  // -------------------------------------------------------------------------
  renderTeam() {
    this.renderPendingApprovals();

    const tableBody = document.getElementById('team-table-body');
    const countEl = document.getElementById('team-count');

    // Approved or Active users
    const approvedUsers = State.users.filter(u => u.status !== 'Pending');
    if (countEl) countEl.textContent = `${approvedUsers.length} active accounts`;

    if (!tableBody) return;
    if (approvedUsers.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" class="empty">No team accounts yet.</td></tr>`;
      return;
    }

    tableBody.innerHTML = approvedUsers.map(u => {
      const isCurrentUser = State.currentUser && State.currentUser.id === u.id;
      const statusPill = u.status === 'Active' ? 
        '<span class="pill paid">Active</span>' : 
        `<span class="pill ${u.status === 'Rejected' ? 'late' : 'pending'}">${escapeHtml(u.status || 'Active')}</span>`;

      return `
        <tr>
          <td>
            <b>${escapeHtml(u.full_name || 'Member')}</b>
            <small>${escapeHtml(u.email || '')}</small>
          </td>
          <td>${escapeHtml(u.email || u.username || '—')}</td>
          <td>${statusPill}</td>
          <td><span class="pill">${escapeHtml(u.role || 'Member')}</span></td>
          <td>
            ${!isCurrentUser && State.currentUser && State.currentUser.role === 'Admin' ? `
              <button class="action-btn" onclick="App.toggleUserRole('${u.id}', '${u.role === 'Admin' ? 'Member' : 'Admin'}')" style="color:#555;">
                Make ${u.role === 'Admin' ? 'Member' : 'Admin'}
              </button>
            ` : '—'}
          </td>
        </tr>
      `;
    }).join('');
  },

  // Render Pending Access Approvals in Team Page
  renderPendingApprovals() {
    const panel = document.getElementById('pending-approvals-panel');
    const tbody = document.getElementById('pending-table-body');
    const countSpan = document.getElementById('pending-count');
    const pending = State.users.filter(u => u.status === 'Pending');

    if (!panel || !tbody) return;

    if (pending.length === 0 || !State.currentUser || State.currentUser.role !== 'Admin') {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    if (countSpan) countSpan.textContent = pending.length;

    tbody.innerHTML = pending.map(u => `
      <tr>
        <td>
          <b>${escapeHtml(u.full_name || 'New User')}</b>
          <small>ID: ${escapeHtml(u.id)}</small>
        </td>
        <td>${escapeHtml(u.email || '—')}</td>
        <td>${escapeHtml(u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Just now')}</td>
        <td>
          <button type="button" class="approve-btn" onclick="App.approveUser('${u.id}')">✓ Approve Access</button>
          <button type="button" class="reject-btn" onclick="App.rejectUser('${u.id}')">✕ Decline</button>
        </td>
      </tr>
    `).join('');
  },

  // Admin approves a pending user
  async approveUser(userId) {
    const user = State.users.find(u => u.id === userId);
    const userEmail = user ? user.email : '';
    const userName = user ? user.full_name : 'Team Member';

    await Storage.updateItemField('users', userId, {
      status: 'Active',
      approved: true,
      approved_at: new Date().toISOString(),
      approved_by: State.currentUser ? State.currentUser.email : 'Admin'
    });

    // Notify approved user via email
    if (userEmail) {
      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(userEmail), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          _subject: `[Dexter HiTech CRM] Your Access Has Been Approved!`,
          'Status': 'Access Granted',
          'Message': `Hello ${userName}, your access request for Dexter HiTech CRM has been approved by the administrator. You can now sign in at any time.`
        })
      }).catch(() => {});
    }

    this.showFlash(`User ${userEmail} approved successfully. They now have access.`, 'success');
    Storage.syncWithFirestore();
  },

  // Admin declines a user request
  async rejectUser(userId) {
    if (!confirm('Are you sure you want to decline access for this user?')) return;
    await Storage.updateItemField('users', userId, {
      status: 'Rejected',
      approved: false,
      rejected_at: new Date().toISOString()
    });
    this.showFlash('Access request declined.', 'error');
    Storage.syncWithFirestore();
  },

  async toggleUserRole(userId, newRole) {
    await Storage.updateItemField('users', userId, { role: newRole });
    this.showFlash(`User role updated to ${newRole}.`, 'success');
    this.renderTeam();
  },

  // -------------------------------------------------------------------------
  // Account View
  // -------------------------------------------------------------------------
  renderAccount() {
    const usrEl = document.getElementById('account-username-display');
    const authMethodEl = document.getElementById('account-auth-method');
    const pwCard = document.getElementById('password-form-card');

    if (State.currentUser) {
      if (usrEl) usrEl.textContent = State.currentUser.email || State.currentUser.full_name;
      
      const user = fbAuth ? fbAuth.currentUser : null;
      const isGoogle = user && user.providerData && user.providerData.some(p => p.providerId === 'google.com');

      if (authMethodEl) {
        authMethodEl.innerHTML = isGoogle ? 
          `<b>Signed in with Google</b> (${escapeHtml(user.email)})` : 
          `<b>Signed in with Email & Password</b> (${escapeHtml(user.email)})`;
      }

      if (pwCard) {
        if (isGoogle) {
          pwCard.innerHTML = `
            <div style="padding:15px; background:#f8f9fa; border-radius:10px; font-size:12px; color:#555;">
              <p style="margin:0 0 6px 0;"><b>Google Account Security</b></p>
              Your account password is secure and managed through Google. To update your credentials, please manage your Google Account directly.
            </div>
          `;
        }
      }
    }
  },

  // -------------------------------------------------------------------------
  // Pending Approval View (pending.html)
  // -------------------------------------------------------------------------
  renderPendingPage(user) {
    if (!user) return;
    const nameEl = document.getElementById('pending-name');
    const emailEl = document.getElementById('pending-email');
    const avatarEl = document.getElementById('pending-avatar');
    
    if (nameEl) nameEl.textContent = user.full_name || 'Team Member';
    if (emailEl) emailEl.textContent = user.email || '—';
    if (avatarEl) {
      const initial = (user.full_name || user.email || 'U').charAt(0).toUpperCase();
      if (user.photoURL) {
        avatarEl.style.backgroundImage = `url('${user.photoURL}')`;
        avatarEl.textContent = '';
      } else {
        avatarEl.style.backgroundImage = 'none';
        avatarEl.textContent = initial;
      }
    }

    // Live real-time Firestore listener on user approval document
    if (typeof fbDb !== 'undefined' && fbDb && user.uid) {
      if (this._userDocUnsub) this._userDocUnsub();
      this._userDocUnsub = fbDb.collection('users').doc(user.uid).onSnapshot(doc => {
        if (doc.exists) {
          const data = doc.data();
          if (data.status === 'Active') {
            const statusText = document.getElementById('pending-status-text');
            if (statusText) statusText.textContent = '✓ Access approved by Admin! Opening dashboard...';
            setTimeout(() => {
              window.location.replace('index.html');
            }, 600);
          }
        }
      }, err => console.warn("Snapshot watcher note:", err));
    }

    // Auto-poll approval status every 4 seconds live as backup
    if (!this._pendingPoller) {
      this._pendingPoller = setInterval(async () => {
        await this.checkPendingApprovalStatus(false);
      }, 4000);
    }
  },

  async checkPendingApprovalStatus(manual = false) {
    const btn = document.getElementById('pending-refresh-btn');
    const statusText = document.getElementById('pending-status-text');
    if (manual && btn) {
      btn.disabled = true;
      btn.textContent = 'Checking status with Firebase...';
    }

    try {
      if (typeof fbAuth !== 'undefined' && fbAuth.currentUser && typeof fbDb !== 'undefined' && fbDb) {
        const uid = fbAuth.currentUser.uid;
        const snap = await fbDb.collection('users').doc(uid).get();
        if (snap.exists) {
          const data = snap.data();
          if (data.status === 'Active') {
            if (statusText) statusText.textContent = '✓ Access approved by Admin! Opening dashboard...';
            if (this._pendingPoller) clearInterval(this._pendingPoller);
            setTimeout(() => {
              window.location.replace('index.html');
            }, 500);
            return;
          }
        }
      }
    } catch (e) {
      console.warn("Status check note", e);
    }

    if (manual) {
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Check Status Now ↻';
        }
        alert("Your account is still awaiting approval from aryanshinde20302003@gmail.com. As soon as the admin approves, you will gain access immediately.");
      }, 500);
    }
  },

  // -------------------------------------------------------------------------
  // Dedicated Admin Panel Controller (admin.html)
  // -------------------------------------------------------------------------
  _adminFilter: 'all',
  _adminSearch: '',

  setAdminUserFilter(filter, btn) {
    this._adminFilter = filter;
    document.querySelectorAll('.filter-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this.renderAdminUsersTable();
  },

  filterAdminUsers() {
    const input = document.getElementById('admin-user-search');
    this._adminSearch = input ? input.value.toLowerCase().trim() : '';
    this.renderAdminUsersTable();
  },

  async refreshAdminData() {
    this.showFlash('Refreshing admin records from Cloud Firestore...', 'success');
    await Storage.syncWithFirestore();
    this.renderAdminPanel();
  },

  initAdminRealtimeListener() {
    if (typeof fbDb !== 'undefined' && fbDb && !this._adminListenerAttached) {
      this._adminListenerAttached = true;
      try {
        fbDb.collection('users').onSnapshot(snap => {
          const cloudUsers = [];
          snap.forEach(doc => {
            cloudUsers.push({ id: doc.id, ...doc.data() });
          });
          if (cloudUsers.length > 0) {
            State.users = cloudUsers;
            localStorage.setItem('dexter_users', JSON.stringify(cloudUsers));
            this.updatePendingBadges();
            this.renderAdminUsersTable();
          }
        }, err => console.warn("Admin realtime note:", err));
      } catch (e) {}
    }
  },

  renderAdminPanel() {
    this.initAdminRealtimeListener();
    const users = State.users || [];
    const pendingUsers = users.filter(u => u.status === 'Pending');
    const activeUsers = users.filter(u => u.status === 'Active');
    const totalUsers = users.length;

    // 1. KPI Counters
    const kpiPending = document.getElementById('kpi-pending-count');
    const kpiActive = document.getElementById('kpi-active-count');
    const kpiTotal = document.getElementById('kpi-total-count');
    const tablePendingCount = document.getElementById('admin-pending-table-count');

    if (kpiPending) kpiPending.textContent = pendingUsers.length;
    if (kpiActive) kpiActive.textContent = activeUsers.length;
    if (kpiTotal) kpiTotal.textContent = totalUsers;
    if (tablePendingCount) tablePendingCount.textContent = pendingUsers.length;

    // 2. Alert Banner
    const alertBanner = document.getElementById('admin-overview-alert');
    const bannerText = document.getElementById('admin-banner-text');
    if (alertBanner) {
      if (pendingUsers.length > 0) {
        if (bannerText) bannerText.textContent = `${pendingUsers.length} user(s) are currently waiting for your approval to enter the workspace.`;
        alertBanner.style.display = 'flex';
      } else {
        alertBanner.style.display = 'none';
      }
    }

    // 3. Render Pending Queue Table
    const pendingTbody = document.getElementById('admin-pending-tbody');
    if (pendingTbody) {
      if (pendingUsers.length === 0) {
        pendingTbody.innerHTML = `
          <tr>
            <td colspan="6" class="empty" style="padding:30px 20px; text-align:center; color:#15803d; background:rgba(220,252,231,0.25);">
              ✨ <b>All caught up!</b> There are no pending access requests at this moment.
            </td>
          </tr>
        `;
      } else {
        pendingTbody.innerHTML = pendingUsers.map(u => {
          const initial = (u.full_name || u.email || 'U').charAt(0).toUpperCase();
          const avatarStyle = u.photoURL ? `background-image:url('${escapeHtml(u.photoURL)}');` : '';
          const isGoogle = u.photoURL || (u.auth_provider === 'google.com');
          const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString() + ' ' + new Date(u.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Recently';

          return `
            <tr>
              <td>
                <div style="display:flex; align-items:center; gap:10px;">
                  <span class="avatar" style="${avatarStyle}">${u.photoURL ? '' : initial}</span>
                  <div>
                    <b>${escapeHtml(u.full_name || 'New Member')}</b>
                    <small style="display:block; color:#94a3b8; font-family:monospace; font-size:10px;">ID: ${escapeHtml(u.id)}</small>
                  </div>
                </div>
              </td>
              <td><b>${escapeHtml(u.email || '—')}</b></td>
              <td>
                <span class="provider-badge">
                  ${isGoogle ? '🌐 Google OAuth' : '✉️ Email & Password'}
                </span>
              </td>
              <td><span style="font-size:12px; color:#475569;">${dateStr}</span></td>
              <td>
                <select id="role-select-${u.id}" style="padding:5px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1;">
                  <option value="Member" selected>Member (Standard)</option>
                  <option value="Admin">Admin (Full Control)</option>
                </select>
              </td>
              <td style="text-align:right;">
                <div class="action-btn-group">
                  <button type="button" class="approve-btn" onclick="App.approvePendingUser('${u.id}')">✓ Approve & Unlock</button>
                  <button type="button" class="reject-btn" onclick="App.rejectUser('${u.id}')">✕ Decline</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // 4. Render All Users Table
    this.renderAdminUsersTable();

    // 5. Render Security Audit Log
    this.renderAdminAuditLog();
  },

  renderAdminUsersTable() {
    const tbody = document.getElementById('admin-all-users-tbody');
    const countEl = document.getElementById('admin-users-count');
    if (!tbody) return;

    let users = State.users || [];
    
    // Apply search filter
    if (this._adminSearch) {
      users = users.filter(u => 
        (u.full_name && u.full_name.toLowerCase().includes(this._adminSearch)) ||
        (u.email && u.email.toLowerCase().includes(this._adminSearch)) ||
        (u.role && u.role.toLowerCase().includes(this._adminSearch))
      );
    }

    // Apply status/role tab filter
    if (this._adminFilter === 'Active') {
      users = users.filter(u => u.status === 'Active');
    } else if (this._adminFilter === 'Pending') {
      users = users.filter(u => u.status === 'Pending');
    } else if (this._adminFilter === 'Rejected') {
      users = users.filter(u => u.status === 'Rejected' || u.status === 'Suspended');
    } else if (this._adminFilter === 'Admin') {
      users = users.filter(u => u.role === 'Admin');
    }

    if (countEl) {
      countEl.textContent = `Showing ${users.length} registered account(s)`;
    }

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">No matching accounts found.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const initial = (u.full_name || u.email || 'U').charAt(0).toUpperCase();
      const avatarStyle = u.photoURL ? `background-image:url('${escapeHtml(u.photoURL)}');` : '';
      const statusClass = (u.status || 'Active').toLowerCase();
      const isPending = (u.status === 'Pending');
      const isActive = (u.status === 'Active');
      const isRejected = (u.status === 'Rejected' || u.status === 'Suspended');
      const isCurrentUser = (State.currentUser && State.currentUser.id === u.id);

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="avatar" style="${avatarStyle}">${u.photoURL ? '' : initial}</span>
              <div>
                <b>${escapeHtml(u.full_name || 'Member')}</b> ${isCurrentUser ? '<small style="color:#2563eb; font-weight:700;">(You)</small>' : ''}
                <small style="display:block; color:#94a3b8; font-family:monospace; font-size:10px;">ID: ${escapeHtml(u.id)}</small>
              </div>
            </div>
          </td>
          <td>${escapeHtml(u.email || '—')}</td>
          <td>
            <span class="pill ${statusClass}">${escapeHtml(u.status || 'Active')}</span>
          </td>
          <td>
            ${isCurrentUser ? `<b>${u.role || 'Admin'}</b>` : `
              <select onchange="App.changeUserRole('${u.id}', this.value)" style="padding:4px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1;">
                <option value="Member" ${u.role === 'Member' ? 'selected' : ''}>Member</option>
                <option value="Admin" ${u.role === 'Admin' ? 'selected' : ''}>Admin</option>
              </select>
            `}
          </td>
          <td>
            ${isActive ? `
              <span class="access-badge granted">✓ Access Granted</span>
            ` : `
              <span class="access-badge blocked">✕ Access Blocked</span>
            `}
          </td>
          <td style="text-align:right;">
            <div class="action-btn-group">
              ${isPending ? `
                <button type="button" class="approve-btn" onclick="App.approvePendingUser('${u.id}')">Approve</button>
              ` : ''}
              ${isActive && !isCurrentUser ? `
                <button type="button" class="suspend-btn" onclick="App.suspendUser('${u.id}')">Suspend</button>
              ` : ''}
              ${isRejected ? `
                <button type="button" class="reactivate-btn" onclick="App.reactivateUser('${u.id}')">Re-activate</button>
              ` : ''}
              ${!isCurrentUser ? `
                <button type="button" class="delete-icon-btn" onclick="App.deleteUserAccount('${u.id}')" title="Delete Account">🗑️</button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  async approvePendingUser(userId) {
    const roleSelect = document.getElementById(`role-select-${userId}`);
    const assignedRole = roleSelect ? roleSelect.value : 'Member';
    const user = State.users.find(u => u.id === userId);
    const userEmail = user ? user.email : '';
    const userName = user ? user.full_name : 'Team Member';

    // 1. Update user profile to Active in Firestore and LocalStorage
    await Storage.updateItemField('users', userId, {
      status: 'Active',
      approved: true,
      role: assignedRole,
      approved_at: new Date().toISOString(),
      approved_by: SUPER_ADMIN_EMAIL
    });

    // 2. Record approval in Firestore notifications
    if (typeof fbDb !== 'undefined' && fbDb) {
      await fbDb.collection('notifications').add(cleanDataForFirestore({
        type: 'user_approval_granted',
        userId: userId,
        userEmail: userEmail,
        userName: userName,
        assignedRole: assignedRole,
        approvedBy: SUPER_ADMIN_EMAIL,
        created_at: new Date().toISOString(),
        status: 'completed'
      })).catch(() => {});
    }

    // 3. Send automated confirmation email to applicant
    if (userEmail) {
      const origin = window.location.origin || '';
      const path = window.location.pathname.replace(/[^\/]*$/, '');
      const dashboardUrl = `${origin}${path}index.html`;

      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(userEmail), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          _subject: `[Dexter HiTech CRM] Your Dashboard Access Has Been Approved!`,
          _template: 'table',
          _captcha: 'false',
          'Status': 'Access Granted (Approved)',
          'Role Assigned': assignedRole,
          'Approved By': SUPER_ADMIN_EMAIL,
          'Message': `Hello ${userName}, your access request for Dexter HiTech CRM has been approved. You now have full access to the dashboard.`,
          'Dashboard Link': dashboardUrl
        })
      }).catch(() => {});
    }

    this.showFlash(`User ${userEmail} approved with role ${assignedRole}! Dashboard access granted.`, 'success');
    await Storage.syncWithFirestore();
    this.renderAdminPanel();
    this.updatePendingBadges();
  },

  async suspendUser(userId) {
    if (!confirm('Are you sure you want to suspend this user? Their dashboard access will be immediately blocked.')) return;
    await Storage.updateItemField('users', userId, {
      status: 'Suspended',
      approved: false,
      suspended_at: new Date().toISOString()
    });
    this.showFlash('User access suspended. Dashboard access is now blocked.', 'error');
    await Storage.syncWithFirestore();
    this.renderAdminPanel();
  },

  async reactivateUser(userId) {
    await Storage.updateItemField('users', userId, {
      status: 'Active',
      approved: true,
      reactivated_at: new Date().toISOString()
    });
    this.showFlash('User reactivated. Dashboard access restored.', 'success');
    await Storage.syncWithFirestore();
    this.renderAdminPanel();
  },

  async changeUserRole(userId, newRole) {
    await Storage.updateItemField('users', userId, { role: newRole });
    this.showFlash(`User role updated to ${newRole}.`, 'success');
    await Storage.syncWithFirestore();
  },

  async deleteUserAccount(userId) {
    if (!confirm('Are you sure you want to delete this user profile? This action cannot be undone.')) return;
    await Storage.deleteItem('users', userId);
    this.showFlash('User profile deleted.', 'success');
    await Storage.syncWithFirestore();
    this.renderAdminPanel();
    this.updatePendingBadges();
  },

  async renderAdminAuditLog() {
    const tbody = document.getElementById('admin-audit-tbody');
    if (!tbody) return;

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        const snap = await fbDb.collection('notifications').orderBy('created_at', 'desc').limit(8).get();
        if (!snap.empty) {
          const rows = [];
          snap.forEach(doc => {
            const d = doc.data();
            const dateStr = d.created_at ? new Date(d.created_at).toLocaleString() : 'Recent';
            rows.push(`
              <tr>
                <td><b>${escapeHtml(d.type || 'access_event')}</b></td>
                <td>${escapeHtml(d.userName || d.userEmail || '—')}</td>
                <td>${escapeHtml(d.approvedBy || d.adminEmail || 'System')}</td>
                <td>${dateStr}</td>
                <td><span class="pill ${d.status === 'pending' ? 'pending' : 'active'}">${escapeHtml(d.status || 'completed')}</span></td>
              </tr>
            `);
          });
          tbody.innerHTML = rows.join('');
          return;
        }
      }
    } catch (e) {
      console.warn("Audit log fetch note:", e);
    }

    tbody.innerHTML = `<tr><td colspan="5" class="empty">No security log events recorded yet.</td></tr>`;
  },

  // -------------------------------------------------------------------------
  // Excel Export
  // -------------------------------------------------------------------------
  exportToExcel() {
    if (typeof XLSX === 'undefined') {
      alert("Excel generator library is loading. Please try again.");
      return;
    }

    const wb = XLSX.utils.book_new();

    const clientsData = [['id', 'name', 'company', 'contact_person', 'phone', 'email', 'service', 'monthly_fee', 'start_date', 'status', 'notes']];
    State.clients.forEach(c => clientsData.push([c.id, c.name, c.company || '', c.contact_person || '', c.phone || '', c.email || '', c.service || '', Number(c.monthly_fee || 0), c.start_date || '', c.status || '', c.notes || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(clientsData), 'Clients');

    const tasksData = [['id', 'client_id', 'title', 'description', 'assignee_id', 'due_date', 'priority', 'status', 'created_at']];
    State.tasks.forEach(t => tasksData.push([t.id, t.client_id || '', t.title, t.description || '', t.assignee_id || '', t.due_date || '', t.priority || '', t.status || '', t.created_at || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tasksData), 'Tasks');

    const reqData = [['id', 'client_id', 'request', 'received_date', 'owner_id', 'due_date', 'status', 'notes']];
    State.requests.forEach(r => reqData.push([r.id, r.client_id || '', r.request, r.received_date || '', r.owner_id || '', r.due_date || '', r.status || '', r.notes || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(reqData), 'Requests');

    const billData = [['id', 'client_id', 'invoice_no', 'billing_month', 'amount', 'invoice_date', 'due_date', 'payment_date', 'status', 'notes']];
    State.billing.forEach(b => billData.push([b.id, b.client_id || '', b.invoice_no || '', b.billing_month || '', Number(b.amount || 0), b.invoice_date || '', b.due_date || '', b.payment_date || '', b.status || '', b.notes || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(billData), 'Billing');

    const teamData = [['id', 'email', 'full_name', 'status', 'role', 'created_at']];
    State.users.forEach(u => teamData.push([u.id, u.email || '', u.full_name || '', u.status || 'Active', u.role || 'Member', u.created_at || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(teamData), 'Team');

    const todayStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `Dexter_HiTech_CRM_${todayStr}.xlsx`);
    this.showFlash('Excel workbook downloaded successfully.', 'success');
  },

  populateSelect(selectId, items, valKey, textKey, defaultLabel) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const currentVal = el.value;
    let html = `<option value="">${defaultLabel}</option>`;
    items.forEach(item => {
      const text = item[textKey] || item.email || item.username || item.id;
      html += `<option value="${item[valKey]}">${escapeHtml(text)}</option>`;
    });
    el.innerHTML = html;
    if (currentVal) el.value = currentVal;
  },

  bindEvents() {
    // 1. Email Sign In Form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const pass = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        const btn = document.getElementById('signin-submit-btn');
        if (errEl) errEl.style.display = 'none';

        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
          const cred = await Auth.loginWithEmail(email, pass);
          const profile = await Auth.syncUserProfile(cred.user);
          if (profile && profile.status === 'Pending') {
            window.location.replace('pending.html');
          } else {
            window.location.replace('index.html');
          }
        } catch (err) {
          if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in <span>→</span>'; }
          if (errEl) {
            let msg = err.message;
            if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
              msg = 'Invalid email or password. Please try again.';
            } else if (err.code === 'auth/unauthorized-domain') {
              App.showUnauthorizedDomainModal(window.location.hostname);
              return;
            }
            errEl.textContent = msg;
            errEl.style.display = 'block';
          }
        }
      });
    }

    // 2. Email Sign Up Form
    const signupForm = document.getElementById('signup-form');
    if (signupForm) {
      signupForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('signup-name').value;
        const email = document.getElementById('signup-email').value;
        const pass = document.getElementById('signup-password').value;
        const confirmPass = document.getElementById('signup-confirm-password').value;
        const errEl = document.getElementById('login-error');
        const btn = document.getElementById('signup-submit-btn');
        if (errEl) errEl.style.display = 'none';

        if (pass !== confirmPass) {
          if (errEl) {
            errEl.textContent = 'Passwords do not match.';
            errEl.style.display = 'block';
          }
          return;
        }

        try {
          if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }
          const userProfile = await Auth.signUpWithEmail(email, pass, name);

          if (userProfile && userProfile.status === 'Pending') {
            window.location.href = 'pending.html';
          } else {
            window.location.href = 'index.html';
          }
        } catch (err) {
          if (btn) { btn.disabled = false; btn.innerHTML = 'Create account <span>→</span>'; }
          if (errEl) {
            let msg = err.message;
            if (err.code === 'auth/email-already-in-use') {
              msg = 'An account with this email already exists. Please sign in instead.';
            } else if (err.code === 'auth/weak-password') {
              msg = 'Password should be at least 6 characters.';
            } else if (err.code === 'auth/unauthorized-domain') {
              App.showUnauthorizedDomainModal(window.location.hostname);
              return;
            }
            errEl.textContent = msg;
            errEl.style.display = 'block';
          }
        }
      });
    }

    // 3. Client Form
    const clientForm = document.getElementById('client-form');
    if (clientForm) {
      clientForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = clientForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };

        const name = getVal('name');
        if (!name) {
          App.showFlash('Please enter a client name.', 'error');
          return;
        }

        const feeRaw = getVal('monthly_fee');
        const feeVal = feeRaw ? (parseFloat(feeRaw) || 0) : 0;

        const newClient = {
          name: name,
          company: getVal('company'),
          contact_person: getVal('contact_person'),
          phone: getVal('phone'),
          email: getVal('email'),
          service: getVal('service'),
          monthly_fee: feeVal,
          start_date: getVal('start_date') || null,
          owner_id: getVal('owner_id') || null,
          status: getVal('status') || 'Active',
          notes: getVal('notes')
        };

        await Storage.saveItem('clients', newClient);
        clientForm.reset();
        App.showFlash(`Client "${name}" added successfully.`, 'success');
        App.renderClients();
      });
    }

    // 4. Task Form
    const taskForm = document.getElementById('task-form');
    if (taskForm) {
      taskForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = taskForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };

        const title = getVal('title');
        if (!title) {
          App.showFlash('Please enter a task title.', 'error');
          return;
        }

        const newTask = {
          title: title,
          client_id: getVal('client_id') || null,
          assignee_id: getVal('assignee_id') || null,
          due_date: getVal('due_date') || null,
          priority: getVal('priority') || 'Medium',
          status: getVal('status') || 'To Do',
          description: getVal('description')
        };

        await Storage.saveItem('tasks', newTask);
        taskForm.reset();
        App.showFlash(`Task "${title}" created.`, 'success');
        App.renderTasks();
      });
    }

    // 5. Request Form
    const reqForm = document.getElementById('request-form');
    if (reqForm) {
      const today = new Date().toISOString().split('T')[0];
      const recEl = reqForm.querySelector('[name="received_date"]');
      if (recEl && !recEl.value) {
        recEl.value = today;
      }

      reqForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = reqForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };

        const reqText = getVal('request');
        if (!reqText) {
          App.showFlash('Please enter request details.', 'error');
          return;
        }

        const newReq = {
          client_id: getVal('client_id') || null,
          received_date: getVal('received_date') || today,
          request: reqText,
          owner_id: getVal('owner_id') || null,
          due_date: getVal('due_date') || null,
          status: getVal('status') || 'New',
          notes: getVal('notes')
        };

        await Storage.saveItem('requests', newReq);
        reqForm.reset();
        const recReset = reqForm.querySelector('[name="received_date"]');
        if (recReset) recReset.value = today;
        App.showFlash('Client request logged.', 'success');
        App.renderRequests();
      });
    }

    // 6. Billing Form
    const billForm = document.getElementById('billing-form');
    if (billForm) {
      billForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = billForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };

        const clientId = getVal('client_id');
        if (!clientId) {
          App.showFlash('Please select a client.', 'error');
          return;
        }

        const amtRaw = getVal('amount');
        const amtVal = amtRaw ? (parseFloat(amtRaw) || 0) : 0;

        const newBill = {
          client_id: clientId,
          invoice_no: getVal('invoice_no'),
          billing_month: getVal('billing_month'),
          amount: amtVal,
          invoice_date: getVal('invoice_date') || null,
          due_date: getVal('due_date') || null,
          payment_date: getVal('payment_date') || null,
          status: getVal('status') || 'Pending',
          notes: getVal('notes')
        };

        await Storage.saveItem('billing', newBill);
        billForm.reset();
        App.showFlash('Billing record added.', 'success');
        App.renderBilling();
      });
    }

    // 7. Team Pre-authorization Form
    const teamForm = document.getElementById('team-form');
    if (teamForm) {
      teamForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = teamForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };
        const email = (getVal('username') || getVal('email')).toLowerCase();
        const fullName = getVal('full_name');
        const role = getVal('role') || 'Member';

        if (!email) {
          App.showFlash('Please enter a team member email.', 'error');
          return;
        }

        const newMember = {
          email: email,
          full_name: fullName,
          role: role,
          status: 'Active', // Pre-authorized by Admin
          approved: true,
          preauthorized: true,
          created_at: new Date().toISOString()
        };

        await Storage.saveItem('users', newMember);
        teamForm.reset();
        App.showFlash(`Team member pre-approved: ${email}. They can now sign in with Google or Email.`, 'success');
        await Storage.syncWithFirestore();
        App.renderTeam();
      });
    }

    // 7b. Admin Panel Pre-authorization Form
    const adminPreauthForm = document.getElementById('admin-preauth-form');
    if (adminPreauthForm) {
      adminPreauthForm.addEventListener('submit', async e => {
        e.preventDefault();
        const getVal = (name) => {
          const el = adminPreauthForm.querySelector(`[name="${name}"]`);
          return el ? el.value.trim() : '';
        };
        const email = getVal('email').toLowerCase();
        const fullName = getVal('full_name');
        const role = getVal('role') || 'Member';

        if (!email) {
          App.showFlash('Please enter an email address to pre-authorize.', 'error');
          return;
        }

        const newPreMember = {
          email: email,
          full_name: fullName,
          role: role,
          status: 'Active', // Pre-authorized by Admin
          approved: true,
          preauthorized: true,
          created_at: new Date().toISOString()
        };

        await Storage.saveItem('users', newPreMember);
        adminPreauthForm.reset();
        App.showFlash(`User ${email} pre-authorized with role ${role}. When they register, dashboard access will be unlocked instantly.`, 'success');
        await Storage.syncWithFirestore();
        App.renderAdminPanel();
      });
    }

    // 8. Password Form
    const pwForm = document.getElementById('password-form');
    if (pwForm) {
      pwForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = pwForm.elements;
        const cur = f.current_password.value;
        const np = f.new_password.value;
        const cp = f.confirm_password.value;

        if (np !== cp) {
          App.showFlash('New password and confirmation do not match.', 'error');
          return;
        }

        try {
          await Auth.changePassword(cur, np);
          pwForm.reset();
          App.showFlash('Password updated successfully.', 'success');
        } catch (err) {
          App.showFlash(err.message, 'error');
        }
      });
    }
  }
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.addEventListener('DOMContentLoaded', () => {
  App.start();
});
