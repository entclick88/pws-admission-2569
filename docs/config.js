// ═══════════════════════════════════════════════════════════════════════════
//  ตั้งค่ากลางของระบบรับนักเรียนใหม่ รร.มอ.ว.สฎ.
//  แก้ไฟล์นี้ไฟล์เดียว แล้ว push ขึ้น GitHub — ทุกหน้าใช้ค่าเดียวกัน
// ═══════════════════════════════════════════════════════════════════════════
window.PWS_CONFIG = {

  // ── Cloudflare Worker + D1 (ใบสมัคร + ประกาศ + ผลสอบ ทั้งหมด) ────────────
  // ได้จากคำสั่ง `npx wrangler deploy` เช่น https://pws-admission-api.<ชื่อ>.workers.dev
  WORKER_URL: "https://pws-admission-api.entclick88.workers.dev",

  // ── เข้าสู่ระบบผู้ดูแลด้วย Google (หน้า admin.html) ──────────────────────
  // OAuth 2.0 Client ID (ประเภท Web application) จาก Google Cloud Console
  // ต้องตรงกับ GOOGLE_CLIENT_ID ใน worker/wrangler.toml
  // และเพิ่ม URL ของ GitHub Pages ใน "Authorized JavaScript origins" ด้วย
  GOOGLE_CLIENT_ID: "559611452932-2nj81bqtjdtrrmfs4df5chm5p9nkdhtm.apps.googleusercontent.com",

  // ── ไฟล์แนบ (สลิป / ปพ.1) → Cloudinary ──────────────────────────────────
  // สร้าง unsigned upload preset ที่ Settings → Upload → Upload presets
  // (Signing Mode = Unsigned) แล้วนำชื่อ preset กับ cloud name มาวางที่นี่
  CLOUDINARY_CLOUD:  "syyyhyjc",
  CLOUDINARY_PRESET: "pws_admission",
  CLOUDINARY_FOLDER: "pws-admission-2569",
};
