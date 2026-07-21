// ═══════════════════════════════════════════════════════════════════════════
//  ระบบรับสมัครสอบ รร.มอ.ว.สฎ. ปีการศึกษา 2569 — Apps Script (ใบสมัคร)
//
//  ขอบเขตของไฟล์นี้: รับ-แก้ไข-ค้นหา "ใบสมัครสอบ" และเก็บลง Google Sheet เท่านั้น
//  • ไฟล์แนบ (สลิป / ปพ.1)  → อัปโหลดตรงไป Cloudinary จากหน้าเว็บ ส่งมาเป็น URL
//  • ข้อมูลการประกาศทั้งหมด → อยู่ที่ Cloudflare D1 (worker/src/index.js)
// ═══════════════════════════════════════════════════════════════════════════

const SPREADSHEET_ID = "1jJgVdeGctUaB5CAMNYhA1asyl45YpUn72pTtZkpRTlc";
const SHEET_EXAM     = "Applicants2569";

// รหัสผู้ดูแล (ใช้ตอนดึงข้อมูลไปทำ CSV) — ตั้งที่
// Project Settings → Script Properties → เพิ่ม property ชื่อ ADMIN_KEY
function getAdminKey() {
  return PropertiesService.getScriptProperties().getProperty("ADMIN_KEY") || "";
}

