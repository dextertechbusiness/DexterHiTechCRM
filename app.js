/**
 * Dexter HiTech CRM - Core Application Engine
 * Secured with Firebase Authentication (Email/Password + Google) & Cloud Firestore
 */

const State = {
  currentUser: null,
  users: [],
  clients: [],
  tasks: [],
  requests: [],
  billing: []
};

// ---------------------------------------------------------------------------
// 1. Firebase Authentication Service
// ---------------------------------------------------------------------------
const Auth = {
  init() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const isLoginPage = (currentPage === 'login.html');

    if (typeof fbAuth === 'undefined' || fbAuth === null) {
      console.warn("[Auth] Firebase Auth is not initialized. Check firebase-config.js.");
      return;
    }

    // Real-time Auth State Listener
    fbAuth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        console.log("[Auth] User authenticated:", firebaseUser.email || firebaseUser.displayName);
        
        // 1. Load or initialize user profile in Firestore
        await this.syncUserProfile(firebaseUser);

        // 2. If already on login page, redirect to dashboard
        if (isLoginPage) {
          window.location.href = 'index.html';
          return;
        }

        // 3. User is authorized on internal pages
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
    const email = firebaseUser.email || '';
    const name = firebaseUser.displayName || (email ? email.split('@')[0] : 'Member');
    const photoURL = firebaseUser.photoURL || '';

    try {
      if (typeof fbDb !== 'undefined' && fbDb) {
        const docRef = fbDb.collection('users').doc(uid);
        const snap = await docRef.get();
        if (snap.exists) {
          profile = { id: uid, ...snap.data() };
        } else {
          // If first user, make Admin; otherwise Member
          const allUsers = await fbDb.collection('users').get();
          const role = (allUsers.empty || allUsers.size === 0) ? 'Admin' : 'Member';
          
          profile = {
            id: uid,
            uid: uid,
            email: email,
            full_name: name,
            photoURL: photoURL,
            role: role,
            created_at: new Date().toISOString()
          };
          await docRef.set(profile);
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
        role: 'Admin'
      };
    }

    State.currentUser = profile;
    sessionStorage.setItem('dexter_session', JSON.stringify(profile));
  },

  async loginWithEmail(email, password) {
    return await fbAuth.signInWithEmailAndPassword(email.trim(), password);
  },

  async signUpWithEmail(email, password, fullName) {
    const cred = await fbAuth.createUserWithEmailAndPassword(email.trim(), password);
    if (fullName && cred.user) {
      await cred.user.updateProfile({ displayName: fullName.trim() });
    }
    await this.syncUserProfile(cred.user);
    return cred.user;
  },

  async loginWithGoogle() {
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.style.display = 'none';

    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');
      
      const result = await fbAuth.signInWithPopup(provider);
      await this.syncUserProfile(result.user);
      window.location.href = 'index.html';
    } catch (err) {
      console.error("[Auth] Google Sign-in Error:", err);
      if (err.code === 'auth/popup-blocked') {
        // Fallback to redirect if popup was blocked by browser
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
      alert(`Password reset email sent to ${targetEmail}. Please check your inbox.`);
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

    // Re-authenticate if possible
    if (currentPassword && user.email) {
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
      await user.reauthenticateWithCredential(cred);
    }
    await user.updatePassword(newPassword);
  }
};

// ---------------------------------------------------------------------------
// 2. Storage & Firestore Sync Layer
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

      // Re-render active view with latest cloud data
      App.renderCurrentPage();
      console.log("[Firebase] Firestore data synchronized.");
    } catch (err) {
      console.warn("[Firebase] Background sync notice:", err.message);
    }
  },

  async fetchCollection(colName) {
    const snap = await fbDb.collection(colName).get();
    const items = [];
    snap.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() });
    });
    State[colName] = items;
    localStorage.setItem('dexter_' + colName, JSON.stringify(items));
    return items;
  },

  async saveItem(colName, item) {
    if (!item.id) {
      item.id = 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }
    if (!item.created_at) {
      item.created_at = new Date().toISOString();
    }

    const list = State[colName];
    const idx = list.findIndex(x => x.id === item.id);
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.unshift(item);
    }

    localStorage.setItem('dexter_' + colName, JSON.stringify(list));

    if (this.isCloud()) {
      await fbDb.collection(colName).doc(item.id).set(item);
    }
    return item;
  },

  async updateItemField(colName, id, fields) {
    const item = State[colName].find(x => x.id === id);
    if (item) {
      Object.assign(item, fields);
      localStorage.setItem('dexter_' + colName, JSON.stringify(State[colName]));
    }
    if (this.isCloud()) {
      await fbDb.collection(colName).doc(id).update(fields);
    }
  },

  async deleteItem(colName, id) {
    State[colName] = State[colName].filter(x => x.id !== id);
    localStorage.setItem('dexter_' + colName, JSON.stringify(State[colName]));

    if (this.isCloud()) {
      await fbDb.collection(colName).doc(id).delete();
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

    // Start Authentication Watcher
    Auth.init();
  },

  onUserAuthenticated() {
    this.updateUserChip();
    this.renderCurrentPage();

    // Sync cloud data in background
    Storage.syncWithFirestore();
  },

  // Mobile Drawer Setup
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

      // Close drawer when any nav link is tapped
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
      'team.html': 'nav-team'
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

    // Show/hide admin-only nav items
    const teamNav = document.getElementById('nav-team');
    if (teamNav) teamNav.style.display = user.role === 'Admin' ? 'flex' : 'none';

    const teamHeader = document.getElementById('team-nav-header');
    if (teamHeader) teamHeader.style.display = user.role === 'Admin' ? 'block' : 'none';

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
    }, 4000);
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
    }
  },

  // Switch between Sign in and Create account in login.html
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
      if (authSubtitle) authSubtitle.textContent = 'Get started with Dexter HiTech CRM.';
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
  // Team View (Admin Only)
  // -------------------------------------------------------------------------
  renderTeam() {
    const tableBody = document.getElementById('team-table-body');
    const countEl = document.getElementById('team-count');
    if (countEl) countEl.textContent = `${State.users.length} accounts`;

    if (!tableBody) return;
    if (State.users.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="4" class="empty">No team accounts yet.</td></tr>`;
      return;
    }

    tableBody.innerHTML = State.users.map(u => {
      const isCurrentUser = State.currentUser && State.currentUser.id === u.id;
      return `
        <tr>
          <td>
            <b>${escapeHtml(u.full_name || 'Member')}</b>
            <small>${escapeHtml(u.email || '')}</small>
          </td>
          <td>${escapeHtml(u.email || u.username || '—')}</td>
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

    const teamData = [['id', 'email', 'full_name', 'role', 'created_at']];
    State.users.forEach(u => teamData.push([u.id, u.email || '', u.full_name || '', u.role || 'Member', u.created_at || '']));
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
          await Auth.loginWithEmail(email, pass);
          window.location.href = 'index.html';
        } catch (err) {
          if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in <span>→</span>'; }
          if (errEl) {
            let msg = err.message;
            if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
              msg = 'Invalid email or password. Please try again.';
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
          await Auth.signUpWithEmail(email, pass, name);
          window.location.href = 'index.html';
        } catch (err) {
          if (btn) { btn.disabled = false; btn.innerHTML = 'Create account <span>→</span>'; }
          if (errEl) {
            let msg = err.message;
            if (err.code === 'auth/email-already-in-use') {
              msg = 'An account with this email already exists. Please sign in instead.';
            } else if (err.code === 'auth/weak-password') {
              msg = 'Password should be at least 6 characters.';
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
        const f = clientForm.elements;
        const newClient = {
          name: f.name.value.trim(),
          company: f.company.value.trim(),
          contact_person: f.contact_person.value.trim(),
          phone: f.phone.value.trim(),
          email: f.email.value.trim(),
          service: f.service.value.trim(),
          monthly_fee: parseFloat(f.monthly_fee.value || 0),
          start_date: f.start_date.value,
          owner_id: f.owner_id.value || null,
          status: f.status.value || 'Active',
          notes: f.notes.value.trim()
        };
        await Storage.saveItem('clients', newClient);
        clientForm.reset();
        App.showFlash('Client added successfully.', 'success');
        App.renderClients();
      });
    }

    // 4. Task Form
    const taskForm = document.getElementById('task-form');
    if (taskForm) {
      taskForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = taskForm.elements;
        const newTask = {
          title: f.title.value.trim(),
          client_id: f.client_id.value || null,
          assignee_id: f.assignee_id.value || null,
          due_date: f.due_date.value || null,
          priority: f.priority.value || 'Medium',
          status: f.status.value || 'To Do',
          description: f.description.value.trim()
        };
        await Storage.saveItem('tasks', newTask);
        taskForm.reset();
        App.showFlash('Task created.', 'success');
        App.renderTasks();
      });
    }

    // 5. Request Form
    const reqForm = document.getElementById('request-form');
    if (reqForm) {
      const today = new Date().toISOString().split('T')[0];
      if (reqForm.elements.received_date && !reqForm.elements.received_date.value) {
        reqForm.elements.received_date.value = today;
      }
      reqForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = reqForm.elements;
        const newReq = {
          client_id: f.client_id.value || null,
          received_date: f.received_date.value || today,
          request: f.request.value.trim(),
          owner_id: f.owner_id.value || null,
          due_date: f.due_date.value || null,
          status: f.status.value || 'New',
          notes: f.notes.value.trim()
        };
        await Storage.saveItem('requests', newReq);
        reqForm.reset();
        if (f.received_date) f.received_date.value = today;
        App.showFlash('Client request logged.', 'success');
        App.renderRequests();
      });
    }

    // 6. Billing Form
    const billForm = document.getElementById('billing-form');
    if (billForm) {
      billForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = billForm.elements;
        const newBill = {
          client_id: f.client_id.value,
          invoice_no: f.invoice_no.value.trim(),
          billing_month: f.billing_month.value.trim(),
          amount: parseFloat(f.amount.value || 0),
          invoice_date: f.invoice_date.value || null,
          due_date: f.due_date.value || null,
          payment_date: f.payment_date.value || null,
          status: f.status.value || 'Pending',
          notes: f.notes.value.trim()
        };
        await Storage.saveItem('billing', newBill);
        billForm.reset();
        App.showFlash('Billing record added.', 'success');
        App.renderBilling();
      });
    }

    // 7. Team Invitation Form
    const teamForm = document.getElementById('team-form');
    if (teamForm) {
      teamForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = teamForm.elements;
        const email = f.username.value.trim();
        const fullName = f.full_name.value.trim();
        const role = f.role.value || 'Member';

        const newMember = {
          email: email,
          full_name: fullName,
          role: role,
          created_at: new Date().toISOString()
        };

        await Storage.saveItem('users', newMember);
        teamForm.reset();
        App.showFlash(`Team member added. They can now sign in with ${email} using Google or Email.`, 'success');
        App.renderTeam();
      });
    }

    // 8. Password Update Form
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
