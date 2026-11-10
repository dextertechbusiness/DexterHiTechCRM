/**
 * Dexter HiTech CRM - Pure Client-Side Application Logic
 * Supports Firebase Firestore & Auth, with seamless LocalStorage fallback.
 */

// ---------------------------------------------------------------------------
// 1. Data Store & State
// ---------------------------------------------------------------------------
const State = {
  currentUser: null,
  users: [],
  clients: [],
  tasks: [],
  requests: [],
  billing: [],
  currentView: 'dashboard'
};

const DEFAULT_ADMIN = {
  id: 'user_admin',
  username: 'admin',
  password: 'ChangeMe123!',
  full_name: 'Dexter HiTech Admin',
  role: 'Admin',
  created_at: new Date().toISOString()
};

// ---------------------------------------------------------------------------
// 2. Storage Helpers (Firestore with LocalStorage Fallback)
// ---------------------------------------------------------------------------
const Storage = {
  isCloud() {
    return isFirebaseConfigured() && fbDb !== null;
  },

  async loadInitialData() {
    if (this.isCloud()) {
      try {
        await Promise.all([
          this.loadCollection('users'),
          this.loadCollection('clients'),
          this.loadCollection('tasks'),
          this.loadCollection('requests'),
          this.loadCollection('billing')
        ]);

        // If no users in Firestore yet, bootstrap default admin
        if (State.users.length === 0) {
          await fbDb.collection('users').doc(DEFAULT_ADMIN.id).set(DEFAULT_ADMIN);
          State.users = [DEFAULT_ADMIN];
        }
        return;
      } catch (err) {
        console.warn("[Storage] Failed to load from Firestore, falling back to LocalStorage:", err);
      }
    }

    // LocalStorage mode
    State.users = JSON.parse(localStorage.getItem('dexter_users') || '[]');
    State.clients = JSON.parse(localStorage.getItem('dexter_clients') || '[]');
    State.tasks = JSON.parse(localStorage.getItem('dexter_tasks') || '[]');
    State.requests = JSON.parse(localStorage.getItem('dexter_requests') || '[]');
    State.billing = JSON.parse(localStorage.getItem('dexter_billing') || '[]');

    if (State.users.length === 0) {
      State.users = [DEFAULT_ADMIN];
      localStorage.setItem('dexter_users', JSON.stringify(State.users));
    }
  },

  async loadCollection(colName) {
    const snap = await fbDb.collection(colName).get();
    const items = [];
    snap.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() });
    });
    State[colName] = items;
  },

  async saveItem(colName, item) {
    if (!item.id) {
      item.id = 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }
    if (!item.created_at) {
      item.created_at = new Date().toISOString();
    }

    // Update in-memory state
    const list = State[colName];
    const idx = list.findIndex(x => x.id === item.id);
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.push(item);
    }

    // Save to Firestore if available
    if (this.isCloud()) {
      try {
        await fbDb.collection(colName).doc(item.id).set(item);
      } catch (e) {
        console.error(`[Storage] Firestore save error in ${colName}:`, e);
      }
    }

    // Always mirror to localStorage for fast access & offline resilience
    localStorage.setItem('dexter_' + colName, JSON.stringify(State[colName]));
    return item;
  },

  async deleteItem(colName, id) {
    State[colName] = State[colName].filter(x => x.id !== id);

    if (this.isCloud()) {
      try {
        await fbDb.collection(colName).doc(id).delete();
      } catch (e) {
        console.error(`[Storage] Firestore delete error in ${colName}:`, e);
      }
    }

    localStorage.setItem('dexter_' + colName, JSON.stringify(State[colName]));
  }
};

