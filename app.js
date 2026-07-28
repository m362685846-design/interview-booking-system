const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cloudbase = require('@cloudbase/node-sdk');

// ===================== 初始化 CloudBase 数据库 =====================
// 环境变量 TCB_ENV 在 CloudBase 控制台「服务设置 → 环境变量」中配置
const cbApp = cloudbase.init({
  env: process.env.TCB_ENV || 'interview-booking-d5dio3f06d1322'
});
const db = cbApp.database();

const POSITIONS_COL = 'positions';
const USERS_COL = 'users';
const BOOKINGS_COL = 'bookings';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ===================== 内存缓存 + 数据库持久化 =====================
// 保证：内存缓存优先；数据库异步执行，失败后自动熔断，后续操作秒级响应

const memStore = {
  positions: { positions: [] },
  users: { users: [ { username: 'hr', password: 'hr123' }, { username: 'admin', password: 'admin123' } ] },
  bookings: { bookings: [] }
};

let dbOnline = true;
const DB_TIMEOUT = 2000;

// 捕获 CloudBase SDK 内部未捕获 Promise 拒绝（避免进程崩溃）
process.on('unhandledRejection', (err) => {
  if (err && (err.code === 'INVALID_PARAM' || (err.message && err.message.includes('secretId')))) {
    dbOnline = false;
  }
});

// 数据库查询 -> 失败自动熔断
function dbOp(queryFn) {
  if (!dbOnline) return Promise.resolve(null);
  return Promise.race([
    Promise.resolve().then(queryFn),
    new Promise(resolve => setTimeout(() => { dbOnline = false; resolve(null); }, DB_TIMEOUT))
  ]).catch(() => { dbOnline = false; return null; });
}

// ========== Positions ==========
async function loadPositions() {
  try {
    const r = await dbOp(() => db.collection(POSITIONS_COL).doc('data').get());
    if (r && r.data && r.data.positions) {
      memStore.positions = r.data;
      return r.data;
    }
  } catch (e) {}
  return memStore.positions;
}

function savePositionsSync(data) {
  memStore.positions = data;    // 内存立即更新
  savePositionsDb(data);        // 数据库异步持久化（不阻塞返回）
}

// ========== 用户 ==========
async function loadUsers() {
  try {
    const r = await dbOp(() => db.collection(USERS_COL).doc('data').get());
    if (r && r.data && r.data.users) {
      memStore.users = r.data;
      return r.data;
    }
  } catch (e) {}
  return memStore.users;
}

function saveUsersSync(data) {
  memStore.users = data;
  saveUsersDb(data);
}

// ========== 预约 ==========
async function loadBookings() {
  try {
    const r = await dbOp(() => db.collection(BOOKINGS_COL).doc('data').get());
    if (r && r.data && r.data.bookings) {
      memStore.bookings = r.data;
      return r.data;
    }
  } catch (e) {}
  return memStore.bookings;
}

function saveBookingsSync(data) {
  memStore.bookings = data;
  saveBookingsDb(data);
}

// ========== 数据库写入（异步，不阻塞请求） ==========
function savePositionsDb(data) {
  if (!dbOnline) return;
  setImmediate(() => upsertSingleton(POSITIONS_COL, data).catch(() => { dbOnline = false; }));
}
function saveUsersDb(data) {
  if (!dbOnline) return;
  setImmediate(() => upsertSingleton(USERS_COL, data).catch(() => { dbOnline = false; }));
}
function saveBookingsDb(data) {
  if (!dbOnline) return;
  setImmediate(() => upsertSingleton(BOOKINGS_COL, data).catch(() => { dbOnline = false; }));
}

// 通用 upsert：doc('data') 覆盖写入
async function upsertSingleton(colName, data) {
  const { _id, ...clean } = data;
  try {
    await db.collection(colName).doc('data').set(clean);
  } catch (e) {
    try { await db.collection(colName).where({}).remove(); } catch(_) {}
    try { await db.collection(colName).add(Object.assign({ _id: 'data' }, clean)); } catch(_) {}
    dbOnline = true; // 恢复成功，重新启用
  }
}

