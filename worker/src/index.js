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

// ── chatbot: จับคู่คำสำคัญ คำที่ยาวและตรงกว่าได้คะแนนสูงกว่า ─────────────────
function matchFaq(question, faqs) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return null;

  let best = null, bestScore = 0;
  for (const f of faqs) {
    let score = 0;
    for (const raw of String(f.keywords || '').split(',')) {
      const kw = raw.trim().toLowerCase();
      if (kw && q.includes(kw)) score += kw.length;
    }
    if (score > bestScore) { bestScore = score; best = f; }
  }
  // ต้องตรงอย่างน้อย 3 ตัวอักษร กันการจับคู่มั่ว
  return bestScore >= 3 ? best : null;
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
          'SELECT id, title, body, link_url, link_label, updated_at FROM announcements WHERE published = 1 ORDER BY sort_order, id'
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
        const { q } = await req.json();
        if (!String(q || '').trim()) return err('กรุณาพิมพ์คำถาม');

        const { results } = await env.DB.prepare('SELECT * FROM faqs ORDER BY sort_order, id').all();
        const hit = matchFaq(q, results);
        if (hit) return json({ matched: true, question: hit.question, answer: hit.answer });

        return json({
          matched: false,
          answer: 'ขออภัยค่ะ ยังไม่พบข้อมูลเรื่องนี้ในประกาศรับสมัคร 🙏\n\n' +
                  'ลองถามใหม่ด้วยคำสั้น ๆ เช่น "ค่าสมัคร" "วันสอบ" "เอกสาร" "ค่าเทอม"\n' +
                  'หรือสอบถามเจ้าหน้าที่โดยตรง : 08 4557 9229 กด 5 (จันทร์ - ศุกร์ 08.30 - 16.30 น.)\n' +
                  'LINE ID : psuwitsurat',
        });
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

      // ดึงใบสมัครจาก Google Sheet (Worker เป็นตัวกลาง ไม่เปิดรหัส Sheet ให้เบราว์เซอร์)
      if (path === '/api/admin/applications' && m === 'GET') {
        needAdmin(user);
        if (!env.SHEET_API_URL || !env.SHEET_API_KEY) {
          return err('ยังไม่ได้ตั้งค่า SHEET_API_URL / SHEET_API_KEY ใน Worker', 500);
        }
        const r = await fetch(env.SHEET_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'adminListExam', payload: { key: env.SHEET_API_KEY } }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.status !== 'SUCCESS') return err(data.msg || 'ดึงข้อมูลใบสมัครไม่สำเร็จ', 502);
        return json({ list: data.list || [] });
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
            `INSERT INTO announcements (title, body, link_url, link_label, published, sort_order)
             VALUES (?,?,?,?,?,?)`
          ).bind(b.title || '', b.body || '', b.link_url || null, b.link_label || null,
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
            `UPDATE announcements SET title=?, body=?, link_url=?, link_label=?, published=?,
             sort_order=?, updated_at=datetime('now') WHERE id=?`
          ).bind(b.title || '', b.body || '', b.link_url || null, b.link_label || null,
                 b.published === 0 ? 0 : 1, b.sort_order || 0, mt[1]).run();
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM announcements WHERE id=?').bind(mt[1]).run();
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