// ─── doGet: health check ────────────────────────────────────────────────────
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: "OK", msg: "PWS Admission (application form) API พร้อมใช้งาน" })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ─── doPost: JSON API ───────────────────────────────────────────────────────
function doPost(e) {
  var result;
  try {
    var req     = JSON.parse(e.postData.contents);
    var action  = req.action;
    var payload = req.payload || {};

    switch (action) {
      case 'submitExam':    result = submitExam(payload); break;
      case 'lookupExam':    result = lookupExam(payload.citizenId, payload.birthDate); break;
      case 'updateExam':    result = updateExam(payload); break;
      case 'adminListExam': result = adminListExam(payload.key); break;
      case 'adminStats':    result = adminStats(payload.key); break;
      default:
        result = { status: "FAIL", msg: "ไม่รู้จัก action: " + action };
    }
  } catch (err) {
    result = { status: "FAIL", msg: "เกิดข้อผิดพลาด: " + err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function ss()          { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function sheet(name)   { return ss().getSheetByName(name); }
function nowStr()      { return Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss"); }
function digitsOnly(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

// ลำดับคอลัมน์ในชีท (ห้ามสลับ — ใช้ทั้งอ่านและเขียน และต้องตรงกับ EXAM_CSV_HEADERS ใน admin.html)
var EXAM_COLS = [
  "appNo", "examType", "applyGroup", "relationType", "psuPersonName", "psuPersonType",
  "psuPersonPhone", "prefix", "firstName", "lastName", "nickname", "citizenId",
  "birthDate", "gender", "religion", "nationality", "currentGrade", "school",
  "schoolProvince", "gpax", "addressNo", "moo", "road", "subdistrict", "district",
  "province", "zipcode", "studentPhone", "studentEmail", "lineId",
  "fatherName", "fatherPhone", "fatherJob", "motherName", "motherPhone", "motherJob",
  "guardianName", "guardianRelation", "guardianPhone",
  "dormInterest", "knownFrom", "specialNeeds",
  "slipUrl", "docsUrl", "status", "createdAt", "updatedAt"
];

var EXAM_HEADER = [
  "เลขที่ใบสมัคร", "ประเภทการสมัคร", "กลุ่มการรับสมัคร", "ความสัมพันธ์", "ชื่อบุคลากร/ศิษย์เก่า ม.อ.",
  "ประเภทผู้เกี่ยวข้อง", "เบอร์โทรผู้เกี่ยวข้อง", "คำนำหน้า", "ชื่อ", "นามสกุล", "ชื่อเล่น",
  "เลขประจำตัวประชาชน", "วันเกิด", "เพศ", "ศาสนา", "สัญชาติ", "ระดับชั้นปัจจุบัน",
  "โรงเรียนปัจจุบัน", "จังหวัดของโรงเรียน", "GPAX", "บ้านเลขที่", "หมู่ที่", "ถนน",
  "ตำบล/แขวง", "อำเภอ/เขต", "จังหวัด", "รหัสไปรษณีย์", "เบอร์โทรนักเรียน", "อีเมลนักเรียน",
  "LINE ID", "ชื่อ-สกุลบิดา", "เบอร์โทรบิดา", "อาชีพบิดา",
  "ชื่อ-สกุลมารดา", "เบอร์โทรมารดา", "อาชีพมารดา",
  "ชื่อ-สกุลผู้ปกครอง", "ความเกี่ยวข้องกับนักเรียน", "เบอร์โทรผู้ปกครอง",
  "ความสนใจหอพัก", "ทราบข่าวจาก", "ข้อมูลสุขภาพ/ความต้องการพิเศษ",
  "หลักฐานการชำระเงิน", "เอกสาร ปพ.1 + ใบรับรองความประพฤติ", "สถานะ", "วันที่สมัคร", "แก้ไขล่าสุด"
];

// รหัสนำหน้าเลขที่ใบสมัคร แยกตามประเภทการสมัคร
var EXAM_TYPES = {
  "สอบคัดเลือกเข้าศึกษาต่อ ชั้นมัธยมศึกษาปีที่ 1": "M1",
  "สอบคัดเลือกเข้าศึกษาต่อ ชั้นมัธยมศึกษาปีที่ 4": "M4",
  "สอบวัดความรู้ (Pre-Test) ช่วงชั้นประถมศึกษาตอนปลาย (ป.4 - 6)": "PP",
  "สอบวัดความรู้ (Pre-Test) ช่วงชั้นมัธยมศึกษาตอนต้น (ม.1 - 3)": "PM"
};

// ตรวจเลขประจำตัวประชาชนไทย 13 หลักด้วย checksum
function isValidThaiId(id) {
  id = digitsOnly(id);
  if (id.length !== 13) return false;
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += parseInt(id.charAt(i), 10) * (13 - i);
  return ((11 - (sum % 11)) % 10) === parseInt(id.charAt(12), 10);
}

// รับเฉพาะ URL ของ Cloudinary เท่านั้น กันการยัด URL แปลกปลอมเข้าฐานข้อมูล
function cleanUploadUrl(url) {
  url = String(url || "").trim();
  return /^https:\/\/res\.cloudinary\.com\//.test(url) ? url : "";
}

// สร้างเลขที่ใบสมัคร เช่น M1-0001 (running แยกตามประเภท)
function nextExamNo(data, typeCode) {
  var max = 0;
  for (var i = 1; i < data.length; i++) {
    var m = String(data[i][0]).match(/^([A-Z]{2})-(\d{4})$/);
    if (m && m[1] === typeCode) max = Math.max(max, parseInt(m[2], 10));
  }
  return typeCode + "-" + ("0000" + (max + 1)).slice(-4);
}

function mapExam(row) {
  var o = {};
  for (var i = 0; i < EXAM_COLS.length; i++) o[EXAM_COLS[i]] = String(row[i] == null ? "" : row[i]);
  return o;
}

// ตรวจความถูกต้องของข้อมูลใบสมัคร — คืนข้อความ error หรือ "" ถ้าผ่าน
function validateExam(p, isUpdate) {
  var typeCode = EXAM_TYPES[String(p.examType || "").trim()];
  if (!typeCode) return "กรุณาเลือกประเภทการสมัครให้ถูกต้อง";

  var required = [
    ["prefix", "คำนำหน้า"], ["firstName", "ชื่อ"], ["lastName", "นามสกุล"],
    ["citizenId", "เลขประจำตัวประชาชน"], ["birthDate", "วันเกิด"],
    ["currentGrade", "ระดับชั้นปัจจุบัน"], ["school", "โรงเรียนปัจจุบัน"],
    ["studentPhone", "เบอร์โทรนักเรียน"],
    ["guardianName", "ชื่อ-สกุลผู้ปกครอง"], ["guardianPhone", "เบอร์โทรผู้ปกครอง"]
  ];
  for (var i = 0; i < required.length; i++) {
    if (!String(p[required[i][0]] || "").trim()) {
      return "กรุณากรอก \"" + required[i][1] + "\" ให้ครบถ้วน";
    }
  }

  if (!isValidThaiId(p.citizenId)) return "เลขประจำตัวประชาชนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง";

  // เฉพาะสอบคัดเลือกเข้าศึกษาต่อ ต้องระบุกลุ่มการรับสมัคร
  if (typeCode === "M1" || typeCode === "M4") {
    if (!String(p.applyGroup || "").trim()) return "กรุณาเลือกกลุ่มการรับสมัคร";
    if (String(p.applyGroup).indexOf("บุตร") === 0 && !String(p.psuPersonName || "").trim()) {
      return "กรุณาระบุชื่อ-สกุลบุคลากร/ศิษย์เก่า ม.อ. ที่ใช้สิทธิ์";
    }
  }

  // ม.4 ต้องมี GPAX ม.1-2 ไม่ต่ำกว่า 2.50 (ประกาศข้อ 1.3)
  if (typeCode === "M4") {
    var g = parseFloat(p.gpax);
    if (isNaN(g)) return "กรุณากรอกผลการเรียนเฉลี่ยสะสม (GPAX)";
    if (g < 2.50) return "ผู้สมัคร ม.4 ต้องมีผลการเรียนเฉลี่ยสะสม ม.1 และ ม.2 ไม่ต่ำกว่า 2.50";
    if (g > 4.00) return "ผลการเรียนเฉลี่ยสะสมต้องไม่เกิน 4.00";
  }

  // หลักฐานการชำระเงินค่าสมัคร 500 บาท — บังคับตอนสมัครครั้งแรกเท่านั้น
  if (!isUpdate && !cleanUploadUrl(p.slipUrl)) {
    return "กรุณาแนบภาพหลักฐานการชำระค่าธรรมเนียมการสมัครสอบ 500 บาท";
  }
  // ม.4 ต้องแนบ ปพ.1:บ + ใบรับรองความประพฤติ (PDF ไฟล์เดียว)
  if (!isUpdate && typeCode === "M4" && !cleanUploadUrl(p.docsUrl)) {
    return "ผู้สมัคร ม.4 ต้องแนบไฟล์ PDF ระเบียนแสดงผลการเรียน (ปพ.1 : บ) และใบรับรองความประพฤติ";
  }

  if (!isUpdate && !p.consent) return "กรุณายืนยันการรับรองความถูกต้องของข้อมูลก่อนส่งใบสมัคร";
  return "";
}

// ─── ส่งใบสมัครสอบ ──────────────────────────────────────────────────────────
function submitExam(p) {
  var err = validateExam(p, false);
  if (err) return { status: "FAIL", msg: err };

  var sh = sheet(SHEET_EXAM);
  if (!sh) return { status: "FAIL", msg: "ไม่พบชีท " + SHEET_EXAM + " — กรุณารันฟังก์ชัน setup() ก่อน" };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { status: "FAIL", msg: "ระบบกำลังมีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้ง" };
  }

  try {
    var data = sh.getDataRange().getValues();
    var cid  = digitsOnly(p.citizenId);

    for (var i = 1; i < data.length; i++) {
      if (digitsOnly(data[i][11]) === cid) {
        return { status: "FAIL",
                 msg: "เลขประจำตัวประชาชนนี้ได้สมัครไว้แล้ว (เลขที่ใบสมัคร " + data[i][0] + ")\n" +
                      "หากต้องการแก้ไขข้อมูลหรือพิมพ์ใบสมัครซ้ำ กรุณาใช้เมนู \"สืบค้น / แก้ไขใบสมัคร\"" };
      }
    }

    var appNo = nextExamNo(data, EXAM_TYPES[String(p.examType).trim()]);
    var rec   = buildExamRecord(p, appNo, cleanUploadUrl(p.slipUrl),
                                cleanUploadUrl(p.docsUrl), nowStr(), nowStr());

    sh.appendRow(EXAM_COLS.map(function (c) { return rec[c]; }));
    SpreadsheetApp.flush();

    return { status: "SUCCESS",
             msg: "ส่งใบสมัครเรียบร้อยแล้ว เลขที่ใบสมัครของคุณคือ " + appNo,
             application: rec };
  } finally {
    lock.releaseLock();
  }
}

function buildExamRecord(p, appNo, slipUrl, docsUrl, createdAt, updatedAt) {
  var rec = {};
  EXAM_COLS.forEach(function (c) { rec[c] = String(p[c] == null ? "" : p[c]).trim(); });
  rec.appNo     = appNo;
  rec.citizenId = digitsOnly(p.citizenId);
  rec.slipUrl   = slipUrl;
  rec.docsUrl   = docsUrl;
  rec.status    = "รอตรวจสอบ";
  rec.createdAt = createdAt;
  rec.updatedAt = updatedAt;
  return rec;
}

// ─── สืบค้นใบสมัคร (เลขบัตรประชาชน + วันเกิด) ────────────────────────────────
function lookupExam(citizenId, birthDate) {
  var cid = digitsOnly(citizenId);
  if (cid.length !== 13) return { status: "FAIL", msg: "กรุณากรอกเลขประจำตัวประชาชน 13 หลัก" };
  if (!birthDate)        return { status: "FAIL", msg: "กรุณาระบุวันเกิดเพื่อยืนยันตัวตน" };

  var data = sheet(SHEET_EXAM).getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (digitsOnly(data[i][11]) !== cid) continue;
    if (String(data[i][12]).trim() !== String(birthDate).trim()) {
      return { status: "FAIL", msg: "วันเกิดไม่ตรงกับข้อมูลที่ลงทะเบียนไว้" };
    }
    return { status: "SUCCESS", application: mapExam(data[i]) };
  }
  return { status: "FAIL", msg: "ไม่พบใบสมัครของเลขประจำตัวประชาชนนี้" };
}

// ─── แก้ไขใบสมัคร ───────────────────────────────────────────────────────────
function updateExam(p) {
  var err = validateExam(p, true);
  if (err) return { status: "FAIL", msg: err };

  var sh   = sheet(SHEET_EXAM);
  var data = sh.getDataRange().getValues();
  var cid  = digitsOnly(p.citizenId);

  for (var i = 1; i < data.length; i++) {
    if (digitsOnly(data[i][11]) !== cid) continue;
    if (String(data[i][12]).trim() !== String(p.birthDate).trim()) {
      return { status: "FAIL", msg: "วันเกิดไม่ตรงกับข้อมูลที่ลงทะเบียนไว้" };
    }

    var old = mapExam(data[i]);
    // แนบไฟล์ใหม่เฉพาะกรณีต้องการเปลี่ยน — ถ้าไม่ส่งมาให้คงไฟล์เดิมไว้
    var rec = buildExamRecord(p, old.appNo,
                              cleanUploadUrl(p.slipUrl) || old.slipUrl,
                              cleanUploadUrl(p.docsUrl) || old.docsUrl,
                              old.createdAt, nowStr());
    rec.status = old.status || "รอตรวจสอบ";

    sh.getRange(i + 1, 1, 1, EXAM_COLS.length)
      .setValues([EXAM_COLS.map(function (c) { return rec[c]; })]);
    SpreadsheetApp.flush();

    return { status: "SUCCESS", msg: "แก้ไขข้อมูลใบสมัครเรียบร้อยแล้ว", application: rec };
  }
  return { status: "FAIL", msg: "ไม่พบใบสมัครของเลขประจำตัวประชาชนนี้" };
}

// ─── ADMIN ──────────────────────────────────────────────────────────────────
function checkAdminKey(key) {
  var real = getAdminKey();
  if (!real) throw new Error("ยังไม่ได้ตั้งค่า ADMIN_KEY ใน Script Properties");
  if (String(key || "") !== real) throw new Error("รหัสผู้ดูแลไม่ถูกต้อง");
}

function readAllExam() {
  var sh   = sheet(SHEET_EXAM);
  var last = sh.getLastRow();
  if (last <= 1) return [];
  return sh.getRange(2, 1, last - 1, EXAM_COLS.length).getValues()
           .filter(function (r) { return String(r[0]).trim(); })
           .map(mapExam);
}

function adminListExam(key) {
  try { checkAdminKey(key); } catch (e) { return { status: "FAIL", msg: e.message }; }
  return { status: "SUCCESS", list: readAllExam() };
}

function adminStats(key) {
  try { checkAdminKey(key); } catch (e) { return { status: "FAIL", msg: e.message }; }

  var list  = readAllExam();
  var byType = {}, byGroup = {};
  list.forEach(function (a) {
    byType[a.examType]   = (byType[a.examType]   || 0) + 1;
    if (a.applyGroup) byGroup[a.applyGroup] = (byGroup[a.applyGroup] || 0) + 1;
  });
  return { status: "SUCCESS", total: list.length, byType: byType, byGroup: byGroup };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETUP — รันหนึ่งครั้งเพื่อสร้างชีท Applicants2569 พร้อมหัวตาราง
// ═══════════════════════════════════════════════════════════════════════════
function setup() {
  var s  = ss();
  var sh = s.getSheetByName(SHEET_EXAM) || s.insertSheet(SHEET_EXAM);

  if (!String(sh.getRange(1, 1).getValue()).trim()) {
    sh.getRange(1, 1, 1, EXAM_HEADER.length).setValues([EXAM_HEADER]);
    sh.getRange(1, 1, 1, EXAM_HEADER.length).setFontWeight("bold").setBackground("#dbe5f1");
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 110);
    sh.setColumnWidth(2, 260);
    sh.setColumnWidth(3, 260);
  }

  // เลขประจำตัวประชาชนต้องเป็นข้อความ ไม่งั้น Sheets จะตัดเลข 0 นำหน้าทิ้ง
  sh.getRange(2, 12, sh.getMaxRows() - 1, 1).setNumberFormat("@");

  if (!getAdminKey()) {
    var key = Utilities.getUuid().replace(/-/g, "").slice(0, 20);
    PropertiesService.getScriptProperties().setProperty("ADMIN_KEY", key);
    Logger.log("สร้าง ADMIN_KEY ให้แล้ว (เก็บไว้ให้ดี ใช้เข้าหน้า admin): " + key);
  } else {
    Logger.log("ADMIN_KEY ที่ใช้อยู่: " + getAdminKey());
  }

  Logger.log("setup เสร็จสิ้น — ชีท " + SHEET_EXAM + " พร้อมใช้งาน");
}

// เรียกดู ADMIN_KEY ภายหลัง (Run แล้วดูใน Execution log)
function showAdminKey() {
  Logger.log("ADMIN_KEY = " + getAdminKey());
}