// ============= Session 管理（内存，短期有效） =============
const sessions = new Map();

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !sessions.has(auth)) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  req.sessionUser = sessions.get(auth);
  next();
}

// ============= 候选人端 API =============

app.get('/api/positions', async (req, res) => {
  const data = await loadPositions();
  const published = data.positions
    .filter(p => p.status === 'published')
    .map(p => ({ id: p.id, name: p.name }));
  res.json({ positions: published });
});

app.get('/api/positions/:id/slots', async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (pos.status !== 'published') return res.status(403).json({ error: '该岗位未发布' });

  const interviewerSlots = pos.interviewers.map(iv => {
    const availableSlots = pos.slots
      .filter(s => s.interviewerId === iv.id && s.status === 'available')
      .map(s => ({ id: s.id, date: s.date, start: s.start, end: s.end, label: iv.label }));
    return { label: iv.label, slots: availableSlots };
  }).filter(g => g.slots.length > 0);

  res.json({ positionName: pos.name, interviewerSlots });
});

app.get('/api/positions/:id/verify', async (req, res) => {
  const { name, phoneLast4 } = req.query;
  if (!name || !phoneLast4) return res.status(400).json({ error: '缺少参数' });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (pos.status !== 'published') return res.status(403).json({ error: '该岗位未发布' });

  const allowed = (pos.allowedCandidates || []).find(c => c.name === name && c.phoneLast4 === phoneLast4);
  if (!allowed) return res.json({ verified: false, message: '您不在该岗位的候选人名单中，请联系HR' });

  const bookingsData = await loadBookings();
  const existing = bookingsData.bookings.find(b =>
    b.positionId === req.params.id && b.candidateName === name && b.candidatePhone === phoneLast4
  );
  res.json({ verified: true, existingBooking: existing || null });
});

app.post('/api/book', async (req, res) => {
  const { positionId, candidateName, candidatePhone, slotId } = req.body;
  if (!positionId || !candidateName || !candidatePhone || !slotId)
    return res.status(400).json({ error: '缺少必填参数' });

  const bookingsData = await loadBookings();
  const existing = bookingsData.bookings.find(b =>
    b.positionId === positionId && b.candidateName === candidateName && b.candidatePhone === candidatePhone
  );
  if (existing) return res.status(409).json({ error: '您已预约过该岗位，不能重复预约', existingBooking: existing });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === positionId);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (pos.status !== 'published') return res.status(403).json({ error: '该岗位未发布' });

  const allowed = (pos.allowedCandidates || []).find(
    c => c.name === candidateName && c.phoneLast4 === candidatePhone
  );
  if (!allowed) return res.status(403).json({ error: '您不在该岗位的候选人名单中' });

  const slot = pos.slots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ error: '时段不存在' });
  if (slot.status !== 'available') return res.status(409).json({ error: '该时段已被其他候选人选择' });

  const interviewerId = slot.interviewerId;
  slot.status = 'booked';
  slot.candidateName = candidateName;

  const booking = {
    id: genId(),
    positionId,
    positionName: pos.name,
    candidateName,
    candidatePhone,
    interviewerId,
    interviewerName: pos.interviewers.find(iv => iv.id === interviewerId)?.name || '',
    interviewerLabel: slot.interviewerLabel,
    slotId,
    slotDate: slot.date,
    slotStart: slot.start,
    slotEnd: slot.end,
    status: 'booked',
    statusUpdatedAt: null,
    createdAt: new Date().toISOString()
  };
  bookingsData.bookings.push(booking);

  await Promise.all([savePositionsSync(data), saveBookingsSync(bookingsData)]);
  res.json({ success: true, message: '预约成功！', booking });
});

app.get('/api/bookings/check', async (req, res) => {
  const { positionId, name, phone } = req.query;
  if (!positionId || !name || !phone) return res.status(400).json({ error: '缺少参数' });

  const bookingsData = await loadBookings();
  const booking = bookingsData.bookings.find(b =>
    b.positionId === positionId && b.candidateName === name && b.candidatePhone === phone
  );

  booking ? res.json({ booked: true, booking }) : res.json({ booked: false });
});

