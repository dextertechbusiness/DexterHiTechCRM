/**
 * Dexter HiTech CRM - Firebase Configuration
 * Ready for free hosting on Vercel and local development
 */

const firebaseConfig = {
  apiKey: "AIzaSyCdR_yYIMq7OcBJqFyAmMQhZ6q_Ihb2C7w",
  authDomain: "dexter-hitech-client-review.firebaseapp.com",
  projectId: "dexter-hitech-client-review",
  storageBucket: "dexter-hitech-client-review.firebasestorage.app",
  messagingSenderId: "73000717784",
  appId: "1:73000717784:web:e6335b72695829beb436ad",
  measurementId: "G-LK1CCR5W0C"
};

let firebaseApp = null;
let fbAuth = null;
let fbDb = null;

function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

if (typeof firebase !== 'undefined' && isFirebaseConfigured()) {
  try {
    if (!firebase.apps.length) {
      firebaseApp = firebase.initializeApp(firebaseConfig);
    } else {
      firebaseApp = firebase.app();
    }
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    console.log("[Firebase] Connected to project:", firebaseConfig.projectId);
  } catch (err) {
    console.error("[Firebase] Initialization error:", err);
  }
}