// ---------------------------------------------------------------------------
// 3. Authentication & Sessions
// ---------------------------------------------------------------------------
const Auth = {
  init() {
    const saved = sessionStorage.getItem('dexter_session');
    if (saved) {
      try {
        State.currentUser = JSON.parse(saved);
      } catch (e) {
        State.currentUser = null;
      }
    }
  },

  async login(username, password) {
    username = (username || '').trim();

    // Check with Firestore or Local state
    let user = State.users.find(u => u.username.toLowerCase() === username.toLowerCase());

    // If using Firebase Auth and user has email format
    if (isFirebaseConfigured() && fbAuth && username.includes('@')) {
      try {
        const cred = await fbAuth.signInWithEmailAndPassword(username, password);
        user = State.users.find(u => u.username === username || u.id === cred.user.uid);
        if (!user) {
          user = {
            id: cred.user.uid,
            username: cred.user.email,
            full_name: cred.user.displayName || cred.user.email.split('@')[0],
            role: 'Member'
          };
        }
      } catch (err) {
        throw new Error(err.message || 'Invalid username or password.');
      }
    } else {
      // Local or Firestore username/password verification
      if (!user || user.password !== password) {
        throw new Error('Invalid username or password.');
      }
    }

    State.currentUser = {
      id: user.id,
      name: user.full_name,
      username: user.username,
      role: user.role
    };

    sessionStorage.setItem('dexter_session', JSON.stringify(State.currentUser));
    return State.currentUser;
  },

  logout() {
    State.currentUser = null;
    sessionStorage.removeItem('dexter_session');
    if (isFirebaseConfigured() && fbAuth) {
      fbAuth.signOut().catch(() => {});
    }
    App.showView('login');
  },

  async changePassword(currentPassword, newPassword) {
    const user = State.users.find(u => u.id === State.currentUser.id);
    if (!user) throw new Error('User not found.');

    if (user.password !== currentPassword) {
      throw new Error('Current password is incorrect.');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new Error('New password must be at least 8 characters.');
    }

    user.password = newPassword;
    await Storage.saveItem('users', user);

    // If Firebase Auth is signed in, sync there too
    if (isFirebaseConfigured() && fbAuth && fbAuth.currentUser) {
      try {
        await fbAuth.currentUser.updatePassword(newPassword);
      } catch (e) {
        console.warn("[Auth] Firebase Auth password update note:", e);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// 4. UI Rendering & Application Controller
// ---------------------------------------------------------------------------
const App = {
  async start() {
    Auth.init();
    await Storage.loadInitialData();

    this.bindEvents();
    this.updateCloudStatusBadge();

    // Check routing
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    if (!State.currentUser) {
      this.showView('login');
    } else {
      this.showView(hash);
    }
  },

  updateCloudStatusBadge() {
    const badge = document.getElementById('cloud-status-badge');
    if (!badge) return;
    if (Storage.isCloud()) {
      badge.innerHTML = `<span class="cloud-dot"></span> Firebase Cloud Connected (${firebaseConfig.projectId})`;
      badge.title = "Connected to live Firebase Cloud Firestore";
    } else {
      badge.innerHTML = `<span class="cloud-dot warn"></span> Local Demo Mode (Configure firebase-config.js to sync)`;
      badge.title = "Running locally. Add your Firebase keys in firebase-config.js to enable Cloud Firestore.";
    }
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

  showView(viewName) {
    if (!State.currentUser && viewName !== 'login') {
      viewName = 'login';
    }

    if (viewName === 'login') {
      document.getElementById('auth-container').style.display = 'block';
      document.getElementById('app-container').style.display = 'none';
      return;
    }

    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('app-container').style.display = 'block';

    // Role check for team view
    if (viewName === 'team' && State.currentUser.role !== 'Admin') {
      this.showFlash('Only administrators can access team settings.', 'error');
      viewName = 'dashboard';
    }

    State.currentView = viewName;
    window.location.hash = viewName;

    // Toggle active classes on view containers
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active');
    });
    const target = document.getElementById('view-' + viewName);
    if (target) target.classList.add('active');

    // Update sidebar navigation selection
    document.querySelectorAll('.nav').forEach(nav => {
      nav.classList.remove('selected');
      if (nav.dataset.view === viewName) {
        nav.classList.add('selected');
      }
    });

    // Update header heading & user chip
    const titles = {
      dashboard: 'Overview',
      clients: 'Clients',
      tasks: 'Tasks & deadlines',
      requests: 'Client requests',
      billing: 'Billing & reports',
      team: 'Team access',
      account: 'My account'
    };
    const headingEl = document.getElementById('topbar-heading');
    if (headingEl) {
      headingEl.textContent = titles[viewName] || 'Overview';
    }

    this.updateUserChip();
    this.renderCurrentView();
  },

  updateUserChip() {
    if (!State.currentUser) return;
    const initial = (State.currentUser.name || 'U').charAt(0).toUpperCase();
    document.getElementById('user-avatar').textContent = initial;
    document.getElementById('user-name').textContent = State.currentUser.name;
    document.getElementById('user-role').textContent = State.currentUser.role;

    // Show/hide Admin team nav
    const teamNav = document.getElementById('team-nav-item');
    if (teamNav) {
      teamNav.style.display = State.currentUser.role === 'Admin' ? 'flex' : 'none';
    }
    const teamHeader = document.getElementById('team-nav-header');
    if (teamHeader) {
      teamHeader.style.display = State.currentUser.role === 'Admin' ? 'block' : 'none';
    }

    // Set today's date label
    const dateLabel = document.getElementById('today-date');
    if (dateLabel) {
      dateLabel.textContent = new Date().toISOString().split('T')[0];
    }
  },

  renderCurrentView() {
    switch (State.currentView) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'clients':
        this.renderClients();
        break;
      case 'tasks':
        this.renderTasks();
        break;
      case 'requests':
        this.renderRequests();
        break;
      case 'billing':
        this.renderBilling();
        break;
      case 'team':
        this.renderTeam();
        break;
      case 'account':
        this.renderAccount();
        break;
    }
  },

  // -------------------------------------------------------------------------
  // Render: Dashboard
  // -------------------------------------------------------------------------
  renderDashboard() {
    const today = new Date().toISOString().split('T')[0];

    const activeClients = State.clients.filter(c => (c.status || 'Active') === 'Active').length;
    const openTasks = State.tasks.filter(t => (t.status || 'To Do') !== 'Done').length;
    const openRequests = State.requests.filter(r => !['Completed', 'Closed'].includes(r.status || 'New')).length;
    const overdueInvoices = State.billing.filter(b => b.status !== 'Paid' && b.due_date && b.due_date < today).length;

    document.getElementById('stat-active-clients').textContent = activeClients;
    document.getElementById('stat-open-tasks').textContent = openTasks;
    document.getElementById('stat-open-requests').textContent = openRequests;
    document.getElementById('stat-overdue-invoices').textContent = overdueInvoices;

    // Upcoming tasks (up to 8, sorted by due_date)
    const upcoming = State.tasks
      .filter(t => t.status !== 'Done')
      .sort((a, b) => {
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      })
      .slice(0, 8);

    const tasksTableBody = document.getElementById('dashboard-tasks-table');
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
            <td>${escapeHtml(user ? user.full_name : 'Unassigned')}</td>
            <td>${escapeHtml(t.due_date || '—')}</td>
            <td><span class="pill">${escapeHtml(t.status || 'To Do')}</span></td>
          </tr>
        `;
      }).join('');
    }

    // Recent requests (up to 6)
    const recent = [...State.requests]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 6);

    const reqContainer = document.getElementById('dashboard-recent-requests');
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
              <small>${escapeHtml(r.received_date || '')} · ${escapeHtml(user ? user.full_name : 'Unassigned')} · ${escapeHtml(r.status || 'New')}</small>
            </div>
          </div>
        `;
      }).join('');
    }
  },

  // -------------------------------------------------------------------------
  // Render: Clients
  // -------------------------------------------------------------------------
  renderClients() {
    this.populateSelect('client-owner-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('clients-table-body');
    document.getElementById('clients-count').textContent = `${State.clients.length} records`;

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
          <td>${escapeHtml(owner ? owner.full_name : 'Unassigned')}</td>
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
    this.renderDashboard();
  },

  // -------------------------------------------------------------------------
  // Render: Tasks
  // -------------------------------------------------------------------------
  renderTasks() {
    this.populateSelect('task-client-select', State.clients, 'id', 'name', 'Internal / none');
    this.populateSelect('task-assignee-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('tasks-table-body');
    document.getElementById('tasks-count').textContent = `${State.tasks.length} tasks`;

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
          <td>${escapeHtml(user ? user.full_name : 'Unassigned')}</td>
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
    const task = State.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.status = newStatus;
    await Storage.saveItem('tasks', task);
    this.showFlash(`Task updated to ${newStatus}.`, 'success');
    this.renderDashboard();
  },

  async deleteTask(id) {
    if (!confirm('Are you sure you want to delete this task?')) return;
    await Storage.deleteItem('tasks', id);
    this.showFlash('Task deleted.', 'success');
    this.renderTasks();
    this.renderDashboard();
  },

  // -------------------------------------------------------------------------
  // Render: Requests
  // -------------------------------------------------------------------------
  renderRequests() {
    this.populateSelect('request-client-select', State.clients, 'id', 'name', 'Select client');
    this.populateSelect('request-owner-select', State.users, 'id', 'full_name', 'Unassigned');

    const tableBody = document.getElementById('requests-table-body');
    document.getElementById('requests-count').textContent = `${State.requests.length} requests`;

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
          <td>${escapeHtml(user ? user.full_name : 'Unassigned')}</td>
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
    const req = State.requests.find(r => r.id === rid);
    if (!req) return;
    req.status = newStatus;
    await Storage.saveItem('requests', req);
    this.showFlash(`Request updated to ${newStatus}.`, 'success');
    this.renderDashboard();
  },

  async deleteRequest(id) {
    if (!confirm('Are you sure you want to delete this request?')) return;
    await Storage.deleteItem('requests', id);
    this.showFlash('Request deleted.', 'success');
    this.renderRequests();
    this.renderDashboard();
  },

  // -------------------------------------------------------------------------
  // Render: Billing
  // -------------------------------------------------------------------------
  renderBilling() {
    this.populateSelect('billing-client-select', State.clients, 'id', 'name', 'Select client');

    const paidTotal = State.billing
      .filter(b => b.status === 'Paid')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const pendingTotal = State.billing
      .filter(b => b.status !== 'Paid')
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    document.getElementById('billing-total-paid').textContent = '₹' + paidTotal.toFixed(2);
    document.getElementById('billing-total-pending').textContent = '₹' + pendingTotal.toFixed(2);
    document.getElementById('billing-count').textContent = `${State.billing.length} billing records`;

    const tableBody = document.getElementById('billing-table-body');
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
    this.renderDashboard();
  },

  // -------------------------------------------------------------------------
  // Render: Team
  // -------------------------------------------------------------------------
  renderTeam() {
    const tableBody = document.getElementById('team-table-body');
    document.getElementById('team-count').textContent = `${State.users.length} accounts`;

    tableBody.innerHTML = State.users.map(u => `
      <tr>
        <td><b>${escapeHtml(u.full_name)}</b></td>
        <td>${escapeHtml(u.username)}</td>
        <td><span class="pill">${escapeHtml(u.role || 'Member')}</span></td>
      </tr>
    `).join('');
  },

  // -------------------------------------------------------------------------
  // Render: Account
  // -------------------------------------------------------------------------
  renderAccount() {
    if (State.currentUser) {
      document.getElementById('account-username-display').textContent = State.currentUser.username;
    }
  },

  // -------------------------------------------------------------------------
  // Export to Excel (SheetJS client-side)
  // -------------------------------------------------------------------------
  exportToExcel() {
    if (typeof XLSX === 'undefined') {
      alert("Excel generator library is still loading. Please try again in a few seconds.");
      return;
    }

    const wb = XLSX.utils.book_new();

    // 1. Clients Sheet
    const clientsData = [
      ['id', 'name', 'company', 'contact_person', 'phone', 'email', 'service', 'monthly_fee', 'start_date', 'status', 'notes']
    ];
    State.clients.forEach(c => {
      clientsData.push([
        c.id, c.name, c.company || '', c.contact_person || '', c.phone || '',
        c.email || '', c.service || '', Number(c.monthly_fee || 0), c.start_date || '', c.status || '', c.notes || ''
      ]);
    });
    const wsClients = XLSX.utils.aoa_to_sheet(clientsData);
    XLSX.utils.book_append_sheet(wb, wsClients, 'Clients');

    // 2. Tasks Sheet
    const tasksData = [
      ['id', 'client_id', 'title', 'description', 'assignee_id', 'due_date', 'priority', 'status', 'created_at']
    ];
    State.tasks.forEach(t => {
      tasksData.push([
        t.id, t.client_id || '', t.title, t.description || '', t.assignee_id || '',
        t.due_date || '', t.priority || '', t.status || '', t.created_at || ''
      ]);
    });
    const wsTasks = XLSX.utils.aoa_to_sheet(tasksData);
    XLSX.utils.book_append_sheet(wb, wsTasks, 'Tasks');

    // 3. Requests Sheet
    const reqData = [
      ['id', 'client_id', 'request', 'received_date', 'owner_id', 'due_date', 'status', 'notes']
    ];
    State.requests.forEach(r => {
      reqData.push([
        r.id, r.client_id || '', r.request, r.received_date || '', r.owner_id || '',
        r.due_date || '', r.status || '', r.notes || ''
      ]);
    });
    const wsReq = XLSX.utils.aoa_to_sheet(reqData);
    XLSX.utils.book_append_sheet(wb, wsReq, 'Requests');

    // 4. Billing Sheet
    const billData = [
      ['id', 'client_id', 'invoice_no', 'billing_month', 'amount', 'invoice_date', 'due_date', 'payment_date', 'status', 'notes']
    ];
    State.billing.forEach(b => {
      billData.push([
        b.id, b.client_id || '', b.invoice_no || '', b.billing_month || '', Number(b.amount || 0),
        b.invoice_date || '', b.due_date || '', b.payment_date || '', b.status || '', b.notes || ''
      ]);
    });
    const wsBill = XLSX.utils.aoa_to_sheet(billData);
    XLSX.utils.book_append_sheet(wb, wsBill, 'Billing');

    // 5. Team Sheet
    const teamData = [
      ['id', 'username', 'full_name', 'role', 'created_at']
    ];
    State.users.forEach(u => {
      teamData.push([
        u.id, u.username, u.full_name, u.role || 'Member', u.created_at || ''
      ]);
    });
    const wsTeam = XLSX.utils.aoa_to_sheet(teamData);
    XLSX.utils.book_append_sheet(wb, wsTeam, 'Team');

    const todayStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `Dexter_HiTech_CRM_${todayStr}.xlsx`);
    this.showFlash('Excel workbook downloaded successfully.', 'success');
  },

  // -------------------------------------------------------------------------
  // Helper: Populate Dropdown
  // -------------------------------------------------------------------------
  populateSelect(selectId, items, valKey, textKey, defaultLabel) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const currentVal = el.value;
    let html = `<option value="">${defaultLabel}</option>`;
    items.forEach(item => {
      html += `<option value="${item[valKey]}">${escapeHtml(item[textKey])}</option>`;
    });
    el.innerHTML = html;
    if (currentVal) el.value = currentVal;
  },

  // -------------------------------------------------------------------------
  // Form Bindings & Listeners
  // -------------------------------------------------------------------------
  bindEvents() {
    // Navigation clicks
    document.querySelectorAll('.nav[data-view]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        App.showView(item.dataset.view);
      });
    });

    // Hash change routing
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '') || 'dashboard';
      if (State.currentUser) {
        App.showView(hash);
      }
    });

    // Login Form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        const u = document.getElementById('login-username').value;
        const p = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        errEl.style.display = 'none';

        try {
          await Auth.login(u, p);
          App.showFlash('Welcome back, ' + State.currentUser.name + '!', 'success');
          App.showView('dashboard');
        } catch (err) {
          errEl.textContent = err.message;
          errEl.style.display = 'block';
        }
      });
    }

    // Client Form
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
        App.renderDashboard();
      });
    }

    // Task Form
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
        App.renderDashboard();
      });
    }

    // Request Form
    const reqForm = document.getElementById('request-form');
    if (reqForm) {
      reqForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = reqForm.elements;
        const newReq = {
          client_id: f.client_id.value || null,
          received_date: f.received_date.value || new Date().toISOString().split('T')[0],
          request: f.request.value.trim(),
          owner_id: f.owner_id.value || null,
          due_date: f.due_date.value || null,
          status: f.status.value || 'New',
          notes: f.notes.value.trim()
        };
        await Storage.saveItem('requests', newReq);
        reqForm.reset();
        f.received_date.value = new Date().toISOString().split('T')[0];
        App.showFlash('Client request logged.', 'success');
        App.renderRequests();
        App.renderDashboard();
      });
    }

    // Billing Form
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
        App.renderDashboard();
      });
    }

    // Team Form (Admin Only)
    const teamForm = document.getElementById('team-form');
    if (teamForm) {
      teamForm.addEventListener('submit', async e => {
        e.preventDefault();
        const f = teamForm.elements;
        const username = f.username.value.trim();
        const exists = State.users.some(u => u.username.toLowerCase() === username.toLowerCase());
        if (exists) {
          App.showFlash('That username already exists.', 'error');
          return;
        }

        const newUser = {
          full_name: f.full_name.value.trim(),
          username: username,
          password: f.password.value,
          role: f.role.value || 'Member'
        };

        await Storage.saveItem('users', newUser);
        teamForm.reset();
        App.showFlash('Team account created.', 'success');
        App.renderTeam();
      });
    }

    // Account Password Form
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

// ---------------------------------------------------------------------------
// 5. Utility
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Auto start when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  App.start();
});