app.post('/api/book/change', async (req, res) => {
  const { positionId, candidateName, candidatePhone, newSlotId } = req.body;
  if (!positionId || !candidateName || !candidatePhone || !newSlotId)
    return res.status(400).json({ error: '缺少必填参数' });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === positionId);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });

  const bookingsData = await loadBookings();
  const oldBooking = bookingsData.bookings.find(b =>
    b.positionId === positionId && b.candidateName === candidateName && b.candidatePhone === candidatePhone
  );
  if (!oldBooking) return res.status(404).json({ error: '未找到您的预约记录' });

  const oldSlot = pos.slots.find(s => s.id === oldBooking.slotId);
  if (oldSlot) { oldSlot.status = 'available'; oldSlot.candidateName = null; }

  const newSlot = pos.slots.find(s => s.id === newSlotId);
  if (!newSlot) return res.status(404).json({ error: '新时段不存在' });
  if (newSlot.status !== 'available') {
    if (oldSlot) { oldSlot.status = 'booked'; oldSlot.candidateName = candidateName; }
    return res.status(409).json({ error: '该时段已被其他候选人选择' });
  }

  newSlot.status = 'booked'; newSlot.candidateName = candidateName;
  Object.assign(oldBooking, {
    slotId: newSlotId,
    slotDate: newSlot.date,
    slotStart: newSlot.start,
    slotEnd: newSlot.end,
    interviewerId: newSlot.interviewerId,
    interviewerName: pos.interviewers.find(iv => iv.id === newSlot.interviewerId)?.name || '',
    interviewerLabel: newSlot.interviewerLabel,
    updatedAt: new Date().toISOString()
  });

  await Promise.all([savePositionsSync(data), saveBookingsSync(bookingsData)]);
  res.json({ success: true, message: '修改成功！', booking: oldBooking });
});

app.put('/api/admin/bookings/:bookingId/status', adminAuth, async (req, res) => {
  const validStatuses = ['booked','next_round','offer','rejected'];
  if (!validStatuses.includes(req.body.status))
    return res.status(400).json({ error: '无效的状态值，可选：next_round / offer / rejected' });

  const bookingsData = await loadBookings();
  const booking = bookingsData.bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error: '预约记录不存在' });

  booking.status = req.body.status;
  booking.statusUpdatedAt = new Date().toISOString();

  await saveBookingsSync(bookingsData);
  res.json({ success: true, booking });
});

// ============= HR 管理端 API =============

app.post('/api/admin/login', async (req, res) => {
  const { users } = await loadUsers();
  const user = users.find(u => u.username === req.body.username && u.password === req.body.password);
  if (!user) return res.status(401).json({ error: '账号或密码错误' });

  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, user.username);
  res.json({ success: true, token, username: user.username });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  sessions.delete(req.headers.authorization);
  res.json({ success: true });
});

app.get('/api/admin/positions', adminAuth, async (req, res) => {
  const data = await loadPositions();
  res.json({ positions: data.positions });
});

app.post('/api/admin/positions', adminAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: '岗位名称必填' });

  const data = await loadPositions();
  const pos = {
    id: genId(),
    name: req.body.name,
    status: 'draft',
    interviewers: [],
    slots: [],
    allowedCandidates: [],
    createdAt: new Date().toISOString()
  };
  data.positions.push(pos);

  await savePositionsSync(data);
  res.json({ success: true, position: pos });
});

app.put('/api/admin/positions/:id', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });

  if (req.body.name) pos.name = req.body.name;
  if (req.body.status) pos.status = req.body.status;

  await savePositionsSync(data);
  res.json({ success: true, position: pos });
});

app.delete('/api/admin/positions/:id', adminAuth, async (req, res) => {
  const data = await loadPositions();
  data.positions = data.positions.filter(p => p.id !== req.params.id);

  await savePositionsSync(data);
  res.json({ success: true });
});

