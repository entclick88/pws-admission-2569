// ═══════════════════════════════════════════════════════════════════════════
//  ระบบรับนักเรียนใหม่ รร.มอ.ว.สฎ. — Cloudflare Worker API (D1)
//  จัดการเฉพาะ "ข้อมูลการประกาศ": ประกาศ, FAQ chatbot, รายชื่อ/ที่นั่งสอบ,
//  สัมภาษณ์ และผลสอบรายบุคคล  (ใบสมัครยังเก็บใน Google Sheet ผ่าน Apps Script)
// ═══════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const err = (message, status = 400) => json({ error: message }, status);

// ── ตรวจสิทธิ์ admin ด้วย session token (ออกให้หลัง Google login) ─────────────
async function getSession(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return env.DB.prepare(
    `SELECT s.token, u.id, u.email, u.name, u.picture, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
}

function needAdmin(user) {
  if (!user) throw { status: 401, message: 'ต้องเข้าสู่ระบบผู้ดูแลก่อนใช้งาน' };
}

// ── ยืนยัน Google ID token แล้วออก session (จำกัดโดเมน/อีเมลที่กำหนด) ──────────
async function handleGoogleLogin(req, env) {
  const { credential, remember } = await req.json().catch(() => ({}));
  if (!credential) return err('ไม่พบข้อมูลการเข้าสู่ระบบจาก Google');
  if (!env.GOOGLE_CLIENT_ID) return err('ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID', 500);

  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return err('ตรวจสอบบัญชี Google ไม่สำเร็จ', 401);
  const info = await r.json();

  if (info.aud !== env.GOOGLE_CLIENT_ID) return err('บัญชีนี้ไม่ได้มาจากแอปพลิเคชันที่ถูกต้อง', 401);
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    return err('อีเมล Google นี้ยังไม่ได้รับการยืนยัน', 401);
  }

  const email = String(info.email || '').toLowerCase();
  const adminEmails = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const domains = (env.ALLOWED_DOMAINS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const isListedAdmin = adminEmails.includes(email);
  const domainOk = domains.length > 0 && domains.includes(email.split('@')[1]);

  if (!isListedAdmin && !domainOk) {
    return err('อีเมล ' + email + ' ไม่มีสิทธิ์เข้าใช้งานระบบผู้ดูแล กรุณาติดต่อผู้ดูแลระบบ', 403);
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    await env.DB.prepare('INSERT INTO users (email, name, picture, role) VALUES (?,?,?,?)')
      .bind(email, info.name || email, info.picture || '', 'admin').run();
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  } else {
    await env.DB.prepare('UPDATE users SET name=?, picture=? WHERE id=?')
      .bind(info.name || user.name, info.picture || user.picture, user.id).run();
  }

  // จำ session 30 วันถ้าเลือก "จดจำการเข้าสู่ระบบ" ไม่งั้น 12 ชั่วโมง
  const ttl = remember ? '+30 days' : '+12 hours';
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"
  ).bind(token, user.id, ttl).run();

  // ลบ session ที่หมดอายุทิ้งเป็นระยะ
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

  return json({ token, user: { email, name: info.name || email, picture: info.picture || '' } });
}

const digits = v => String(v == null ? '' : v).replace(/\D/g, '');

// ตรวจเลขประจำตัวประชาชนไทย 13 หลัก — กันการไล่สุ่มเลขเพื่อดูข้อมูลคนอื่น
function isValidThaiId(id) {
  id = digits(id);
  if (id.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(id[i], 10) * (13 - i);
  return (11 - (sum % 11)) % 10 === parseInt(id[12], 10);
}

const RECORD_FIELDS = [
  'app_no', 'full_name', 'exam_type', 'status', 'seat_no', 'room',
  'report_room', 'exam_date', 'time_slot', 'score', 'rank_no', 'note',
];

// ── ใบสมัครสอบ (เก็บใน D1) ──────────────────────────────────────────────────
const EXAM_PREFIX = {
  'สอบคัดเลือกเข้าศึกษาต่อ ชั้นมัธยมศึกษาปีที่ 1': 'M1',
  'สอบคัดเลือกเข้าศึกษาต่อ ชั้นมัธยมศึกษาปีที่ 4': 'M4',
  'สอบวัดความรู้ (Pre-Test) ช่วงชั้นประถมศึกษาตอนปลาย (ป.4 - 6)': 'PP',
  'สอบวัดความรู้ (Pre-Test) ช่วงชั้นมัธยมศึกษาตอนต้น (ม.1 - 3)': 'PM',
};

// ตรวจข้อมูลใบสมัคร — คืนข้อความ error หรือ "" ถ้าผ่าน
function validateApplication(p, isUpdate) {
  const prefix = EXAM_PREFIX[String(p.examType || '').trim()];
  if (!prefix) return 'กรุณาเลือกประเภทการสมัครให้ถูกต้อง';

  const required = [
    ['prefix', 'คำนำหน้า'], ['firstName', 'ชื่อ'], ['lastName', 'นามสกุล'],
    ['citizenId', 'เลขประจำตัวประชาชน'], ['birthDate', 'วันเกิด'],
    ['currentGrade', 'ระดับชั้นปัจจุบัน'], ['school', 'โรงเรียนปัจจุบัน'],
    ['studentPhone', 'เบอร์โทรนักเรียน'],
    ['guardianName', 'ชื่อ-สกุลผู้ปกครอง'], ['guardianPhone', 'เบอร์โทรผู้ปกครอง'],
  ];
  for (const [k, label] of required) {
    if (!String(p[k] || '').trim()) return `กรุณากรอก "${label}" ให้ครบถ้วน`;
  }
  if (!isValidThaiId(p.citizenId)) return 'เลขประจำตัวประชาชนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';

  if (prefix === 'M1' || prefix === 'M4') {
    if (!String(p.applyGroup || '').trim()) return 'กรุณาเลือกกลุ่มการรับสมัคร';
    if (String(p.applyGroup).indexOf('บุตร') === 0 && !String(p.psuPersonName || '').trim()) {
      return 'กรุณาระบุชื่อ-สกุลบุคลากร/ศิษย์เก่า ม.อ. ที่ใช้สิทธิ์';
    }
  }
  if (prefix === 'M4') {
    const g = parseFloat(p.gpax);
    if (isNaN(g)) return 'กรุณากรอกผลการเรียนเฉลี่ยสะสม (GPAX)';
    if (g < 2.50) return 'ผู้สมัคร ม.4 ต้องมีผลการเรียนเฉลี่ยสะสม ม.1 และ ม.2 ไม่ต่ำกว่า 2.50';
    if (g > 4.00) return 'ผลการเรียนเฉลี่ยสะสมต้องไม่เกิน 4.00';
  }

  const okUrl = u => /^https:\/\/res\.cloudinary\.com\//.test(String(u || ''));
  if (!isUpdate && !okUrl(p.slipUrl)) return 'กรุณาแนบภาพหลักฐานการชำระค่าธรรมเนียมการสมัครสอบ 500 บาท';
  if (!isUpdate && prefix === 'M4' && !okUrl(p.docsUrl)) {
    return 'ผู้สมัคร ม.4 ต้องแนบไฟล์ PDF ระเบียนแสดงผลการเรียน (ปพ.1 : บ) และใบรับรองความประพฤติ';
  }
  if (!isUpdate && !p.consent) return 'กรุณายืนยันการรับรองความถูกต้องของข้อมูลก่อนส่งใบสมัคร';
  return '';
}

// รับเฉพาะ URL ของ Cloudinary กันการยัด URL แปลกปลอม
const cleanUrl = u => (/^https:\/\/res\.cloudinary\.com\//.test(String(u || '')) ? String(u) : '');

// ประกอบ object ใบสมัครที่ส่งกลับหน้าเว็บ (คีย์ camelCase ตรงกับ register.html/admin.html)
function rowToApplication(row) {
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch (e) { data = {}; }
  return Object.assign({}, data, {
    appNo: row.app_no, citizenId: row.citizen_id, birthDate: row.birth_date,
    examType: row.exam_type, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

// ── chatbot: จับคู่คำถามแบบยืดหยุ่น ไม่ต้องพิมพ์ตรงเป๊ะ ─────────────────────
// ภาษาไทยไม่เว้นวรรค จึงเทียบด้วย n-gram (Dice coefficient) แทนการตัดคำ
const norm = s => String(s || '').toLowerCase().replace(/[\s​.,!?'"()\[\]{}\-–—:;/\\]+/g, '');

function grams(s, n = 2) {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

// ความคล้าย 0..1 — ลงโทษกรณีความยาวต่างกันมาก จึงไม่เข้าใกล้ 1 แบบมั่ว ๆ
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// คะแนนความเกี่ยวข้องของคำถามกับ FAQ หนึ่งข้อ
function scoreFaq(qn, f) {
  let best = 0;
  for (const raw of String(f.keywords || '').split(',')) {
    const kw = norm(raw);
    if (!kw) continue;
    // คำสำคัญยาวพอและอยู่ในคำถามตรง ๆ = ตรงเต็ม
    if (kw.length >= 3 && qn.includes(kw)) return 1;
    best = Math.max(best, dice(qn, kw));
  }
  // เทียบกับตัวคำถามใน FAQ ด้วย (ถ่วงน้ำหนักรองลงมาเล็กน้อย)
  return Math.max(best, dice(qn, norm(f.question)) * 0.95);
}

// ต่ำกว่านี้ถือว่าตอบไม่ได้ → ส่งให้เจ้าหน้าที่
const MATCH_MIN = 0.42;

function matchFaq(question, faqs) {
  const qn = norm(question);
  if (!qn) return null;
  let best = null, bestScore = 0;
  for (const f of faqs) {
    const s = scoreFaq(qn, f);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore >= MATCH_MIN ? best : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      // ── health ────────────────────────────────────────────────────────────
      if (path === '/' || path === '/api/health') {
        return json({ ok: true, service: 'pws-admission-api' });
      }

      // ผู้ใช้ปัจจุบัน (null ถ้ายังไม่ได้เข้าสู่ระบบ) — ใช้กับทุก endpoint /api/admin/*
      const user = await getSession(req, env);

      // ══════════════ PUBLIC ══════════════

      // ประกาศทั้งหมด
      if (path === '/api/announcements' && m === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, title, body, link_url, link_label, file_url, file_name,
                  file_public_id, file_pages, updated_at
             FROM announcements WHERE published = 1 ORDER BY sort_order, id`
        ).all();
        return json(results);
      }

      // คำถามยอดฮิต (ปุ่มลัดใน chatbot)
      if (path === '/api/faqs' && m === 'GET') {
        const onlySuggested = url.searchParams.get('suggested') === '1';
        const { results } = await env.DB.prepare(
          'SELECT id, question, answer FROM faqs' +
          (onlySuggested ? ' WHERE suggested = 1' : '') + ' ORDER BY sort_order, id'
        ).all();
        return json(results);
      }

      // ถาม chatbot
      if (path === '/api/ask' && m === 'POST') {
        const body = await req.json();
        const q = String(body.q || '').trim();
        if (!q) return err('กรุณาพิมพ์คำถาม');

        const { results } = await env.DB.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
        const hit = matchFaq(q, results);
        if (hit) return json({ matched: true, question: hit.question, answer: hit.answer });

        // ตอบไม่ได้ → บันทึกเข้าคิวให้เจ้าหน้าที่ตอบ แล้วคืนรหัสคำถามให้ผู้ถาม
        let row = await env.DB.prepare(
          "SELECT ticket FROM questions WHERE question = ? AND status = 'pending' LIMIT 1"
        ).bind(q).first();

        let ticket = row && row.ticket;
        if (!ticket) {
          const ins = await env.DB.prepare(
            'INSERT INTO questions (question) VALUES (?) RETURNING id'
          ).bind(q).first();
          ticket = 'Q-' + String(ins.id).padStart(4, '0');
          await env.DB.prepare('UPDATE questions SET ticket = ? WHERE id = ?').bind(ticket, ins.id).run();
        }

        return json({
          matched: false,
          ticket,
          answer: 'ขออภัยค่ะ น้องแอดมิทยังตอบคำถามนี้ไม่ได้ 🙏\n\n' +
                  '📮 ส่งคำถามให้เจ้าหน้าที่แล้ว — รอเจ้าหน้าที่ตอบค่ะ\n' +
                  'รหัสคำถามของคุณคือ ' + ticket + ' (กลับมาเปิดหน้านี้เพื่อดูคำตอบได้)\n\n' +
                  'หากต้องการคำตอบด่วน ติดต่อ 08 4557 9229 กด 5 (จันทร์ - ศุกร์ 08.30 - 16.30 น.)\n' +
                  'LINE ID : psuwitsurat',
        });
      }

      // ตรวจสอบคำตอบจากเจ้าหน้าที่ด้วยรหัสคำถาม
      if (path === '/api/ask/status' && m === 'GET') {
        const t = String(url.searchParams.get('ticket') || '').trim().toUpperCase();
        if (!t) return err('กรุณาระบุรหัสคำถาม');
        const row = await env.DB.prepare(
          'SELECT ticket, question, answer, status, created_at, answered_at FROM questions WHERE upper(ticket) = ?'
        ).bind(t).first();
        if (!row) return err('ไม่พบรหัสคำถามนี้ กรุณาตรวจสอบอีกครั้ง', 404);
        return json(row);
      }

      // รอบการประกาศ + สถานะว่าเปิดให้สืบค้นหรือยัง
      if (path === '/api/stages' && m === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT code, title, published, publish_note FROM stages ORDER BY sort_order'
        ).all();
        return json(results);
      }

      // สืบค้นรายบุคคลด้วยเลขประจำตัวประชาชน — เห็นได้เฉพาะของตนเอง
      if (path === '/api/lookup' && m === 'GET') {
        const cid = digits(url.searchParams.get('cid'));
        if (!isValidThaiId(cid)) return err('เลขประจำตัวประชาชนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง');

        const { results: stages } = await env.DB.prepare(
          'SELECT code, title, published, publish_note FROM stages ORDER BY sort_order'
        ).all();
        const { results: rows } = await env.DB.prepare(
          'SELECT * FROM records WHERE citizen_id = ?'
        ).bind(cid).all();

        const byStage = {};
        for (const r of rows) byStage[r.stage] = r;

        // ส่งกลับเฉพาะรอบที่ประกาศแล้วเท่านั้น
        const out = stages.map(s => ({
          code: s.code,
          title: s.title,
          published: !!s.published,
          publish_note: s.publish_note,
          record: s.published ? (byStage[s.code] || null) : null,
          found: s.published ? !!byStage[s.code] : null,
        }));

        const anyName = rows.map(r => r.full_name).find(Boolean) || '';
        return json({ citizen_id: cid, full_name: anyName, stages: out });
      }

      // ══════════════ ใบสมัครสอบ (PUBLIC → D1) ══════════════

      // ส่งใบสมัคร
      if (path === '/api/exam/submit' && m === 'POST') {
        const p = await req.json();
        const e = validateApplication(p, false);
        if (e) return json({ status: 'FAIL', msg: e });

        const cid = digits(p.citizenId);
        const dup = await env.DB.prepare('SELECT app_no FROM applications WHERE citizen_id = ?').bind(cid).first();
        if (dup) {
          return json({ status: 'FAIL',
            msg: `เลขประจำตัวประชาชนนี้ได้สมัครไว้แล้ว (เลขที่ใบสมัคร ${dup.app_no})\n` +
                 'หากต้องการแก้ไขข้อมูลหรือพิมพ์ใบสมัครซ้ำ กรุณาใช้เมนู "สืบค้น / แก้ไขใบสมัคร"' });
        }

        const prefix = EXAM_PREFIX[String(p.examType).trim()];
        const cnt = await env.DB.prepare('UPDATE app_counters SET n = n + 1 WHERE prefix = ? RETURNING n')
          .bind(prefix).first();
        const appNo = prefix + '-' + String(cnt.n).padStart(4, '0');

        // เก็บทุกฟิลด์เป็น JSON (รวม slipUrl/docsUrl ที่ผ่านการกรอง)
        const data = Object.assign({}, p);
        delete data.consent;
        data.citizenId = cid;
        data.slipUrl = cleanUrl(p.slipUrl);
        data.docsUrl = cleanUrl(p.docsUrl);

        await env.DB.prepare(
          `INSERT INTO applications (app_no, citizen_id, birth_date, exam_type, status, data)
           VALUES (?,?,?,?, 'รอตรวจสอบ', ?)`
        ).bind(appNo, cid, String(p.birthDate || ''), String(p.examType || ''), JSON.stringify(data)).run();

        const row = await env.DB.prepare('SELECT * FROM applications WHERE citizen_id = ?').bind(cid).first();
        return json({ status: 'SUCCESS',
          msg: 'ส่งใบสมัครเรียบร้อยแล้ว เลขที่ใบสมัครของคุณคือ ' + appNo,
          application: rowToApplication(row) });
      }

      // สืบค้นใบสมัคร (เลขบัตร + วันเกิด)
      if (path === '/api/exam/lookup' && m === 'POST') {
        const b = await req.json();
        const cid = digits(b.citizenId);
        if (!isValidThaiId(cid)) return json({ status: 'FAIL', msg: 'กรุณากรอกเลขประจำตัวประชาชน 13 หลัก' });
        if (!b.birthDate) return json({ status: 'FAIL', msg: 'กรุณาระบุวันเกิดเพื่อยืนยันตัวตน' });

        const row = await env.DB.prepare('SELECT * FROM applications WHERE citizen_id = ?').bind(cid).first();
        if (!row) return json({ status: 'FAIL', msg: 'ไม่พบใบสมัครของเลขประจำตัวประชาชนนี้' });
        if (String(row.birth_date) !== String(b.birthDate)) {
          return json({ status: 'FAIL', msg: 'วันเกิดไม่ตรงกับข้อมูลที่ลงทะเบียนไว้' });
        }
        return json({ status: 'SUCCESS', application: rowToApplication(row) });
      }

      // แก้ไขใบสมัคร
      if (path === '/api/exam/update' && m === 'POST') {
        const p = await req.json();
        const e = validateApplication(p, true);
        if (e) return json({ status: 'FAIL', msg: e });

        const cid = digits(p.citizenId);
        const row = await env.DB.prepare('SELECT * FROM applications WHERE citizen_id = ?').bind(cid).first();
        if (!row) return json({ status: 'FAIL', msg: 'ไม่พบใบสมัครของเลขประจำตัวประชาชนนี้' });
        if (String(row.birth_date) !== String(p.birthDate)) {
          return json({ status: 'FAIL', msg: 'วันเกิดไม่ตรงกับข้อมูลที่ลงทะเบียนไว้' });
        }

        const old = rowToApplication(row);
        const data = Object.assign({}, p);
        delete data.consent;
        data.citizenId = cid;
        // แนบไฟล์ใหม่เฉพาะกรณีส่งมา ไม่งั้นคงไฟล์เดิม
        data.slipUrl = cleanUrl(p.slipUrl) || old.slipUrl || '';
        data.docsUrl = cleanUrl(p.docsUrl) || old.docsUrl || '';

        await env.DB.prepare(
          `UPDATE applications SET exam_type = ?, data = ?, updated_at = datetime('now') WHERE citizen_id = ?`
        ).bind(String(p.examType || ''), JSON.stringify(data), cid).run();

        const updated = await env.DB.prepare('SELECT * FROM applications WHERE citizen_id = ?').bind(cid).first();
        return json({ status: 'SUCCESS', msg: 'แก้ไขข้อมูลใบสมัครเรียบร้อยแล้ว',
          application: rowToApplication(updated) });
      }

      // ══════════════ ADMIN ══════════════

      // เข้าสู่ระบบด้วย Google
      if (path === '/api/admin/login' && m === 'POST') {
        return handleGoogleLogin(req, env);
      }

      // ตรวจ session เดิม (ใช้ตอนเปิดหน้า admin ว่ายัง login อยู่ไหม)
      if (path === '/api/admin/me' && m === 'GET') {
        needAdmin(user);
        return json({ user: { email: user.email, name: user.name, picture: user.picture } });
      }

      // ออกจากระบบ — เพิกถอน session ปัจจุบัน
      if (path === '/api/admin/logout' && m === 'POST') {
        if (user) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(user.token).run();
        return json({ ok: true });
      }

      // ดึงใบสมัครทั้งหมดจาก D1 (สำหรับตาราง + ดาวน์โหลด CSV)
      if (path === '/api/admin/applications' && m === 'GET') {
        needAdmin(user);
        const { results } = await env.DB.prepare(
          'SELECT * FROM applications ORDER BY app_no'
        ).all();
        return json({ list: (results || []).map(rowToApplication) });
      }

      // ---- ประกาศ ----
      if (path === '/api/admin/announcements') {
        needAdmin(user);
        if (m === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM announcements ORDER BY sort_order, id'
          ).all();
          return json(results);
        }
        if (m === 'POST') {
          const b = await req.json();
          const r = await env.DB.prepare(
            `INSERT INTO announcements (title, body, link_url, link_label, file_url, file_name,
                                        file_public_id, file_pages, published, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(b.title || '', b.body || '', b.link_url || null, b.link_label || null,
                 cleanUrl(b.file_url) || null, b.file_name || null,
                 b.file_public_id || null, parseInt(b.file_pages, 10) || null,
                 b.published === 0 ? 0 : 1, b.sort_order || 0).run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
      }
      let mt = path.match(/^\/api\/admin\/announcements\/(\d+)$/);
      if (mt) {
        needAdmin(user);
        if (m === 'PUT') {
          const b = await req.json();
          await env.DB.prepare(
            `UPDATE announcements SET title=?, body=?, link_url=?, link_label=?, file_url=?, file_name=?,
             file_public_id=?, file_pages=?, published=?, sort_order=?, updated_at=datetime('now') WHERE id=?`
          ).bind(b.title || '', b.body || '', b.link_url || null, b.link_label || null,
                 cleanUrl(b.file_url) || null, b.file_name || null,
                 b.file_public_id || null, parseInt(b.file_pages, 10) || null,
                 b.published === 0 ? 0 : 1, b.sort_order || 0, mt[1]).run();
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM announcements WHERE id=?').bind(mt[1]).run();
          return json({ ok: true });
        }
      }

      // ---- คำถามที่บอทตอบไม่ได้ (คิวรอเจ้าหน้าที่ตอบ) ----
      if (path === '/api/admin/questions' && m === 'GET') {
        needAdmin(user);
        const st = url.searchParams.get('status');   // pending | answered | (ว่าง = ทั้งหมด)
        const { results } = await env.DB.prepare(
          'SELECT * FROM questions' + (st ? ' WHERE status = ?' : '') +
          " ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC"
        ).bind(...(st ? [st] : [])).all();
        const pending = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM questions WHERE status = 'pending'"
        ).first();
        return json({ list: results || [], pending: pending.n });
      }

      mt = path.match(/^\/api\/admin\/questions\/(\d+)$/);
      if (mt) {
        needAdmin(user);
        if (m === 'PUT') {
          const b = await req.json();
          const answer = String(b.answer || '').trim();
          if (!answer) return err('กรุณาพิมพ์คำตอบ');
          await env.DB.prepare(
            "UPDATE questions SET answer = ?, status = 'answered', answered_at = datetime('now') WHERE id = ?"
          ).bind(answer, mt[1]).run();

          // เลือกบันทึกเป็น FAQ ด้วย เพื่อให้บอทตอบเองได้ในครั้งถัดไป
          if (b.add_faq) {
            const q = await env.DB.prepare('SELECT question FROM questions WHERE id = ?').bind(mt[1]).first();
            await env.DB.prepare(
              'INSERT INTO faqs (keywords, question, answer, suggested, sort_order) VALUES (?,?,?,0,99)'
            ).bind(String(b.keywords || q.question || '').trim(), q.question, answer).run();
          }
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(mt[1]).run();
          return json({ ok: true });
        }
      }

      // ---- FAQ ----
      if (path === '/api/admin/faqs') {
        needAdmin(user);
        if (m === 'GET') {
          const { results } = await env.DB.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
          return json(results);
        }
        if (m === 'POST') {
          const b = await req.json();
          const r = await env.DB.prepare(
            'INSERT INTO faqs (keywords, question, answer, suggested, sort_order) VALUES (?,?,?,?,?)'
          ).bind(b.keywords || '', b.question || '', b.answer || '',
                 b.suggested ? 1 : 0, b.sort_order || 0).run();
          return json({ ok: true, id: r.meta.last_row_id });
        }
      }
      mt = path.match(/^\/api\/admin\/faqs\/(\d+)$/);
      if (mt) {
        needAdmin(user);
        if (m === 'PUT') {
          const b = await req.json();
          await env.DB.prepare(
            'UPDATE faqs SET keywords=?, question=?, answer=?, suggested=?, sort_order=? WHERE id=?'
          ).bind(b.keywords || '', b.question || '', b.answer || '',
                 b.suggested ? 1 : 0, b.sort_order || 0, mt[1]).run();
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM faqs WHERE id=?').bind(mt[1]).run();
          return json({ ok: true });
        }
      }

      // ---- เปิด/ปิดการประกาศแต่ละรอบ ----
      mt = path.match(/^\/api\/admin\/stages\/([a-z0-9_]+)$/);
      if (mt && m === 'PUT') {
        needAdmin(user);
        const b = await req.json();
        await env.DB.prepare(
          'UPDATE stages SET published=?, publish_note=? WHERE code=?'
        ).bind(b.published ? 1 : 0, b.publish_note || null, mt[1]).run();
        return json({ ok: true });
      }

      // ---- ข้อมูลรายบุคคลของแต่ละรอบ ----
      if (path === '/api/admin/records' && m === 'GET') {
        needAdmin(user);
        const stage = url.searchParams.get('stage');
        const { results } = await env.DB.prepare(
          'SELECT * FROM records' + (stage ? ' WHERE stage = ?' : '') + ' ORDER BY app_no, id'
        ).bind(...(stage ? [stage] : [])).all();
        return json(results);
      }

      if (path === '/api/admin/records' && m === 'DELETE') {
        needAdmin(user);
        const stage = url.searchParams.get('stage');
        if (!stage) return err('ต้องระบุ stage ที่จะลบ');
        const r = await env.DB.prepare('DELETE FROM records WHERE stage = ?').bind(stage).run();
        return json({ ok: true, deleted: r.meta.changes });
      }

      // นำเข้าข้อมูลจาก CSV ที่ admin วางในหน้าเว็บ
      // body: { stage, rows: [{citizen_id, app_no, full_name, ...}], replace: bool }
      if (path === '/api/admin/records/import' && m === 'POST') {
        needAdmin(user);
        const b = await req.json();
        const stage = String(b.stage || '').trim();
        const rows = Array.isArray(b.rows) ? b.rows : [];

        if (!stage) return err('ต้องระบุรอบการประกาศ (stage)');
        if (rows.length === 0) return err('ไม่พบข้อมูลที่จะนำเข้า');

        const stageRow = await env.DB.prepare('SELECT code FROM stages WHERE code = ?').bind(stage).first();
        if (!stageRow) return err('ไม่รู้จักรอบการประกาศ: ' + stage);

        const stmts = [];
        if (b.replace) stmts.push(env.DB.prepare('DELETE FROM records WHERE stage = ?').bind(stage));

        let skipped = 0;
        const insert = env.DB.prepare(
          `INSERT INTO records (stage, citizen_id, app_no, full_name, exam_type, status, seat_no,
             room, report_room, exam_date, time_slot, score, rank_no, note, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(stage, citizen_id) DO UPDATE SET
             app_no=excluded.app_no, full_name=excluded.full_name, exam_type=excluded.exam_type,
             status=excluded.status, seat_no=excluded.seat_no, room=excluded.room,
             report_room=excluded.report_room, exam_date=excluded.exam_date,
             time_slot=excluded.time_slot, score=excluded.score, rank_no=excluded.rank_no,
             note=excluded.note, updated_at=datetime('now')`
        );

        for (const row of rows) {
          const cid = digits(row.citizen_id);
          if (cid.length !== 13) { skipped++; continue; }
          stmts.push(insert.bind(
            stage, cid,
            ...RECORD_FIELDS.map(f => (row[f] == null ? null : String(row[f]).trim() || null))
          ));
        }

        if (stmts.length === 0) return err('ไม่มีแถวที่มีเลขประจำตัวประชาชน 13 หลักที่ถูกต้อง');
        await env.DB.batch(stmts);

        const imported = stmts.length - (b.replace ? 1 : 0);
        return json({ ok: true, imported, skipped });
      }

      return err('ไม่พบ endpoint: ' + path, 404);

    } catch (e) {
      if (e && e.status) return err(e.message, e.status);
      return err('เกิดข้อผิดพลาด: ' + (e && e.message ? e.message : String(e)), 500);
    }
  },
};
