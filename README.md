# Dexter HiTech CRM

A client operations & content management web application built with **HTML5, CSS3, JavaScript, and Firebase**.

---

## 📁 Clean Project Structure

```
dexter_hitech_crm/
├── .env                # Active Firebase environment variables
├── .env.example        # Safe template for .env
├── .gitignore          # Protects .env from Git
├── index.html          # Main CRM application interface
├── style.css           # Styling & responsive design
├── app.js              # Business logic, Firestore sync, and Excel export
├── firebase-config.js  # Direct Firebase initialization with your project keys
├── run.bat             # 1-click Windows launcher for localhost
└── README.md           # Documentation
```

---

## ⚡ Quick Start (Localhost)

Double-click **[`run.bat`](run.bat)** or open **[`index.html`](index.html)** in any browser.

- **Default Username**: `admin`
- **Default Password**: `ChangeMe123!`

---

## 🚀 Free Hosting on Vercel (1 Minute)

1. Push this folder to a repository on **[GitHub](https://github.com/)**.
2. Log in to **[Vercel](https://vercel.com/)** and click **Add New...** → **Project**.
3. Select your GitHub repository.
4. Keep the default settings (**Framework Preset**: *Other*, **Root Directory**: `./`) and click **Deploy**.
5. Your CRM is immediately live online for free on a secure `https://your-crm.vercel.app` URL!

---

## 🔐 Firebase Project
- **Project ID**: `dexter-hitech-client-review`
- **Authentication**: Email / Password
- **Database**: Cloud Firestore