app.post('/api/admin/positions/:id/interviewers', adminAuth, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: '面试官姓名必填' });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });

  const iv = {
    id: genId(),
    name: req.body.name,
    email: '',
    label: `面试官${'ABCDEFGHIJ'[pos.interviewers.length]}`
  };
  pos.interviewers.push(iv);

  await savePositionsSync(data);
  res.json({ success: true, interviewer: iv });
});

app.delete('/api/admin/positions/:id/interviewers/:ivId', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });

  pos.interviewers = pos.interviewers.filter(i => i.id !== req.params.ivId);
  pos.slots = pos.slots.filter(s => s.interviewerId !== req.params.ivId);

  const bookingsData = await loadBookings();
  bookingsData.bookings = bookingsData.bookings.filter(
    b => !(b.positionId === req.params.id && b.interviewerId === req.params.ivId)
  );

  await Promise.all([savePositionsSync(data), saveBookingsSync(bookingsData)]);
  res.json({ success: true });
});

// 白名单
app.get('/api/admin/positions/:id/candidates', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  res.json({ candidates: pos.allowedCandidates || [] });
});

app.post('/api/admin/positions/:id/candidates', adminAuth, async (req, res) => {
  const { name, phoneLast4 } = req.body;
  if (!name || !phoneLast4) return res.status(400).json({ error: '姓名和手机号后四位必填' });
  if (!/^\d{4}$/.test(phoneLast4)) return res.status(400).json({ error: '手机号后四位必须是4位数字' });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (!pos.allowedCandidates) pos.allowedCandidates = [];
  if (pos.allowedCandidates.find(c => c.name === name && c.phoneLast4 === phoneLast4))
    return res.status(409).json({ error: '该候选人已存在' });

  const candidate = { id: genId(), name, phoneLast4 };
  pos.allowedCandidates.push(candidate);
  await savePositionsSync(data);
  res.json({ success: true, candidate });
});

app.delete('/api/admin/positions/:id/candidates/:cId', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (!pos.allowedCandidates) pos.allowedCandidates = [];

  const candidate = pos.allowedCandidates.find(c => c.id === req.params.cId);
  if (!candidate) return res.status(404).json({ error: '候选人不存在' });

  pos.allowedCandidates = pos.allowedCandidates.filter(c => c.id !== req.params.cId);
  // 解锁该候选人的时段
  pos.slots.forEach(s => {
    if (s.candidateName === candidate.name && s.status === 'booked') {
      s.status = 'available'; s.candidateName = null;
    }
  });

  const bookingsData = await loadBookings();
  bookingsData.bookings = bookingsData.bookings.filter(b =>
    !(b.positionId === req.params.id && b.candidateName === candidate.name && b.candidatePhone === candidate.phoneLast4)
  );

  await Promise.all([savePositionsSync(data), saveBookingsSync(bookingsData)]);
  res.json({ success: true });
});

// 批量导入
app.post('/api/admin/positions/:id/candidates/batch', adminAuth, async (req, res) => {
  if (!req.body.text) return res.status(400).json({ error: '请输入文本' });

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: '岗位不存在' });
  if (!pos.allowedCandidates) pos.allowedCandidates = [];

  let added = 0, skipped = 0;
  for (const line of req.body.text.trim().split('\n').map(l=>l.trim()).filter(l=>l)) {
    const parts = line.split(/[\s,，|｜]+/).filter(p => p);
    if (parts.length < 2) { skipped++; continue; }
    let name='', phoneLast4='';
    for (const p of parts) {
      /^\d{4}$/.test(p) ? (phoneLast4=p) : (name+=p);
    }
    if (!name || !phoneLast4) { skipped++; continue; }
    if (pos.allowedCandidates.find(c => c.name===name && c.phoneLast4===phoneLast4)) { skipped++; continue; }
    pos.allowedCandidates.push({ id: genId(), name, phoneLast4 }); added++;
  }

  await savePositionsSync(data);
  res.json({ success: true, added, skipped });
});

