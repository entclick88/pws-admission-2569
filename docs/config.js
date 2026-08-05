// ═══════════════════════════════════════════════════════════════════════════
//  ตั้งค่ากลางของระบบรับนักเรียนใหม่ รร.มอ.ว.สฎ.
//  แก้ไฟล์นี้ไฟล์เดียว แล้ว push ขึ้น GitHub — ทุกหน้าใช้ค่าเดียวกัน
// ═══════════════════════════════════════════════════════════════════════════
window.PWS_CONFIG = {

  // ── ใบสมัครสอบ → Google Sheet (Apps Script Web App) ──────────────────────
  // Deploy → New deployment → Web app → คัดลอก URL ที่ลงท้าย /exec มาวางที่นี่
  APPS_SCRIPT_URL: "PUT_YOUR_APPS_SCRIPT_EXEC_URL_HERE",

  // ── ข้อมูลการประกาศ → Cloudflare Worker + D1 ────────────────────────────
  // ได้จากคำสั่ง `npx wrangler deploy` เช่น https://pws-admission-api.<ชื่อ>.workers.dev
  WORKER_URL: "PUT_YOUR_WORKER_URL_HERE",

  // ── เข้าสู่ระบบผู้ดูแลด้วย Google (หน้า admin.html) ──────────────────────
  // OAuth 2.0 Client ID (ประเภท Web application) จาก Google Cloud Console
  // ต้องตรงกับ GOOGLE_CLIENT_ID ใน worker/wrangler.toml
  // และเพิ่ม URL ของ GitHub Pages ใน "Authorized JavaScript origins" ด้วย
  GOOGLE_CLIENT_ID: "PUT_YOUR_GOOGLE_OAUTH_CLIENT_ID",

  // ── ไฟล์แนบ (สลิป / ปพ.1) → Cloudinary ──────────────────────────────────
  // สร้าง unsigned upload preset ที่ Settings → Upload → Upload presets
  // (Signing Mode = Unsigned) แล้วนำชื่อ preset กับ cloud name มาวางที่นี่
  CLOUDINARY_CLOUD:  "PUT_YOUR_CLOUDINARY_CLOUD_NAME",
  CLOUDINARY_PRESET: "PUT_YOUR_UNSIGNED_UPLOAD_PRESET",
  CLOUDINARY_FOLDER: "pws-admission-2569",
};
