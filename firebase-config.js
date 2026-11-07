// ============================================
// НАСТРОЙКИ FIREBASE (проект bobur-broni)
// Эти значения не секретные: данные защищают правила Firestore и вход по паролю.
// ============================================
export const firebaseConfig = {
  apiKey: "AIzaSyDnlLqsDHXziDWyRSUhvVzC0rKXWh6BA2I",
  authDomain: "bobur-broni.firebaseapp.com",
  projectId: "bobur-broni",
  storageBucket: "bobur-broni.firebasestorage.app",
  messagingSenderId: "869474812902",
  appId: "1:869474812902:web:2b954e4f410e476b7f0c27",
};

// Логины превращаются в "почту" для Firebase: elena → elena@bobur-broni.firebaseapp.com
// (письма на неё никогда не отправляются, это просто формат, который требует Firebase)
export const LOGIN_DOMAIN = "bobur-broni.firebaseapp.com";

// Главный админ: у него всегда полные права, их нельзя отнять.
// Должен совпадать с логином в правилах Firestore.
export const OWNER_LOGIN = "admin";