// 解析面试官文本（同步函数，无需改）
function parseInterviewerText(text) {
  const blocks = text.trim().split(/\n\s*\n/), result=[];
  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l=>l.trim()).filter(l=>l);
    if (lines.length < 2) continue;
    const name=lines[0], schedule=[];
    for (let i=1; i<lines.length; i++) {
      const parts = lines[i].split('|').map(s=>s.trim());
      if (parts.length < 2) continue;
      const date=parts[0];
      const ranges = parts[1].split(',').map(s=>{
        const [start,end]=s.trim().split('-').map(t=>t.trim());
        return start&&end ? {start,end} : null;
      }).filter(r=>r);
      ranges.length && schedule.push({date,ranges});
    }
    schedule.length && result.push({name,schedule});
  }
  return result;
}

app.post('/api/admin/positions/:id/import-interviewers', adminAuth, async (req, res) => {
  const { text, durationMinutes } = req.body;
  if (!text) return res.status(400).json({ error:'请输入文本' });
  const dur = durationMinutes || 60;

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error:'岗位不存在' });

  const parsed = parseInterviewerText(text);
  if (!parsed.length) return res.status(400).json({ error:'未能解析到有效数据' });

  const addedIvs=[], slotStats=[];

  for (const item of parsed) {
    let iv = pos.interviewers.find(i => i.name === item.name);
    if (!iv) {
      iv = {
        id: genId(), name:item.name, email:'',
        label:`面试官${'ABCDEFGHIJ'[pos.interviewers.length]}`
      };
      pos.interviewers.push(iv); addedIvs.push(iv);
    }

    let count=0;
    for (const day of item.schedule) {
      for (const range of day.ranges) {
        const [sh,sm]=range.start.split(':').map(Number),
              [eh,em]=range.end.split(':').map(Number);
        let sMin = sh*60+sm, eMin = eh*60+em;
        while (sMin+dur <= eMin) {
          const s=`${String(Math.floor(sMin/60)).padStart(2,'0')}:${String(sMin%60).padStart(2,'0')}`;
          const e=`${String(Math.floor((sMin+dur)/60)).padStart(2,'0')}:${String((sMin+dur)%60).padStart(2,'0')}`;
          if (!pos.slots.some(sl => sl.interviewerId===iv.id && sl.date===day.date && sl.start===s)) {
            pos.slots.push({
              id:genId(), interviewerId:iv.id, interviewerLabel:iv.label,
              date:day.date, start:s, end:e,
              status:'available', candidateName:null
            });
            count++;
          }
          sMin += dur;
        }
      }
    }
    slotStats.push({ name:item.name, label:iv.label, slotsGenerated:count });
  }

  await savePositionsSync(data);
  res.json({ success:true, interviewersAdded:addedIvs.length, slotStats });
});

app.post('/api/admin/positions/:id/slots/generate', adminAuth, async (req, res) => {
  const { date, timeRanges, durationMinutes, interviewerSlots } = req.body;

  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error:'岗位不存在' });

  const dur = durationMinutes || 60;
  let totalCreated = 0;

  function makeSlot(iv,d,startMin,eMin) {
    while (startMin + dur <= eMin) {
      const s=`${String(Math.floor(startMin/60)).padStart(2,'0')}:${String(startMin%60).padStart(2,'0')}`;
      const e=`${String(Math.floor((startMin+dur)/60)).padStart(2,'0')}:${String((startMin+dur)%60).padStart(2,'0')}`;
      if (!pos.slots.some(sl => sl.interviewerId===iv.id && sl.date===d && sl.start===s)) {
        pos.slots.push({
          id:genId(), interviewerId:iv.id, interviewerLabel:iv.label,
          date:d, start:s, end:e,
          status:'available', candidateName:null
        });
        totalCreated++;
      }
      startMin += dur;
    }
  }

  if (interviewerSlots) {
    interviewerSlots.forEach(({interviewerId,timeRanges:ranges}) => {
      const iv=pos.interviewers.find(i=>i.id===interviewerId); if(!iv)return;
      ranges.forEach(range => {
        const [sh,sm]=range.start.split(':').map(Number), [eh,em]=range.end.split(':').map(Number);
        makeSlot(iv,date,sh*60+sm,eh*60+em);
      });
    });
  } else {
    pos.interviewers.forEach(iv => {
      timeRanges.forEach(range => {
        const [sh,sm]=range.start.split(':').map(Number), [eh,em]=range.end.split(':').map(Number);
        makeSlot(iv,date,sh*60+sm,eh*60+em);
      });
    });
  }

  await savePositionsSync(data);
  res.json({ success:true, slotsCount:totalCreated });
});

app.delete('/api/admin/positions/:id/slots', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error:'岗位不存在' });

  const { date } = req.query;
  pos.slots = date ? pos.slots.filter(s => s.date !== date) : [];

  await savePositionsSync(data);
  res.json({ success:true });
});

app.put('/api/admin/positions/:id/slots/:slotId/toggle', adminAuth, async (req, res) => {
  const data = await loadPositions();
  const pos = data.positions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error:'岗位不存在' });
  const slot = pos.slots.find(s => s.id === req.params.slotId);
  if (!slot) return res.status(404).json({ error:'时段不存在' });
  if (slot.status === 'booked') return res.status(400).json({ error:'已预约的时段不能修改' });

  slot.status = slot.status==='disabled'?'available':'disabled';
  await savePositionsSync(data);
  res.json({ success:true, status:slot.status });
});

app.get('/api/admin/positions/:id/bookings', adminAuth, async (req, res) => {
  const bookingsData = await loadBookings();
  res.json({ bookings: bookingsData.bookings.filter(b => b.positionId === req.params.id) });
});

app.get('/api/admin/bookings', adminAuth, async (req, res) => {
  const bookingsData = await loadBookings();
  res.json({ bookings: bookingsData.bookings });
});

app.delete('/api/admin/bookings/processed', adminAuth, async (req, res) => {
  const processedStatuses=['next_round','offer','rejected'];
  const bookingsData = await loadBookings();
  const removedCount = bookingsData.bookings.length - (
    bookingsData.bookings = bookingsData.bookings.filter(b => !processedStatuses.includes(b.status))
  ).length;

  await saveBookingsSync(bookingsData);
  res.json({ success:true, deletedCount:removedCount });
});

app.delete('/api/admin/bookings/:bookingId', adminAuth, async (req, res) => {
  const bookingsData = await loadBookings();
  const idx = bookingsData.bookings.findIndex(b => b.id === req.params.bookingId);
  if (idx === -1) return res.status(404).json({ error:'预约记录不存在' });

  bookingsData.bookings.splice(idx,1);
  await saveBookingsSync(bookingsData);
  res.json({ success:true });
});

app.post('/api/admin/bookings/:bookingId/revert', adminAuth, async (req, res) => {
  const bookingsData = await loadBookings();
  const booking = bookingsData.bookings.find(b => b.id === req.params.bookingId);
  if (!booking) return res.status(404).json({ error:'预约记录不存在' });

  const positionsData = await loadPositions();
  const pos = positionsData.positions.find(p => p.id === booking.positionId);
  if (pos) {
    const slot = pos.slots.find(s => s.id === booking.slotId);
    if (slot) { slot.status='available'; slot.candidateName=null; }
    await savePositionsSync(positionsData);
  }

  bookingsData.bookings = bookingsData.bookings.filter(b => b.id !== req.params.bookingId);
  await saveBookingsSync(bookingsData);

  res.json({ success:true, message:'预约已退回，候选人可重新选择时段' });
});

app.post('/api/admin/change-password', adminAuth, async (req, res) => {
  const { oldPassword,newPassword } = req.body;
  if (!oldPassword||!newPassword) return res.status(400).json({error:'旧密码和新密码必填'});
  if (newPassword.length < 4) return res.status(400).json({error:'新密码至少4位'});

  const usersData = await loadUsers();
  const user = usersData.users.find(u => u.username === req.sessionUser);
  if (!user) return res.status(404).json({error:'用户不存在'});
  if (user.password !== oldPassword) return res.status(403).json({error:'旧密码错误'});

  user.password = newPassword;
  await saveUsersSync(usersData);
  res.json({ success:true, message:'密码修改成功' });
});

// 前端页面路由
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/candidate',(req,res)=>res.sendFile(path.join(__dirname,'public','candidate.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🎯 面试预约系统启动！端口:${PORT}`);
});
